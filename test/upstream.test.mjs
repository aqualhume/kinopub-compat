import test from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../server.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const deadline = () => AbortSignal.timeout(3000);

async function fixture(t, handler, options = {}) {
  const sessions = new Set(), connections = [];
  const upstream = http2.createServer();
  upstream.on('session', session => {
    sessions.add(session); connections.push(session);
    session.on('error', () => {}); session.on('close', () => sessions.delete(session));
  });
  upstream.on('stream', (stream, headers) => { stream.on('error', () => {}); handler(stream, headers, connections); });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ http2Connect: () => http2.connect(upstreamOrigin), ...options });
  const origin = await listen(server);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    for (const session of sessions) session.destroy();
    await new Promise(resolve => upstream.close(resolve));
  });
  return { origin, connections };
}

function ok(stream, body = 'ok') { stream.respond({ ':status': 200, 'content-type': 'text/plain' }); stream.end(body); }

test('HTTP/2 retains account cookies when a local cookie appears first', { timeout: 5000 }, async t => {
  let received;
  const { origin } = await fixture(t, (stream, headers) => { received = headers.cookie; stream.resume(); ok(stream); });
  for (const cookie of ['kw_compat=1; PHPSESSID=session; _csrf=account', 'unrelated=value; PHPSESSID=session; _csrf=account', 'PHPSESSID=session; _csrf=account; kw_compat=1']) {
    const response = await fetch(origin + '/item/media-marktime', { method: 'POST', headers: { cookie }, body: 'media_id=1&time=123', signal: deadline() });
    await response.text();
    assert.equal(received, 'PHPSESSID=session; _csrf=account', 'filtering local cookies must not leave invalid leading whitespace');
  }
});

test('real HTTP/2 requests multiplex, expire when idle, and reconnect', { timeout: 5000 }, async t => {
  const { origin, connections } = await fixture(t, stream => ok(stream), { idleTimeoutMs: 80 });
  const responses = await Promise.all(['/one', '/two', '/three'].map(path => fetch(origin + path, { signal: deadline() }).then(r => r.text())));
  assert.deepEqual(responses, ['ok', 'ok', 'ok']);
  assert.equal(connections.length, 1);
  await once(connections[0], 'close', { signal: deadline() });
  assert.equal(await (await fetch(origin + '/after-sleep', { signal: deadline() })).text(), 'ok');
  assert.equal(connections.length, 2);
});

test('a header deadline replaces a stuck session even while another stream is active', { timeout: 5000 }, async t => {
  let busy, ticks;
  t.after(() => clearInterval(ticks));
  const { origin, connections } = await fixture(t, (stream, headers, sessions) => {
    if (headers[':path'] === '/busy') {
      busy = stream;
      stream.respond({ ':status': 200, 'content-type': 'application/octet-stream' });
      ticks = setInterval(() => stream.write('x'), 5);
    } else if (sessions.length > 1) ok(stream);
    // The first session accepts /stuck but never returns response headers.
  }, { headersTimeoutMs: 80, bodyTimeoutMs: 1000 });
  const active = await fetch(origin + '/busy', { signal: deadline() });
  const activeBody = active.text();
  assert.equal(await (await fetch(origin + '/stuck', { signal: deadline() })).text(), 'ok');
  assert.equal(connections.length, 2);
  assert.equal(busy.destroyed, false, 'retiring a session must preserve its other streams');
  clearInterval(ticks); busy.end('done');
  assert.match(await activeBody, /^x+done$/);
});

test('a POST timeout is reported once and is never replayed', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let writes = 0;
  const { origin, connections } = await fixture(t, (stream, headers) => {
    if (headers[':method'] === 'POST') { writes++; stream.resume(); } else ok(stream);
  }, { headersTimeoutMs: 60 });
  const response = await fetch(origin + '/save?token=secret', { method: 'POST', body: 'private-data', signal: deadline() });
  assert.equal(response.status, 502); await response.text();
  assert.equal(writes, 1);
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments.join(' '), /ERR_UPSTREAM_HEADERS_TIMEOUT.*site, headers, attempt 1/);
  assert.doesNotMatch(logs.mock.calls[0].arguments.join(' '), /secret|private-data|\/save/);
  assert.equal(await (await fetch(origin + '/next', { signal: deadline() })).text(), 'ok');
  assert.equal(connections.length, 2);
});

test('retrying a failed GET is bounded to two attempts', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  const { origin, connections } = await fixture(t, stream => stream.close(http2.constants.NGHTTP2_REFUSED_STREAM));
  const response = await fetch(origin + '/unavailable', { signal: deadline() });
  assert.equal(response.status, 502); await response.text();
  assert.equal(connections.length, 2);
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments.join(' '), /ERR_HTTP2_STREAM_ERROR.*attempt 2/);
});

