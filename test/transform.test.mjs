import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'acorn';
import { isLegacy, localize, rewriteCookie, mediaURL, resolveMedia, rewriteManifest, rewriteHTML } from '../lib/transform.mjs';

test('iOS 12 is detected without classifying current iPads as legacy', () => {
  assert.equal(isLegacy('Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X)'), true);
  assert.equal(isLegacy('Mozilla/5.0 (iPhone; CPU iPhone OS 12_0 like Mac OS X)'), true);
  assert.equal(isLegacy('Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X)'), false);
  assert.equal(isLegacy('Mozilla/5.0 Chrome/130'), false);
});
test('login cookies preserve HttpOnly, expiry, and path on local HTTP', () => {
  assert.equal(rewriteCookie('session=abc; Domain=.kino.watch; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=100'), 'session=abc; Path=/; HttpOnly; SameSite=Lax; Max-Age=100');
  assert.equal(rewriteCookie('session=abc; Secure; HttpOnly', true), 'session=abc; Secure; HttpOnly');
});
test('only original origin links are localized, including escaped JSON', () => {
  assert.equal(localize('https://kino.watch/movie https://kino.watch.evil/ http://kino.watch/user/login'), '/movie https://kino.watch.evil/ /user/login');
  assert.equal(localize('https:\\/\\/kino.watch\\/item'), '\\/item');
});
test('media links are signed and arbitrary server-side requests are rejected', () => {
  const path = mediaURL('../video.ts?token=test', 'https://cdn.example.test/season/episode/index.m3u8');
  assert.equal(resolveMedia(path).href, 'https://cdn.example.test/season/video.ts?token=test');
  assert.throws(() => resolveMedia(path.replace(/.$/, 'x')));
  assert.throws(() => resolveMedia('/__local/media/invalid/' + Buffer.from('http://127.0.0.1').toString('base64url')));
  assert.throws(() => mediaURL('http://example.test/movie'));
  assert.throws(() => mediaURL('https://user:password@example.test/movie'));
});
const manifest = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio/list.m3u8"\n#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="s",URI="/sub/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,CODECS="hvc1.1",RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1920x1080,AUDIO="a",SUBTITLES="s"\n1080.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,CODECS="avc1.640028,mp4a.40.2",RESOLUTION=1280x720,AUDIO="a",SUBTITLES="s"\n720.m3u8\n';
test('native HLS preserves audio/subtitles and excludes unsupported codecs when AVC is available', () => {
  const result = rewriteManifest(manifest, 'https://cdn.example.test/path/master.m3u8', true);
  assert.ok(!result.includes('hvc1'));
  assert.ok(result.includes('TYPE=AUDIO'));
  assert.ok(result.includes('TYPE=SUBTITLES'));
  assert.equal((result.match(/#EXT-X-STREAM-INF/g) || []).length, 2);
  const urls = result.split('\n').filter(l => l.startsWith('/'));
  assert.equal(resolveMedia(urls[0]).href, 'https://cdn.example.test/path/1080.m3u8');
  assert.equal(resolveMedia(urls[1]).href, 'https://cdn.example.test/path/720.m3u8');
});
test('manual native quality keeps the master and alternate audio groups', () => {
  const result = rewriteManifest(manifest, 'https://cdn.example.test/master.m3u8', true, '1000000');
  assert.equal((result.match(/#EXT-X-STREAM-INF/g) || []).length, 1);
  assert.ok(result.includes('TYPE=AUDIO'));
  assert.equal(resolveMedia(result.split('\n').find(l => l.startsWith('/'))).pathname, '/720.m3u8');
});
test('media playlists rewrite segments, encryption keys, and init sections', () => {
  const result = rewriteManifest('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nseg.ts?token=one\n', 'https://cdn.example.test/path/list.m3u8');
  const urls = [...result.matchAll(/URI="([^"]+)"/g)].map(m => resolveMedia(m[1]).pathname);
  assert.deepEqual(urls, ['/path/key.bin','/path/init.mp4']);
  assert.equal(resolveMedia(result.split('\n').find(l => l.startsWith('/'))).search, '?token=one');
});
test('legacy player pages load only the compatibility assets needed by their playback path', () => {
  const html = '<html><head></head><body><div class="player-shell"></div><script>window.PLAYER_PLAYLIST=[];</script><script src="/shark/player.min.js"></script><script type="module" src="/shark/assets/vidstack-player.js"></script><script src="/libs/jquery.js"></script></body></html>';
  const versions = {
    '/__local/compat.js': 'compat-hash',
    '/__local/compat-player.css': 'css-hash',
    '/__local/compat-player.js': 'player-hash',
    '/__local/hls.js': 'hls-hash'
  };
  const result = rewriteHTML(html, true, { nativeHLS: true, assetVersions: versions });
  assert.ok(result.includes('window.PLAYER_PLAYLIST'));
  assert.ok(result.includes('/libs/jquery.js'));
  assert.ok(!result.includes('/shark/'));
  assert.ok(result.includes('/__local/compat.js?v=compat-hash'));
  assert.ok(result.includes('/__local/compat-player.css?v=css-hash'));
  assert.ok(result.includes('/__local/compat-player.js?v=player-hash'));
  assert.ok(!result.includes('/__local/hls.js'));
  assert.ok(rewriteHTML(html, true).includes('/__local/hls.js'));
  assert.equal(rewriteHTML(html, false), html);
});
test('legacy catalogue pages do not load player assets', () => {
  const result = rewriteHTML('<html><head></head><body><main>Catalog</main></body></html>', true);
  assert.ok(result.includes('/__local/compat.js'));
  assert.ok(!result.includes('compat-player'));
  assert.ok(!result.includes('hls.js'));
});
test('all locally authored browser JavaScript parses as ES5', async () => {
  for (const name of ['compat.js','compat-player.js']) {
    parse(await readFile(new URL('../public/' + name, import.meta.url), 'utf8'), { ecmaVersion: 5 });
  }
});
