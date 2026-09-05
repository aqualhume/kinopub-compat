import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { transform } from 'esbuild';
import { UPSTREAM, isLegacy, localize, rewriteCookie, rewriteHTML, rewriteManifest, resolveMedia } from './lib/transform.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
// Old iPads open many parallel connections; a wider pool avoids head-of-line
// stalls while requests for a single page fan out to the service.
const transport = new https.Agent({ keepAlive: true, keepAliveMsecs: 30000, maxSockets: 128, maxFreeSockets: 32, scheduling: 'lifo' });
const hopHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const javascriptCache = new Map();
const serviceCookieNames = new Set(['PHPSESSID', '_identity', '_csrf', 'token']);
const files = {
  '/__local/compat.js': ['public/compat.js', 'application/javascript'],
  '/__local/compat-player.js': ['public/compat-player.js', 'application/javascript'],
  '/__local/compat-player.css': ['public/compat-player.css', 'text/css'],
  '/__local/hls.js': ['node_modules/hls.js/dist/hls.min.js', 'application/javascript']
};
// Local assets never change while the server runs, so they are read from disk
// once and kept ready in both plain and compressed form.
const assetCache = new Map();
// Compressing costs about 0.03ms on a small document and repays that many times
// over in saved bytes, so the floor only skips bodies too short to benefit from
// a smaller packet at all.
const MIN_COMPRESS = 1024;

async function localAsset(pathname) {
  let asset = assetCache.get(pathname);
  if (asset) return asset;
  const [path, type] = files[pathname];
  const bytes = await readFile(root + path);
  asset = { type, bytes, etag: '"' + createHash('sha1').update(bytes).digest('base64url') + '"' };
  if (bytes.length >= MIN_COMPRESS) {
    asset.gzip = zlib.gzipSync(bytes, { level: 6 });
    asset.br = zlib.brotliCompressSync(bytes, { params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bytes.length
    } });
  }
  assetCache.set(pathname, asset);
  return asset;
}

// Picks an encoding the client advertised. Brotli is preferred when offered
// because it is smaller, but Safari sends only "gzip, deflate" over plain HTTP,
// so the gzip branch is the one an iPad on this server actually takes.
function negotiate(accept = '', asset) {
  if (!asset.gzip) return null;
  if (/\bbr\b/.test(accept)) return { encoding: 'br', body: asset.br };
  if (/\bgzip\b/.test(accept)) return { encoding: 'gzip', body: asset.gzip };
  return null;
}

