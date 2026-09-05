import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { transform } from 'esbuild';
import { UPSTREAM, isLegacy, localize, rewriteCookie, rewriteHTML, rewriteManifest, resolveMedia } from './lib/transform.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const transport = new https.Agent({ keepAlive: true, maxSockets: 32 });
const hopHeaders = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
const javascriptCache = new Map();
const serviceCookieNames = new Set(['PHPSESSID', '_identity', '_csrf', 'token']);
const files = {
  '/__local/compat.js': ['public/compat.js', 'application/javascript'],
  '/__local/compat-player.js': ['public/compat-player.js', 'application/javascript'],
  '/__local/compat-player.css': ['public/compat-player.css', 'text/css'],
  '/__local/hls.js': ['node_modules/hls.js/dist/hls.min.js', 'application/javascript']
};

export function createServer({ upstreamRequest = https.request } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const local = new URL(req.url, 'http://local.invalid');
      if (local.pathname === '/__local/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ status: 'ok', upstream: UPSTREAM, nativePlayer: true }));
      }
      if (files[local.pathname]) {
        const [path, type] = files[local.pathname];
        const bytes = await readFile(root + path);
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
        return res.end(req.method === 'HEAD' ? undefined : bytes);
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
      headers['accept-encoding'] = 'identity';
      headers.referer = UPSTREAM + '/';
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
            const textual = html || script || /(?:text\/css|application\/json)/i.test(type) || manifest;
            for (const [key, value] of Object.entries(response.headers)) {
              if (hopHeaders.has(key) || ['set-cookie','content-length','content-encoding','strict-transport-security','content-security-policy','content-security-policy-report-only','access-control-allow-origin'].includes(key)) continue;
              if (textual && ['etag','last-modified','content-md5'].includes(key)) continue;
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
            if (textual) res.setHeader('vary', 'User-Agent, Cookie');
            res.statusCode = response.statusCode;
            if (req.method === 'HEAD') { response.resume(); res.end(); resolve(); return; }
            if (!textual) {
              if (response.headers['content-length']) res.setHeader('content-length', response.headers['content-length']);
              await pipeline(response, res);
            } else {
              const chunks = []; let size = 0;
              for await (const chunk of response) {
                size += chunk.length;
                if (size > 24 * 1024 * 1024) throw new Error('Upstream document too large');
                chunks.push(chunk);
              }
              let body = Buffer.concat(chunks).toString('utf8');
              if (manifest) body = rewriteManifest(body, target.href, legacy, quality);
              else if (html) {
                body = rewriteHTML(body, legacy);
                if (legacy) {
                  const matches = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
                  for (const match of matches) {
                    if (/\bsrc\s*=|type=["']application\//i.test(match[1]) || !match[2].trim()) continue;
                    try { const out = await transform(match[2], { target: 'safari12', loader: 'js' }); body = body.replace(match[0], `<script${match[1]}>${out.code.replace(/<\/script/gi, '<\\/script')}</script>`); }
                    catch { /* Preserve upstream non-JavaScript template blocks. */ }
                  }
                }
              } else {
                body = localize(body);
                if (script && legacy) {
                  const cacheKey = target.pathname + ':' + body.length;
                  if (javascriptCache.has(cacheKey)) body = javascriptCache.get(cacheKey);
                  else {
                    try {
                      body = (await transform(body, { target: 'safari12', loader: 'js', minify: true })).code;
                      if (javascriptCache.size >= 50) javascriptCache.delete(javascriptCache.keys().next().value);
                      javascriptCache.set(cacheKey, body);
                    } catch {}
                  }
                }
              }
              res.end(body);
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
