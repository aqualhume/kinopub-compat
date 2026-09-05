import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const UPSTREAM = 'https://kino.watch';
const relaySecret = randomBytes(32);
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

export function rewriteManifest(text, base, legacy = false, quality = null) {
  let lines = text.split(/\r?\n/);
  if (legacy) {
    const compatible = lines.filter(l => l.startsWith('#EXT-X-STREAM-INF:') && /CODECS="[^"]*avc1\./.test(l) && !/VIDEO-RANGE=(HDR|PQ|HLG)/.test(l));
    if (compatible.length) {
      lines = lines.filter((line, index, all) => {
        if (line.startsWith('#EXT-X-STREAM-INF:')) return compatible.includes(line);
        if (index && all[index - 1].startsWith('#EXT-X-STREAM-INF:')) return compatible.includes(all[index - 1]);
        return true;
      });
    }
  }
  if (quality && /^\d+$/.test(quality)) {
    const selected = lines.filter(l => l.startsWith('#EXT-X-STREAM-INF:') && new RegExp('(?:^|,)BANDWIDTH=' + quality + '(?:,|$)').test(l.slice(18)));
    if (selected.length) lines = lines.filter((line, index, all) => {
      if (line.startsWith('#EXT-X-STREAM-INF:')) return selected.includes(line);
      if (index && all[index - 1].startsWith('#EXT-X-STREAM-INF:')) return selected.includes(all[index - 1]);
      return true;
    });
  }
  return lines.map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return mediaURL(line.trim(), base);
    return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${mediaURL(uri, base)}"`);
  }).join('\n');
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
