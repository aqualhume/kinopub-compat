import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';
import { createServer } from '../server.mjs';
import { mediaURL } from '../lib/transform.mjs';

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

test('documents are fetched and returned compressed without altering their content', async () => {
  const page = '<html><head></head><body>' + '<a href="https://kino.watch/movie">Фильмы</a>'.repeat(200) + '</body></html>';
  let requestedEncoding = null;
  const upstream = http.createServer((req, res) => {
    requestedEncoding = req.headers['accept-encoding'];
    // Mirror the service, which serves gzip when the client accepts it.
    const body = zlib.gzipSync(page);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip', 'content-length': String(body.length) });
    res.end(body);
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  try {
    const gzipped = await fetch(origin + '/movie', { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(gzipped.headers.get('content-encoding'), 'gzip');
    assert.match(gzipped.headers.get('vary'), /Accept-Encoding/);
    // The rewritten document must survive the compression round-trip intact.
    const text = await gzipped.text();
    assert.ok(text.includes('href="/movie"'));
    assert.ok(!text.includes('kino.watch'));
    assert.ok(/gzip/.test(requestedEncoding), 'upstream should be asked for compressed bytes');

    const brotli = await fetch(origin + '/movie', { headers: { 'accept-encoding': 'br' } });
    assert.equal(brotli.headers.get('content-encoding'), 'br');
    assert.ok((await brotli.text()).includes('href="/movie"'));

    // A client that cannot decompress still receives readable bytes.
    const plain = await fetch(origin + '/movie', { headers: { 'accept-encoding': 'identity' } });
    assert.equal(plain.headers.get('content-encoding'), null);
    assert.ok((await plain.text()).includes('href="/movie"'));
  } finally { await close(server); await close(upstream); }
});

test('local player assets compress and revalidate instead of resending every load', async () => {
  const server = createServer();
  const origin = await listen(server);
  try {
    const first = await fetch(origin + '/__local/hls.js', { headers: { 'accept-encoding': 'gzip' } });
    const etag = first.headers.get('etag');
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('content-encoding'), 'gzip');
    assert.ok(etag);
    // Compressed transfer must be far smaller than the decoded library.
    const wire = Number(first.headers.get('content-length'));
    const decoded = (await first.arrayBuffer()).byteLength;
    assert.ok(wire < decoded / 2, `expected compression, got ${wire} of ${decoded}`);
    assert.ok(decoded > 400000, 'hls.js should decode to its full size');

    const version = etag.slice(1, -1);
    const immutable = await fetch(origin + '/__local/hls.js?v=' + encodeURIComponent(version), { headers: { 'accept-encoding': 'gzip' } });
    assert.match(immutable.headers.get('cache-control'), /immutable/);
    await immutable.arrayBuffer();

    const revalidated = await fetch(origin + '/__local/hls.js', { headers: { 'if-none-match': etag, 'accept-encoding': 'gzip' } });
    assert.equal(revalidated.status, 304);
    assert.equal((await revalidated.arrayBuffer()).byteLength, 0);

    // A repeated read is served from memory and stays byte-identical.
    const again = await fetch(origin + '/__local/hls.js', { headers: { 'accept-encoding': 'identity' } });
    assert.equal(again.headers.get('etag'), etag);
    assert.equal((await again.arrayBuffer()).byteLength, decoded);
  } finally { await close(server); }
});

test('public scripts are shared from the proxy cache while legacy output stays separate', async () => {
  let requests = 0;
  let upstreamCookie;
  const upstream = http.createServer((req, res) => {
    requests++;
    upstreamCookie = req.headers.cookie;
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"asset-v1"' });
    res.end('const url = "https://kino.watch/movie"; const value = window.data?.value;');
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  const ios12 = 'Mozilla/5.0 (iPad; CPU OS 12_5_5 like Mac OS X) AppleWebKit/605.1.15 Version/12.1.2 Safari/604.1';
  try {
    const first = await fetch(origin + '/assets/site.js', { headers: { 'user-agent': 'Chrome/120', cookie: 'PHPSESSID=private' } });
    assert.match(first.headers.get('cache-control'), /max-age=300/);
    assert.ok((await first.text()).includes('?.'));
    assert.equal(upstreamCookie, undefined);
    const shared = await fetch(origin + '/assets/site.js', { headers: { 'user-agent': 'Chrome/121' } });
    const sharedText = await shared.text();
    assert.ok(sharedText.includes('"/movie"'));
    assert.ok(!sharedText.includes('kino.watch'));
    assert.equal(requests, 1);
    const revalidated = await fetch(origin + '/assets/site.js', { headers: { 'if-none-match': '"asset-v1"', 'cache-control': 'max-age=60' } });
    assert.equal(revalidated.status, 304);
    assert.equal(requests, 1);

    const legacy = await fetch(origin + '/assets/site.js', { headers: { 'user-agent': ios12 } });
    assert.ok(!(await legacy.text()).includes('?.'));
    assert.equal(requests, 2);
    await (await fetch(origin + '/assets/site.js', { headers: { 'user-agent': ios12 } })).arrayBuffer();
    assert.equal(requests, 2);
  } finally { await close(server); await close(upstream); }
});

test('script validators survive compilation so repeat visits revalidate', async () => {
  // Optional chaining is unsupported on Safari 12, so it must be rewritten.
  const source = 'const value = window.data?.items ?? [];';
  const received = [];
  const upstream = http.createServer((req, res) => {
    received.push(req.headers['if-none-match']);
    if (req.headers['if-none-match'] === '"source"') { res.writeHead(304, { etag: '"source"' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'application/javascript', etag: '"source"' });
    res.end(source);
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  const ios12 = 'Mozilla/5.0 (iPad; CPU OS 12_5_5 like Mac OS X) AppleWebKit/605.1.15 Version/12.1.2 Safari/604.1';
  try {
    const modern = await fetch(origin + '/app.js', { headers: { 'user-agent': 'Chrome/120' } });
    assert.equal(modern.headers.get('etag'), '"source"');
    assert.ok((await modern.text()).includes('?.'), 'modern browsers keep the original syntax');
    assert.equal((await fetch(origin + '/app.js', { headers: { 'user-agent': 'Chrome/120', 'if-none-match': '"source"' } })).status, 304);

    const legacy = await fetch(origin + '/app.js', { headers: { 'user-agent': ios12 } });
    const legacyTag = legacy.headers.get('etag');
    assert.ok(!(await legacy.text()).includes('?.'), 'legacy devices receive compiled syntax');
    // The compiled body must not share a validator with the original bytes.
    assert.notEqual(legacyTag, '"source"');

    const revalidated = await fetch(origin + '/app.js', { headers: { 'user-agent': ios12, 'if-none-match': legacyTag } });
    assert.equal(revalidated.status, 304);
    // The service only understands its own validator, so the marker is removed.
    assert.equal(received.at(-1), '"source"');
  } finally { await close(server); await close(upstream); }
});

test('a partial textual response is relayed as a fragment, not rewritten', async () => {
  // Safari asks for ranges of subtitle and playlist files; treating a fragment
  // as a whole document would corrupt it.
  const upstream = http.createServer((req, res) => {
    res.writeHead(206, { 'content-type': 'text/css', 'content-range': 'bytes 5-14/40', 'content-length': '10', 'accept-ranges': 'bytes' });
    res.end('kino.watch');
  });
  const upstreamOrigin = await listen(upstream);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(upstreamOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  try {
    const response = await fetch(origin + '/css/app.css', { headers: { range: 'bytes=5-14', 'accept-encoding': 'gzip, br' } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get('content-range'), 'bytes 5-14/40');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(await response.text(), 'kino.watch');
  } finally { await close(server); await close(upstream); }
});

test('relayed media keeps its bytes, ranges, and encoding untouched', async () => {
  const segment = Buffer.alloc(70000).map((_, index) => index % 251);
  let requestedEncoding = null;
  const cdn = http.createServer((req, res) => {
    requestedEncoding = req.headers['accept-encoding'];
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': String(segment.length), 'accept-ranges': 'bytes' });
    res.end(segment);
  });
  const cdnOrigin = await listen(cdn);
  const server = createServer({ upstreamRequest: (target, options, callback) => http.request(cdnOrigin + target.pathname, { ...options, agent: false }, callback) });
  const origin = await listen(server);
  try {
    const response = await fetch(origin + mediaURL('https://cdn.example.test/seg/1.ts'), { headers: { 'accept-encoding': 'gzip, br' } });
    assert.equal(response.headers.get('content-encoding'), null, 'video must not be recompressed');
    assert.equal(response.headers.get('content-length'), String(segment.length));
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(segment), 'segment bytes must be identical');
    assert.equal(requestedEncoding, 'gzip, br', 'the player preference is forwarded to the CDN');
  } finally { await close(server); await close(cdn); }
});
