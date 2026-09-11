import http from 'node:http';

// Loopback-only access to the connected iPad's real Web Inspector.
// Observations stay in memory; request headers, credentials and media URLs are omitted.
const debugURL = process.env.IOS_DEBUG_URL || 'http://127.0.0.1:9232';
const port = Number(process.env.IOS_INSPECTOR_PORT || 9233);
const targets = await (await fetch(debugURL + '/json', { signal: AbortSignal.timeout(5000) })).json();
const target = targets.find(t => process.env.IOS_PAGE_ID
  ? t.webSocketDebuggerUrl && new URL(t.webSocketDebuggerUrl).pathname.split('/').pop() === process.env.IOS_PAGE_ID
  : /\/item\/view\//.test(t.url));
if (!target) throw new Error('Open the affected title on the iPad first');
const ws = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map(), requests = new Map(), events = [];
let id = 0;
function record(data) {
  events.push({ at: new Date().toISOString(), ...data });
  if (events.length > 1500) events.shift();
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const key = ++id;
    const timer = setTimeout(() => { pending.delete(key); reject(new Error(method + ' timed out')); }, 12000);
    pending.set(key, { resolve, reject, timer });
    ws.send(JSON.stringify({ id: key, method, params }));
  });
}
function observe() {
  if (window.__kwTraceHooked) return;
  window.__kwTraceHooked = true;
  var lastTime = -99, lastProgress = 0;
  function log(event) {
    var v = document.querySelector('#kw-video');
    if (!v) return;
    if (event.type === 'timeupdate' && Math.abs(v.currentTime - lastTime) < 5) return;
    if (event.type === 'progress' && Date.now() - lastProgress < 5000) return;
    if (event.type === 'timeupdate') lastTime = v.currentTime;
    if (event.type === 'progress') lastProgress = Date.now();
    var ranges = [];
    for (var i = 0; i < v.seekable.length; i++) ranges.push([v.seekable.start(i), v.seekable.end(i)]);
    console.log('__KINOPUB_TRACE__' + JSON.stringify({ event: event.type, time: v.currentTime, duration: v.duration,
      ready: v.readyState, paused: v.paused, seeking: v.seeking, hidden: document.hidden, error: v.error && v.error.code,
      seekable: ranges }));
  }
  ['loadedmetadata','durationchange','loadeddata','canplay','playing','timeupdate','progress','seeking','seeked','pause','error','ended','emptied'].forEach(function (name) {
    document.addEventListener(name, function (event) { if (event.target.id === 'kw-video') log(event); }, true);
  });
  document.addEventListener('visibilitychange', log);
  window.addEventListener('pagehide', log);
  log({ type: 'inspector-attached' });
}
const bootstrap = '(' + observe.toString() + ')()';
ws.addEventListener('message', async event => {
  const m = JSON.parse(event.data);
  if (m.id) {
    const p = pending.get(m.id);
    if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
    return;
  }
  const p = m.params || {};
  if (m.method === 'Console.messageAdded') {
    const text = p.message.text || '';
    if (text.startsWith('__KINOPUB_TRACE__')) {
      try { record({ kind: 'media', ...JSON.parse(text.slice('__KINOPUB_TRACE__'.length)) }); } catch {}
    } else if (/position could not|progress response|Save rejected/.test(text)) record({ kind: 'console', text });
  }
  if (m.method === 'Page.loadEventFired') {
    record({ kind: 'page', event: 'load' });
    send('Runtime.evaluate', { expression: bootstrap }).catch(() => {});
  }
  if (m.method === 'Network.requestWillBeSent') {
    const u = new URL(p.request.url);
    if (['/item/media-marktime','/item/update-watching','/item/playlist'].includes(u.pathname)) {
      const f = new URLSearchParams(p.request.postData || '');
      requests.set(p.requestId, u.pathname);
      record({ kind: 'request', requestId: p.requestId, path: u.pathname, method: p.request.method,
        media: f.get('media_id'), time: f.get('time'), completed: f.get('c') });
    }
  }
  if (m.method === 'Network.responseReceived' && requests.has(p.requestId)) {
    record({ kind: 'response', requestId: p.requestId, path: requests.get(p.requestId), status: p.response.status, type: p.response.mimeType });
  }
  if (m.method === 'Network.loadingFailed' && requests.has(p.requestId)) {
    record({ kind: 'failure', requestId: p.requestId, path: requests.get(p.requestId), error: p.errorText });
  }
  if (m.method === 'Network.loadingFinished' && requests.get(p.requestId) === '/item/media-marktime') {
    try {
      const r = await send('Network.getResponseBody', { requestId: p.requestId });
      const body = JSON.parse(r.body);
      record({ kind: 'acknowledgement', requestId: p.requestId, success: body.success });
    } catch { record({ kind: 'acknowledgement', requestId: p.requestId, validJSON: false }); }
  }
});
await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
for (const method of ['Runtime.enable','Console.enable','Network.enable','Page.enable']) await send(method);
try { await send('Page.addScriptToEvaluateOnLoad', { scriptSource: bootstrap }); }
catch { /* Page.loadEventFired attaches observation if this engine lacks bootstrap scripts. */ }
await send('Runtime.evaluate', { expression: bootstrap });
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let result;
    if (req.method === 'GET' && url.pathname === '/events') result = events.filter(e => !url.searchParams.has('after') || e.at > url.searchParams.get('after'));
    else if (req.method === 'POST' && url.pathname === '/eval') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { expression, userGesture = false } = JSON.parse(body);
      result = await send('Runtime.evaluate', { expression, returnByValue: true, emulateUserGesture: userGesture });
    } else if (req.method === 'POST' && url.pathname === '/command') {
      let body = ''; for await (const chunk of req) body += chunk;
      const { method, params } = JSON.parse(body);
      result = await send(method, params);
    } else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: error.message })); }
});
server.listen(port, '127.0.0.1', () => {
  const url = new URL(target.url);
  console.log(`Inspecting ${target.title}: ${url.origin}${url.pathname}`);
  console.log(`iPad inspector available at http://127.0.0.1:${port}`);
});
ws.addEventListener('close', () => { server.close(); process.exitCode = 1; });