test('GOAWAY drains an active response and new requests use a new session', { timeout: 5000 }, async t => {
  let active;
  const { origin, connections } = await fixture(t, (stream, headers) => {
    if (headers[':path'] === '/active') {
      active = stream; stream.respond({ ':status': 200 }); stream.write('first');
    } else ok(stream);
  });
  const response = await fetch(origin + '/active', { signal: deadline() });
  const body = response.text();
  connections[0].goaway();
  // A round trip of GOAWAY confirms the proxy has begun graceful retirement.
  await once(connections[0], 'goaway', { signal: deadline() });
  assert.equal(await (await fetch(origin + '/next', { signal: deadline() })).text(), 'ok');
  assert.equal(connections.length, 2);
  active.end('last'); assert.equal(await body, 'firstlast');
});

test('disconnecting during a buffered HTTP/2 document cancels quietly and frees the stream', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let accepted;
  const started = new Promise(resolve => { accepted = resolve; });
  const { origin, connections } = await fixture(t, (stream, headers) => {
    if (headers[':path'] === '/document') {
      stream.respond({ ':status': 200, 'content-type': 'text/html' }); stream.write('<html>'); accepted(stream);
    } else ok(stream);
  });
  const client = http.get(origin + '/document'); client.on('error', () => {});
  const stream = await started;
  const closed = once(stream, 'close', { signal: deadline() });
  client.destroy(); await closed;
  assert.equal(await (await fetch(origin + '/next', { signal: deadline() })).text(), 'ok');
  assert.equal(connections.length, 1, 'client cancellation must not retire a healthy shared session');
  assert.equal(logs.mock.callCount(), 0);
});

test('a stalled response body times out without retrying or keeping success headers', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let requests = 0;
  const { origin } = await fixture(t, stream => {
    requests++;
    stream.respond({ ':status': 200, 'content-type': 'text/html', 'content-length': '9999', etag: '"success"', 'content-encoding': 'gzip' });
    stream.write('partial');
  }, { bodyTimeoutMs: 60 });
  const response = await fetch(origin + '/stalled', { signal: deadline() });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-encoding'), null);
  assert.equal(response.headers.get('etag'), null);
  assert.match(await response.text(), /Нет соединения/);
  assert.equal(requests, 1);
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments.join(' '), /ERR_UPSTREAM_BODY_TIMEOUT.*body/);
});

test('a truncated media transfer is logged once and never retried after headers', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let active, requests = 0;
  const { origin } = await fixture(t, stream => {
    requests++; active = stream;
    stream.respond({ ':status': 200, 'content-type': 'video/mp4', 'content-length': '100' }); stream.write('partial');
  });
  const response = await fetch(origin + '/video', { signal: deadline() });
  const body = response.arrayBuffer();
  active.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
  await assert.rejects(body);
  assert.equal(requests, 1);
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments.join(' '), /body/);
});

test('a fully uploaded progress save finishes if the sleeping device disconnects', { timeout: 5000 }, async t => {
  const logs = t.mock.method(console, 'error', () => {});
  let received, committed, writes = 0;
  const uploaded = new Promise(resolve => { received = resolve; });
  const saved = new Promise(resolve => { committed = resolve; });
  const { origin } = await fixture(t, stream => {
    writes++;
    stream.on('end', () => {
      received();
      setTimeout(() => {
        const completed = !stream.destroyed;
        if (completed) ok(stream, '{"success":true}');
        committed(completed);
      }, 60);
    });
    stream.resume();
  });
  const request = http.request(origin + '/item/media-marktime', { method: 'POST', agent: false });
  request.on('error', () => {}); request.end('media_id=1&time=123');
  await uploaded;
  request.destroy();
  assert.equal(await saved, true, 'closing the client must not cancel an already-uploaded progress write');
  assert.equal(writes, 1, 'the proxy must not replay account writes');
  assert.equal((await fetch(origin + '/__local/health', { signal: deadline() })).status, 200);
  assert.equal(logs.mock.callCount(), 0);
});

test('an incomplete progress upload is still cancelled when the client disconnects', { timeout: 5000 }, async t => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  const { origin } = await fixture(t, stream => { stream.once('data', () => received(stream)); stream.resume(); });
  const request = http.request(origin + '/item/media-marktime', { method: 'POST', headers: { 'content-length': '100' }, agent: false });
  request.on('error', () => {}); request.write('media_id=1');
  const stream = await started;
  // A truncated Content-Length can produce PROTOCOL_ERROR before close.
  const closed = new Promise(resolve => stream.once('close', resolve));
  request.destroy(); await closed;
  assert.notEqual(stream.rstCode, 0, 'the partial upload must be reset, not completed');
});
