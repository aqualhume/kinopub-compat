import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../server.mjs';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('manifest responses cannot overwrite the CSRF cookie used by later account writes', async () => {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/manifest/hls4/test') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'set-cookie': '_csrf=unrelated-media-token; Path=/; HttpOnly' });
      res.end('#EXTM3U\n#EXTINF:6,\nhttps://cdn.example.test/segment.ts\n');
    } else if (req.url === '/favorites/change') {
      const valid = req.headers.cookie.includes('_csrf=account-token') && req.headers['x-csrf-token'] === 'masked-account-token';
      res.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: valid }));
    } else {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': '_csrf=account-token; Domain=kino.watch; Path=/; Secure; HttpOnly; SameSite=Lax' });
      res.end('<html><head></head><body><a href="https://kino.watch/movie">Фильмы</a></body></html>');
    }
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname + target.search, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  try {
    const page = await fetch(origin);
    const cookie = page.headers.getSetCookie()[0];
    assert.equal(cookie, '_csrf=account-token; Path=/; HttpOnly; SameSite=Lax');
    assert.ok((await page.text()).includes('href="/movie"'));
    const manifest = await fetch(origin + '/manifest/hls4/test', { headers: { cookie: '_csrf=account-token' } });
    assert.deepEqual(manifest.headers.getSetCookie(), []);
    assert.match(await manifest.text(), /\/__local\/media\//);
    const bookmark = await fetch(origin + '/favorites/change', { method: 'POST', headers: {
      origin, referer: origin + '/item/view/1', cookie: '_csrf=account-token; kw_compat=1; unrelated-app-session=private',
      'x-csrf-token': 'masked-account-token', 'content-type': 'application/x-www-form-urlencoded'
    }, body: 'id=3&item_id=1' });
    assert.equal(bookmark.status, 200);
    assert.equal((await bookmark.json()).success, true);
    const request = requests.find(r => r.path === '/favorites/change');
    assert.equal(request.body, 'id=3&item_id=1');
    assert.equal(request.headers.origin, 'https://kino.watch');
    assert.equal(request.headers.referer, 'https://kino.watch/item/view/1');
    assert.ok(!request.headers.cookie.includes('kw_compat'));
    assert.ok(!request.headers.cookie.includes('unrelated-app-session'));
    const crossSite = await fetch(origin + '/favorites/change', { method: 'POST', headers: { origin: 'https://unrelated.example' }, body: 'id=3' });
    assert.equal(crossSite.status, 403);
    assert.equal(requests.filter(r => r.path === '/favorites/change').length, 1);
  } finally { await close(server); await close(upstream); }
});

test('video byte ranges and partial responses remain streamable', async () => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.headers.range, 'bytes=2-5');
    res.writeHead(206, { 'content-type': 'video/mp4', 'content-range': 'bytes 2-5/10', 'accept-ranges': 'bytes', 'content-length': '4' });
    res.end('2345');
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  try {
    const response = await fetch(origin + '/sample.mp4', { headers: { range: 'bytes=2-5' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(response.headers.get('content-length'), '4');
    assert.equal(await response.text(), '2345');
  } finally { await close(server); await close(upstream); }
});
