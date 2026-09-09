import http2 from 'node:http2';
import https from 'node:https';
import { UPSTREAM } from './transform.mjs';

export function upstreamError(code) {
  return Object.assign(new Error(code), { code });
}

// Pools belong to one server, including sessions draining after GOAWAY. An idle
// connection must not survive indefinitely across device/network suspension.
export function createUpstreamTransport({ http2Connect = http2.connect, idleTimeoutMs = 30000 } = {}) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, scheduling: 'lifo', timeout: idleTimeoutMs });
  const sessions = new Map(), allSessions = new Set(), owners = new WeakMap();

  function retire(entry) {
    if (sessions.get(entry.origin) === entry) sessions.delete(entry.origin);
    clearTimeout(entry.idleTimer);
    if (entry.retired) return;
    entry.retired = true;
    // Let unrelated in-flight streams finish, but bound draining a dead peer.
    entry.drainTimer = setTimeout(() => entry.session.destroy(), 45000);
    entry.drainTimer.unref();
    entry.session.close();
  }

  function request(target, options, callback) {
    if (target.origin !== UPSTREAM) return https.request(target, { ...options, agent }, callback);
    let entry = sessions.get(target.origin);
    if (!entry || entry.session.closed || entry.session.destroyed) {
      const session = http2Connect(target.origin);
      entry = { session, origin: target.origin, active: 0 };
      sessions.set(target.origin, entry); allSessions.add(entry);
      const created = entry;
      session.on('goaway', () => retire(created));
      session.on('error', () => retire(created));
      session.on('close', () => {
        if (sessions.get(target.origin) === created) sessions.delete(target.origin);
        allSessions.delete(created);
        clearTimeout(created.idleTimer); clearTimeout(created.drainTimer);
      });
    }
    clearTimeout(entry.idleTimer);
    const headers = { ':method': options.method, ':scheme': target.protocol.slice(0, -1), ':authority': target.host, ':path': target.pathname + target.search };
    for (const [key, value] of Object.entries(options.headers || {})) {
      if (key !== 'host' && !key.startsWith(':')) headers[key] = value;
    }
    let stream;
    try { stream = entry.session.request(headers, { endStream: false }); }
    catch (error) { retire(entry); throw error; }
    owners.set(stream, entry); entry.active++;
    stream.once('close', () => {
      if (--entry.active === 0 && !entry.retired && !entry.session.destroyed) {
        entry.idleTimer = setTimeout(() => retire(entry), idleTimeoutMs);
        entry.idleTimer.unref();
      }
    });
    stream.once('response', incoming => {
      stream.headers = Object.fromEntries(Object.entries(incoming).filter(([key]) => !key.startsWith(':')));
      stream.statusCode = Number(incoming[':status']); stream.httpVersion = '2.0';
      callback(stream);
    });
    return stream;
  }

  return {
    request,
    invalidate(request) { const entry = owners.get(request); if (entry) retire(entry); },
    destroy() {
      agent.destroy();
      for (const entry of allSessions) {
        clearTimeout(entry.idleTimer); clearTimeout(entry.drainTimer); entry.session.destroy();
      }
      sessions.clear(); allSessions.clear();
    }
  };
}

const retryable = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_HTTP2_INVALID_SESSION', 'ERR_HTTP2_GOAWAY_SESSION', 'ERR_HTTP2_STREAM_ERROR', 'ERR_HTTP2_SESSION_ERROR', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_UPSTREAM_HEADERS_TIMEOUT']);

// A wall-clock header deadline also covers DNS, TLS, and queued HTTP/2 streams;
// a socket/stream inactivity timer alone does not bound those waits.
export function forwardUpstream(req, res, target, headers, { transport, upstreamRequest = transport.request, headersTimeoutMs = 15000, bodyTimeoutMs = 45000 }, onResponse, onError) {
  return new Promise(resolve => {
    let finished = false, attempts = 0, cancelAttempt = () => {};
    const canRetry = ['GET', 'HEAD'].includes(req.method) && !req.headers['transfer-encoding'] && !Number(req.headers['content-length']);
    const finishProgressSave = req.method === 'POST' && target.origin === UPSTREAM && target.pathname === '/item/media-marktime';
    function finish() {
      finished = true;
      req.off('aborted', cancel); res.off('close', clientClosed);
      resolve();
    }
    function cancel() { if (!finished) { finish(); cancelAttempt(); } }
    function clientClosed() {
      // Sleep can close the response socket after a beacon's entire body has
      // arrived. Finish that write once, within the normal upstream deadlines.
      if (finishProgressSave && req.complete && req.readableEnded) return;
      cancel();
    }
    req.once('aborted', cancel); res.once('close', clientClosed);
    // Aborted uploads can emit error after aborted/close; consume that late
    // notification as well as cancelling the upstream work.
    req.once('error', cancel); res.once('error', clientClosed);

    function attempt() {
      if (finished || res.destroyed || req.aborted) { cancel(); return; }
      attempts++;
      let upstream, response, timer, ended = false, phase = 'headers';
      function stop() {
        ended = true; clearTimeout(timer);
        if (upstream) { req.unpipe(upstream); upstream.setTimeout(0); }
      }
      cancelAttempt = () => {
        stop();
        // Explicitly reset HTTP/2 uploads rather than closing them with the
        // default NO_ERROR code, which can look like a normal end of input.
        if (typeof upstream?.close === 'function') upstream.close(http2.constants.NGHTTP2_CANCEL);
        else upstream?.destroy();
        response?.destroy();
      };
      function failed(error) {
        if (ended || finished) return;
        stop();
        if (phase === 'headers' || error.code === 'ERR_UPSTREAM_BODY_TIMEOUT') transport.invalidate(upstream);
        if (canRetry && attempts < 2 && phase === 'headers' && retryable.has(error.code) && !res.destroyed) {
          upstream?.destroy(); attempt(); return;
        }
        // Report before destroying streams: pipeline also destroys the client
        // response, which used to hide genuine mid-transfer failures entirely.
        onError(error, { phase, attempts, kind: target.origin === UPSTREAM ? 'site' : 'media' });
        finish(); response?.destroy(); upstream?.destroy();
      }
      try {
        upstream = upstreamRequest(target, { method: req.method, headers }, incoming => {
          if (ended || finished) { incoming.destroy(); return; }
          response = incoming; phase = 'body'; clearTimeout(timer);
          response.once('error', failed);
          response.once('aborted', () => failed(upstreamError('ERR_STREAM_PREMATURE_CLOSE')));
          Promise.resolve().then(async () => {
            if (ended || finished) return;
            if (res.destroyed && finishProgressSave) {
              // There is no downstream socket left to send the acknowledgement
              // to, but consuming it lets the upstream request finish cleanly.
              for await (const chunk of response) { /* discard */ }
            } else return onResponse(response);
          }).then(() => {
            if (!ended && !finished) { stop(); finish(); }
          }, failed);
        });
        upstream.on('error', failed);
        upstream.once('close', () => {
          if (!response) failed(upstreamError('ERR_STREAM_PREMATURE_CLOSE'));
        });
        timer = setTimeout(() => failed(upstreamError('ERR_UPSTREAM_HEADERS_TIMEOUT')), headersTimeoutMs);
        timer.unref();
        upstream.setTimeout(bodyTimeoutMs, () => failed(upstreamError(phase === 'headers' ? 'ERR_UPSTREAM_HEADERS_TIMEOUT' : 'ERR_UPSTREAM_BODY_TIMEOUT')));
        if (canRetry) { req.resume(); upstream.end(); } else req.pipe(upstream);
      } catch (error) { failed(error); }
    }
    attempt();
  });
}