function compressBody(accept = '', buffer) {
  if (buffer.length < MIN_COMPRESS) return null;
  if (/\bbr\b/.test(accept)) return { encoding: 'br', body: zlib.brotliCompressSync(buffer, { params: {
    [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
    [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buffer.length
  } }) };
  if (/\bgzip\b/.test(accept)) return { encoding: 'gzip', body: zlib.gzipSync(buffer, { level: 5 }) };
  if (/\bdeflate\b/.test(accept)) return { encoding: 'deflate', body: zlib.deflateSync(buffer, { level: 5 }) };
  return null;
}

// Upstream is asked for compressed bytes; rewriting needs plain text, so the
// body is expanded here instead of on the slow link to the device.
function decompress(buffer, encoding = '') {
  if (!buffer.length) return buffer;
  switch (encoding.trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buffer);
    case 'br': return zlib.brotliDecompressSync(buffer);
    case 'deflate': return zlib.inflateSync(buffer);
    default: return buffer;
  }
}

export function createServer({ upstreamRequest = https.request } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const local = new URL(req.url, 'http://local.invalid');
      if (local.pathname === '/__local/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM, nativePlayer: true }));
      }
      if (files[local.pathname]) {
        const asset = await localAsset(local.pathname);
        // A revalidated asset costs one small 304 instead of resending hls.js.
        if (req.headers['if-none-match'] === asset.etag) {
          res.writeHead(304, { etag: asset.etag, 'cache-control': 'no-cache' });
          return res.end();
        }
        const headers = {
          'content-type': asset.type,
          'cache-control': 'no-cache',
          etag: asset.etag,
          vary: 'Accept-Encoding',
          'x-content-type-options': 'nosniff'
        };
        const chosen = negotiate(req.headers['accept-encoding'], asset);
        const body = chosen ? chosen.body : asset.bytes;
        if (chosen) headers['content-encoding'] = chosen.encoding;
        headers['content-length'] = String(body.length);
        res.writeHead(200, headers);
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      if (local.pathname.startsWith('/__local/') && !local.pathname.startsWith('/__local/media/')) {
        res.writeHead(404); return res.end('Not found');
      }
      const relay = local.pathname.startsWith('/__local/media/');
      let target;
      try { target = relay ? resolveMedia(local.pathname) : new URL(local.pathname + local.search, UPSTREAM); }
      catch { res.writeHead(403); return res.end('Invalid media link. Reload the title page.'); }
      // Never let an incoming //host path change the upstream destination.
      if (!relay && target.origin !== UPSTREAM) { res.writeHead(400); return res.end('Invalid path'); }
      const compatQuery = !relay ? target.searchParams.get('compat') : null;
      const quality = !relay ? target.searchParams.get('__quality') : null;
      if (!relay) target.searchParams.delete('compat');
      if (!relay) target.searchParams.delete('__quality');
      const legacy = compatQuery === '1' || (compatQuery !== '0' && (/\bkw_compat=1\b/.test(req.headers.cookie || '') || isLegacy(req.headers['user-agent'])));
      if (compatQuery !== null) res.setHeader('set-cookie', `kw_compat=${compatQuery === '1' ? '1' : '0'}; Path=/; SameSite=Lax`);

      const headers = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (!hopHeaders.has(key) && !['host','accept-encoding','origin','referer','cookie','authorization'].includes(key)) headers[key] = value;
      }
      headers.host = target.host;
      // Media is relayed byte-for-byte, so its encoding is passed through
      // untouched. Documents are fetched compressed to cut upstream transfer
      // time, then expanded locally for rewriting.
      headers['accept-encoding'] = relay ? (req.headers['accept-encoding'] || 'identity') : 'gzip, deflate, br';
      headers.referer = UPSTREAM + '/';
      // Restore the original validator so the service can still answer with a
      // 304 for a body this proxy had compiled.
      if (headers['if-none-match']) headers['if-none-match'] = String(headers['if-none-match']).replace(/"c12~/g, '"');
      if (target.origin === UPSTREAM) {
        if (req.headers.cookie) headers.cookie = req.headers.cookie.split(';').filter(c => {
          const name = c.trim().split('=')[0];
          return serviceCookieNames.has(name) || name.endsWith('-filter');
        }).join(';');
        if (req.headers.origin) headers.origin = UPSTREAM;
        if (req.headers.referer) {
          try { const ref = new URL(req.headers.referer); headers.referer = UPSTREAM + ref.pathname + ref.search; } catch {}
        }
      }
      // A browser cannot drive account mutations through a different website.
      if (!['GET','HEAD','OPTIONS'].includes(req.method) && req.headers.origin) {
        let sameOrigin = false;
        try { sameOrigin = new URL(req.headers.origin).host === req.headers.host; } catch {}
        if (!sameOrigin) { res.writeHead(403); return res.end('Origin rejected'); }
      }
      await new Promise((resolve) => {
        const upstream = upstreamRequest(target, { method: req.method, headers, agent: transport }, async response => {
          try {
            const type = response.headers['content-type'] || '';
            const manifest = /mpegurl/i.test(type) || /\.m3u8(?:$|\?)/i.test(target.href);
            const html = /text\/html/i.test(type);
            const script = /(?:javascript|ecmascript)/i.test(type);
            const style = /text\/css/i.test(type);
            // A partial response is a fragment of a larger file. Rewriting or
            // recompressing one would corrupt it, so it is always relayed as-is.
            const partial = response.statusCode === 206 || response.headers['content-range'] !== undefined;
            const textual = !partial && (html || script || style || /application\/json/i.test(type) || manifest);
            // Scripts and stylesheets rewrite deterministically, so their
            // validators stay usable and repeat visits can answer with a 304
            // instead of resending and recompiling the whole file.
            const keepValidators = textual && (script || style) && !manifest;
            for (const [key, value] of Object.entries(response.headers)) {
              if (hopHeaders.has(key) || ['set-cookie','content-length','content-encoding','strict-transport-security','content-security-policy','content-security-policy-report-only','access-control-allow-origin'].includes(key)) continue;
              if (textual && key === 'content-md5') continue;
              if (textual && !keepValidators && ['etag','last-modified'].includes(key)) continue;
              if (key === 'location') res.setHeader(key, localize(String(value)));
              else if (value !== undefined) res.setHeader(key, value);
            }
            // The signed manifest service generates its own anonymous CSRF
            // cookie. Applying that cookie would invalidate the account page's
            // token and break bookmarks and other subsequent form submissions.
            const accountResponse = !relay && !target.pathname.startsWith('/manifest/');
            if (accountResponse && target.origin === UPSTREAM && response.headers['set-cookie']) {
              for (const cookie of response.headers['set-cookie']) serviceCookieNames.add(cookie.split('=')[0]);
              res.setHeader('set-cookie', [...(res.getHeader('set-cookie') ? [res.getHeader('set-cookie')] : []), ...response.headers['set-cookie'].map(c => rewriteCookie(c, false))]);
            }
            if (html || /json/i.test(type) || manifest) res.setHeader('cache-control', 'private, no-store');
            // Only account documents differ per session. Listing Cookie on
            // scripts and stylesheets would stop a browser from reusing them,
            // forcing a full re-download of the site's assets on every page.
            if (keepValidators) res.setHeader('vary', 'User-Agent, Accept-Encoding');
            else if (textual) res.setHeader('vary', 'User-Agent, Cookie, Accept-Encoding');
            // A compiled body differs from the upstream bytes, so its validator
            // is marked to prevent a cache from mixing the two variants when the
            // compatibility mode is toggled in the same browser.
            if (keepValidators && legacy && script) {
              const tag = res.getHeader('etag');
              if (tag) res.setHeader('etag', String(tag).replace(/^(W\/)?"/, '$1"c12~'));
            }
            res.statusCode = response.statusCode;
            // A revalidated or empty response carries no body to rewrite.
            if (req.method === 'HEAD' || response.statusCode === 304 || response.statusCode === 204) {
              response.resume(); res.end(); resolve(); return;
            }
            if (!textual) {
              if (response.headers['content-length']) res.setHeader('content-length', response.headers['content-length']);
              if (response.headers['content-encoding']) res.setHeader('content-encoding', response.headers['content-encoding']);
              await pipeline(response, res);
            } else {
              const chunks = []; let size = 0;
              for await (const chunk of response) {
                size += chunk.length;
                if (size > 24 * 1024 * 1024) throw new Error('Upstream document too large');
                chunks.push(chunk);
              }
              let body = decompress(Buffer.concat(chunks), response.headers['content-encoding']).toString('utf8');
              if (manifest) body = rewriteManifest(body, target.href, legacy, quality);
              else if (html) {
                body = rewriteHTML(body, legacy);
                if (legacy) body = await compileInline(body);
              } else {
                body = localize(body);
                if (script && legacy) {
                  try { body = await compile(body, true); } catch { /* Serve the original on unparsable input. */ }
                }
              }
              // Compressing here shrinks the slow hop to the device, which
              // dominates page time far more than the rewriting itself.
              const buffer = Buffer.from(body, 'utf8');
              const encoded = compressBody(req.headers['accept-encoding'], buffer);
              if (encoded) res.setHeader('content-encoding', encoded.encoding);
              const out = encoded ? encoded.body : buffer;
              res.setHeader('content-length', String(out.length));
              res.end(out);
            }
          } catch (error) { fail(res, error); }
          finally { resolve(); }
        });
        upstream.setTimeout(45000, () => upstream.destroy(new Error('Upstream timeout')));
        upstream.on('error', error => { fail(res, error); resolve(); });
        res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
        req.pipe(upstream);
      });
    } catch (error) { fail(res, error); }
  });
}

// Compiling to Safari 12 syntax is the most expensive step on legacy pages.
// Results are keyed by content hash so identical code is only ever compiled
// once, no matter which page or path it arrived on.
async function compile(source, minify) {
  const key = (minify ? 'm:' : 'i:') + createHash('sha1').update(source).digest('base64url');
  const hit = javascriptCache.get(key);
  if (hit !== undefined) {
    // Refresh recency so hot page scripts survive eviction.
    javascriptCache.delete(key); javascriptCache.set(key, hit);
    return hit;
  }
  const { code } = await transform(source, { target: 'safari12', loader: 'js', minify });
  if (javascriptCache.size >= 400) javascriptCache.delete(javascriptCache.keys().next().value);
  javascriptCache.set(key, code);
  return code;
}

// Inline scripts are compiled concurrently and the document is rebuilt in a
// single pass, avoiding repeated whole-document string replacement.
async function compileInline(body) {
  const matches = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  if (!matches.length) return body;
  const compiled = await Promise.all(matches.map(match => {
    if (/\bsrc\s*=|type=["']application\//i.test(match[1]) || !match[2].trim()) return null;
    // Preserve upstream non-JavaScript template blocks.
    return compile(match[2], false).catch(() => null);
  }));
  let out = '', last = 0;
  for (let i = 0; i < matches.length; i++) {
    const code = compiled[i];
    if (code == null) continue;
    const match = matches[i];
    out += body.slice(last, match.index) + `<script${match[1]}>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
    last = match.index + match[0].length;
  }
  return last ? out + body.slice(last) : body;
}

function fail(res, error) {
  if (res.destroyed) return;
  if (res.headersSent) { res.destroy(); return; }
  // Do not log request URLs, credentials, signed manifests, or response bodies.
  console.error('Upstream request failed:', error.code || error.name || 'Error');
  res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width"><title>Нет соединения</title><body style="background:#1c202b;color:#ddd;font:18px sans-serif;padding:32px"><h1>Нет соединения с Кинопаб</h1><p>Проверьте подключение к интернету и повторите попытку.</p><button onclick="location.reload()">Повторить</button></body></html>');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Kino Watch: http://127.0.0.1:${port}`);
    if (host === '0.0.0.0') {
      for (const addresses of Object.values(networkInterfaces())) {
        for (const address of addresses || []) {
          if (address.family === 'IPv4' && !address.internal) console.log(`Local network: http://${address.address}:${port}`);
        }
      }
    } else if (host !== '127.0.0.1') console.log(`Listening: http://${host}:${port}`);
  });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(); transport.destroy(); });
}
