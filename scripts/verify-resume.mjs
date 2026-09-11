// Repeatable playback test with generated HLS, a local HTTP/2 upstream, and a
// fresh browser profile. No account credentials or live service are needed.
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from '../server.mjs';
import { verifyProgress, verifyLegacyResume } from './verify-progress.mjs';

const browserName = process.env.TEST_BROWSER || 'webkit';
assert.ok(['webkit', 'chromium'].includes(browserName), 'TEST_BROWSER must be webkit or chromium');
const mediaDir = await mkdtemp(join(tmpdir(), 'kino-resume-'));
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
let upstream, server, browser;
const sessions = new Set(), requests = [], errors = [];
const saves = [];
let publishedPosition = 60, persistedPosition = 60, nextSaveResponse = null;
try {
  await promisify(execFile)(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '90', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '64k', '-hls_time', '2', '-hls_list_size', '0', '-hls_playlist_type', 'vod', join(mediaDir, 'index.m3u8')]);

  upstream = http2.createServer();
  upstream.on('session', session => { sessions.add(session); session.on('error', () => {}); session.on('close', () => sessions.delete(session)); });
  upstream.on('stream', async (stream, headers) => {
    stream.on('error', () => {});
    const path = new URL(headers[':path'], 'https://kino.watch').pathname;
    requests.push(path);
    try {
      let type, body;
      if (path === '/manifest/hls4/test') {
        type = 'application/vnd.apple.mpegurl';
        body = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=600000,RESOLUTION=320x180,CODECS="avc1.42c00d,mp4a.40.2"\nhttps://kino.watch/media/index.m3u8\n';
      } else if (/^\/media\/index(?:\d+\.ts|\.m3u8)$/.test(path)) {
        type = path.endsWith('.ts') ? 'video/mp2t' : 'application/vnd.apple.mpegurl';
        body = await readFile(join(mediaDir, path.slice('/media/'.length)));
      } else if (path.startsWith('/item/view/')) {
        type = 'text/html';
        const id = Number(/^\/item\/view\/(\d+)/.exec(path)[1]);
        body = '<!doctype html><html><head><meta charset="utf-8"><meta name="csrf-token" content="fixture-token"><meta name="csrf-param" content="_csrf"><title>Playback recovery test</title></head><body><div class="nav-avatar"><a href="/users/fixture">Account</a></div><div class="player-shell"></div>' +
          '<script>window.PLAYER_ITEM_ID=' + id + ';window.PLAYER_PLAYLIST=[{media_id:' + id + ',marktime:' + (id === 2 ? publishedPosition : (id === 4 ? 60 : 0)) + ',completed:' + (id === 3 ? 1 : 0) + ',title:"Recovery test",season:1,episode:1,duration:90,manifest:"/manifest/hls4/test"}];</script></body></html>';
      } else if (path === '/item/media-marktime') {
        let input = ''; for await (const chunk of stream) input += chunk;
        const fields = new URLSearchParams(input);
        const valid = headers[':method'] === 'POST' && fields.get('_csrf') === 'fixture-token' &&
          (headers.cookie || '').includes('PHPSESSID=fixture-session') && headers.origin === 'https://kino.watch';
        const rejectSave = nextSaveResponse === 'html' && Number(fields.get('time')) === 81;
        saves.push({ time: Number(fields.get('time')), media: Number(fields.get('media_id')), valid, accepted: valid && !rejectSave,
          hasSession: (headers.cookie || '').includes('PHPSESSID=fixture-session'), hasCsrf: fields.get('_csrf') === 'fixture-token', origin: headers.origin });
        if (!valid) { stream.respond({ ':status': 403 }); stream.end(); return; }
        type = rejectSave ? 'text/html' : 'application/json';
        body = rejectSave ? '<html>Sign in</html>' : '{"success":true}';
        if (!rejectSave && Number(fields.get('media_id')) === 2) persistedPosition = Number(fields.get('time'));
        if (rejectSave) nextSaveResponse = null;
      } else if (path === '/item/update-watching') {
        stream.resume(); type = 'application/json'; body = '{"success":true}';
      } else { stream.respond({ ':status': 404 }); stream.end(); return; }
      if (stream.destroyed) return;
      stream.respond({ ':status': 200, 'content-type': type, 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body),
        ...(path.startsWith('/item/view/') ? { 'set-cookie': ['PHPSESSID=fixture-session; Path=/; HttpOnly', '_csrf=fixture-token; Path=/; HttpOnly'] } : {}) }); stream.end(body);
    } catch (error) { if (!stream.destroyed) stream.destroy(error); }
  });
  const upstreamOrigin = await listen(upstream);
  server = createServer({ http2Connect: () => http2.connect(upstreamOrigin), idleTimeoutMs: 200, headersTimeoutMs: 1000, bodyTimeoutMs: 1500 });
  const origin = await listen(server);
  browser = await (browserName === 'webkit' ? webkit.launch({ headless: true,
    ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {})
  }) : chromium.launch({ headless: true, channel: 'chrome' }));
  const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true,
    ...(browserName === 'webkit' ? { userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 Version/12.1.2 Mobile/15E148 Safari/604.1' } : {}) });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(origin + '/item/view/1?compat=1');
  const video = page.locator('#kw-video'), play = page.locator('.kw-toolbar [data-action="play"]');
  await video.waitFor();
  assert.equal(requests.filter(path => path === '/manifest/hls4/test').length, 0, 'the page must wait for Play');
  await page.locator('.kw-big-play').click();
  await page.waitForFunction(() => document.querySelector('#kw-video').currentTime > 1 && document.querySelector('#kw-video').videoWidth > 0);
  const native = await video.evaluate(v => !v.currentSrc.startsWith('blob:'));
  assert.equal(native, browserName === 'webkit', 'WebKit must exercise native HLS; Chrome must exercise hls.js');

  await video.evaluate(v => { v.pause(); v.currentTime = 12.5; });
  await page.waitForFunction(() => !document.querySelector('#kw-video').seeking);
  await page.locator('.kw-toolbar [data-action="settings"]').click();
  await page.getByLabel('Скорость', { exact: true }).selectOption('1.25');
  await page.getByLabel('Качество', { exact: true }).selectOption(native ? '600000' : '0');
  await page.locator('.kw-close').click();
  await play.click();
  await page.waitForFunction(() => document.querySelector('#kw-video').currentTime > 13);
  await video.evaluate(v => v.pause());
  const position = await video.evaluate(v => v.currentTime);
  const beforePause = requests.filter(path => path === '/manifest/hls4/test').length;
  await play.click();
  await page.waitForFunction(time => document.querySelector('#kw-video').currentTime > time + 0.3, position);
  await video.evaluate(v => v.pause());
  assert.equal(requests.filter(path => path === '/manifest/hls4/test').length, beforePause, 'ordinary pause must retain the source');
  const suspendedAt = await video.evaluate(v => v.currentTime);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.testHidden });
    window.testHidden = true; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
  });
  await context.setOffline(true);
  // Let the proxy's idle connection expire while the page is suspended.
  await page.waitForTimeout(1700);
  await video.evaluate(v => { v.removeAttribute('src'); v.load(); });
  await context.setOffline(false);
  await page.evaluate(() => {
    window.testHidden = false; document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  assert.equal(await video.evaluate(v => v.paused), true, 'returning to the page must not autoplay');
  await play.click();
  await page.waitForFunction(time => {
    const v = document.querySelector('#kw-video'); return !v.paused && v.currentTime > time + 0.3 && v.videoWidth > 0 && !v.error;
  }, suspendedAt);
  const resumedAt = await video.evaluate(v => v.currentTime);
  assert.ok(resumedAt < suspendedAt + 5, 'resume must retain the exact position, including before the first progress save');
  assert.ok(requests.filter(path => path === '/manifest/hls4/test').length > beforePause, 'resume must fetch a fresh manifest');
  assert.equal(await video.evaluate(v => v.playbackRate), 1.25, 'speed must survive a rebuild');
  if (native) assert.equal(await video.evaluate(v => new URL(v.src).searchParams.get('__quality')), '600000');
  assert.equal((await fetch(origin + '/__local/health')).status, 200);
  console.log(JSON.stringify({ browser: browserName, nativeHLS: native, pauseResume: 'pass', offlineSuspendResume: 'pass', suspendedAt, resumedAt, speed: 1.25 }));

  // A media failure must recover through Retry at the position being watched,
  // even though the service has no saved progress yet (less than 60 seconds).
  await video.evaluate(v => { v.pause(); v.currentTime = 25; });
  await page.waitForFunction(() => !document.querySelector('#kw-video').seeking);
  await video.evaluate(v => { v.dispatchEvent(new Event('timeupdate')); v.src = '/broken.m3u8'; v.load(); });
  await page.waitForFunction(() => !!document.querySelector('#kw-video').error);
  await page.locator('[data-action="retry"]').click();
  await page.waitForFunction(() => {
    const v = document.querySelector('#kw-video'); return v.currentTime > 25.3 && !v.paused && !v.error;
  });
  assert.ok(await video.evaluate(v => v.currentTime < 30));
  await video.evaluate(v => v.pause());
  assert.deepEqual(errors, [], 'player must not produce uncaught JavaScript errors');
  console.log(JSON.stringify({ browser: browserName, mediaErrorRetry: 'pass', position: await video.evaluate(v => v.currentTime), pageErrors: errors }));

  // Zero is a real seek position, not a missing value to replace with stale
  // progress. Empty the source before a queued timeupdate can record the seek.
  await page.evaluate(() => {
    const v = document.querySelector('#kw-video'); v.currentTime = 0;
    window.testHidden = true; document.dispatchEvent(new Event('visibilitychange'));
    v.removeAttribute('src'); v.load();
    window.testHidden = false; document.dispatchEvent(new Event('visibilitychange'));
  });
  await play.click();
  await page.waitForFunction(() => document.querySelector('#kw-video').currentTime > 0.3);
  assert.ok(await video.evaluate(v => v.currentTime < 5), 'resuming after seeking to zero must start at zero');
  await video.evaluate(v => v.pause());
  const nativeControlPosition = await video.evaluate(v => v.currentTime);
  await page.evaluate(() => {
    window.testHidden = true; document.dispatchEvent(new Event('visibilitychange'));
    window.testHidden = false; document.dispatchEvent(new Event('visibilitychange'));
    // Model the native fullscreen Play control, bypassing the custom button.
    document.querySelector('#kw-video').play().catch(() => {});
  });
  await page.waitForFunction(time => document.querySelector('#kw-video').currentTime > time + 0.3, nativeControlPosition);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ browser: browserName, resumeFromZero: 'pass', nativePlayControl: 'pass' }));
  await page.close();
  await verifyProgress({ context, origin, saves,
    rejectNextSave: () => { nextSaveResponse = 'html'; },
    publish: () => { publishedPosition = persistedPosition; } });
  console.log(JSON.stringify({ browser: browserName, accountProgress: 'pass' }));
  await verifyLegacyResume({ context, origin, saves });
  console.log(JSON.stringify({ browser: browserName, rewatchResume: 'pass', delayedSeekability: 'pass' }));
} finally {
  if (browser) await browser.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const session of sessions) session.destroy();
  if (upstream) await new Promise(resolve => upstream.close(resolve));
  await rm(mediaDir, { recursive: true, force: true });
}
