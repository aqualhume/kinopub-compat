import assert from 'node:assert/strict';

// Uses actual HLS playback and the fixture's authenticated, stateful upstream.
export async function verifyProgress({ context, origin, saves, rejectNextSave, publish }) {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('kw_speed', '1'));
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const url = origin + '/item/view/2?compat=1';
  const video = page.locator('#kw-video');
  const play = page.locator('.kw-toolbar [data-action="play"]');
  async function waitForSave(after, predicate = () => true) {
    const limit = Date.now() + 5000;
    while (!saves.slice(after).some(predicate)) {
      assert.ok(Date.now() < limit, 'expected authenticated progress POST: ' + JSON.stringify(saves.slice(after)));
      await page.waitForTimeout(25);
    }
  }
  try {
    await page.goto(url);
    const cookies = await context.cookies(origin);
    assert.ok(cookies.some(c => c.name === 'PHPSESSID' && c.value === 'fixture-session'),
      'fixture must establish its session');
    const firstRequest = page.waitForRequest(r => r.url().endsWith('/item/media-marktime'));
    await play.click();
    await page.waitForFunction(() => document.querySelector('#kw-video').currentTime >= 60);
    await waitForSave(0, s => s.media === 2 && s.time >= 60);
    const sent = await firstRequest;
    assert.match(await sent.headerValue('cookie') || '', /PHPSESSID=fixture-session/);
    assert.ok(saves.every(s => s.valid), 'first progress request must retain the account session');
    const first = saves.length;
    // No seek or pause: the next save must come from ongoing playback.
    await page.waitForFunction(() => document.querySelector('#kw-video').currentTime >= 76, null, { timeout: 20000 });
    await waitForSave(first, s => s.media === 2 && s.time >= 70);
    const beforePause = saves.length;
    await video.evaluate(v => v.pause());
    const paused = await video.evaluate(v => Math.floor(v.currentTime));
    await waitForSave(beforePause, s => s.time === paused);

    const beforeHide = saves.length;
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForSave(beforeHide, s => s.time === paused);
    const beforeRejectedBeacon = saves.length;
    await page.evaluate(() => {
      navigator.sendBeacon = () => false;
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    });
    await waitForSave(beforeRejectedBeacon, s => s.time === paused);

    // The upstream still publishes 60, so the newer browser record must win.
    await page.reload();
    await play.click();
    await page.waitForFunction(time => document.querySelector('#kw-video').currentTime >= time, paused);
    await video.evaluate(v => v.pause());
    assert.ok(await video.evaluate(v => v.currentTime < 80));

    const beforeFailure = saves.length;
    rejectNextSave();
    const rejected = page.waitForResponse(r => r.url().endsWith('/item/media-marktime') && /text\/html/.test(r.headers()['content-type'] || ''));
    await video.evaluate(v => { v.currentTime = 81; });
    await rejected;
    await waitForSave(beforeFailure, s => s.time === 81 && !s.accepted);
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kw_progress_fixture_2')).time === 81);
    await video.evaluate(v => v.dispatchEvent(new Event('pause')));
    // A previously queued pause/seek flush may already have retried it.
    await waitForSave(beforeFailure, s => s.time === 81 && s.accepted);
    assert.ok(saves.every(s => s.valid), 'cookies, CSRF, and origin must survive the proxy: ' + JSON.stringify(saves));
    publish();

    // Remove the local fallback to prove that resume also works from an
    // account position supplied by the upstream on a subsequent page load.
    await page.addInitScript(() => localStorage.clear());
    await page.reload();
    await play.click();
    await page.waitForFunction(() => document.querySelector('#kw-video').currentTime >= 81);
    await video.evaluate(v => v.pause());
    assert.ok(await video.evaluate(v => v.currentTime < 85));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}
