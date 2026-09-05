import { createHmac, createSecretKey, randomBytes, timingSafeEqual } from 'node:crypto';

export const UPSTREAM = 'https://kino.watch';
// A prepared key object skips re-deriving the HMAC key on every segment, which
// matters because a long playlist signs thousands of URLs per request.
const relaySecret = createSecretKey(randomBytes(32));
export function isLegacy(userAgent = '') {
  const ios = /(?:CPU (?:iPhone )?OS|iPhone OS) (\d+)[_\.]/.exec(userAgent);
  return Boolean(ios && Number(ios[1]) <= 12);
}

export function localize(text) {
  return text.replace(/https?:\/\/kino\.watch(?=[/"'\s<]|$)/g, '')
    .replace(/https?:\\\/\\\/kino\.watch(?=\\\/|["'])/g, '');
}

export function rewriteCookie(cookie, secure = false) {
  let result = cookie.replace(/;\s*Domain=[^;]+/ig, '');
  if (!secure) result = result.replace(/;\s*Secure\b/ig, '').replace(/SameSite=None/ig, 'SameSite=Lax');
  return result;
}

export function mediaURL(value, base = UPSTREAM) {
  const url = new URL(value, base);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Unsupported media URL');
  // Only the service itself can mint signed relay URLs; arbitrary URLs supplied
  // by a browser are never fetched. CDN links expire with their upstream tokens.
  const payload = Buffer.from(url.href).toString('base64url');
  const signature = createHmac('sha256', relaySecret).update(payload).digest('base64url');
  return `/__local/media/${signature}/${payload}`;
}

export function resolveMedia(pathname) {
  const parts = pathname.split('/');
  if (parts.length !== 5) throw new Error('Invalid media link');
  const [, , , signature, payload] = parts;
  const expected = createHmac('sha256', relaySecret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('Invalid media signature');
  return new URL(Buffer.from(payload, 'base64url').toString());
}

const STREAM_INF = '#EXT-X-STREAM-INF:';

// Keeps only the selected variant lines and the URI line that follows each one.
// A Set lookup avoids rescanning the variant list for every line of the file.
function keepVariants(lines, keep) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(STREAM_INF)) { if (keep.has(line)) out.push(line); continue; }
    if (i && lines[i - 1].startsWith(STREAM_INF) && !keep.has(lines[i - 1])) continue;
    out.push(line);
  }
  return out;
}

export function rewriteManifest(text, base, legacy = false, quality = null) {
  let lines = text.split(/\r?\n/);
  // Only a master playlist carries variants; segment playlists skip this work.
  if (lines.some(l => l.startsWith(STREAM_INF))) {
    if (legacy) {
      const compatible = new Set(lines.filter(l => l.startsWith(STREAM_INF) && /CODECS="[^"]*avc1\./.test(l) && !/VIDEO-RANGE=(HDR|PQ|HLG)/.test(l)));
      if (compatible.size) lines = keepVariants(lines, compatible);
    }
    if (quality && /^\d+$/.test(quality)) {
      const wanted = new RegExp('(?:^|,)BANDWIDTH=' + quality + '(?:,|$)');
      const selected = new Set(lines.filter(l => l.startsWith(STREAM_INF) && wanted.test(l.slice(18))));
      if (selected.size) lines = keepVariants(lines, selected);
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.charCodeAt(0) !== 35) {
      const trimmed = line.trim();
      if (trimmed) lines[i] = mediaURL(trimmed, base);
    } else if (line.includes('URI="')) {
      lines[i] = line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${mediaURL(uri, base)}"`);
    }
  }
  return lines.join('\n');
}

export function rewriteHTML(html, legacy) {
  let result = localize(html);
  if (legacy) {
    result = result.replace(/<script\b[^>]*src=["'][^"']*(?:\/shark\/|lucide|vjs\.zencdn\.net|gstatic\.com\/cast)[^"']*["'][^>]*>\s*<\/script>/gi, '')
      .replace(/<script\b[^>]*>\s*lucide\.createIcons\(\);?\s*<\/script>/gi, '');
    result = result.replace(/<head([^>]*)>/i, '<head$1><script src="/__local/compat.js"></script><link rel="stylesheet" href="/__local/compat-player.css">');
    result = result.replace(/<\/body>/i, '<script src="/__local/hls.js"></script><script src="/__local/compat-player.js"></script></body>');
  }
  return result;
}
