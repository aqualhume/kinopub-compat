// One-shot local test harness. Session cookies are accepted only in memory and
// discarded when the test browser closes. No browser storage state is saved.
import http from 'node:http';
import { webkit } from 'playwright';
import { mkdir } from 'node:fs/promises';

const origin = process.env.TEST_ORIGIN || 'http://127.0.0.1:3000';
const server = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/verify' || req.headers.origin || req.headers['x-kino-test'] !== '1' || req.headers['content-type'] !== 'application/json') {
    res.writeHead(403); res.end(); return;
  }
  server.close();
  let browser;
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 65536) throw new Error('Oversized test input'); }
    const input = JSON.parse(body); body = '';
    browser = await webkit.launch({ headless: true, ...(process.env.WEBKIT_EXECUTABLE ? { executablePath: process.env.WEBKIT_EXECUTABLE } : {}) });
    const context = await browser.newContext({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true,
      userAgent: 'Mozilla/5.0 (iPad; CPU OS 12_5_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.1.2 Mobile/15E148 Safari/604.1' });
    await context.addCookies(input.cookies.filter(c => c.domain === new URL(origin).hostname));
    input.cookies.length = 0;
    const page = await context.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/item/view/126811/s0e1');
    await page.locator('#kw-video').waitFor();
    await mkdir('test-results', { recursive: true });
    await page.screenshot({ path: 'test-results/webkit-ipad.png' });
    const result = await page.evaluate(() => ({ title: document.title, player: !!window.kinoCompatPlayer,
      native: document.querySelector('#kw-video').canPlayType('application/vnd.apple.mpegurl'),
      audioAPI: 'audioTracks' in document.querySelector('#kw-video'), overflow: document.documentElement.scrollWidth > innerWidth }));
    await page.locator('.kw-big-play').click();
    await page.waitForFunction(() => document.querySelector('#kw-video').currentTime > 2, null, { timeout: 45000 });
    result.playback = await page.locator('#kw-video').evaluate(v => ({ time: v.currentTime, width: v.videoWidth, height: v.videoHeight,
      duration: v.duration, audioTracks: v.audioTracks.length, subtitles: v.textTracks.length, sourceIsBlob: v.currentSrc.startsWith('blob:') }));
    await page.locator('#kw-video').evaluate(v => v.pause());
    await page.locator('.kw-toolbar [data-action="settings"]').click();
    result.settings = await page.locator('.kw-panel').innerText();
    result.errors = errors;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(result));
    console.log(JSON.stringify({ passed: true, ...result }));
  } catch (error) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ passed: false, error: error.message }));
    console.error(error.message); process.exitCode = 1;
  } finally { if (browser) await browser.close(); }
});
server.listen(3001, '127.0.0.1', () => console.log('WebKit verification waiting on loopback port 3001; credentials stay in memory.'));
const timeout = setTimeout(() => { server.close(); }, 180000); timeout.unref();
