# Verification record

Watch-position investigation on 2026-09-08 reproduced an authentication bug:
filtering a leading local cookie left whitespace at the start of the forwarded
Cookie header. A real local HTTP/2 upstream then received no Cookie header at
all. Trimming each retained cookie fixes all tested cookie orders. Another
regression reproduced cancellation of a fully uploaded progress POST when the
client disconnected; that write now finishes within the upstream timeout.

Expanded Playwright checks use an authenticated, stateful local upstream and
real HLS playback. They cover periodic saves, pause/sleep flushes, a rejected
beacon, HTML returned instead of a save acknowledgement, retry, stale upstream
positions, and resume with local storage cleared. The live service also accepted
a save through the compatibility player's UI and returned position 660 on a
fresh original-site page after a short delay. The test title was reset to its
initial unwatched state. These observations supersede the earlier unresolved
progress-readback entry below; a successful POST alone is not the readback test.

Playback recovery checks added on 2026-09-07 use generated HLS video, a local
HTTP/2 upstream, and fresh Playwright browser profiles. Both Chrome (hls.js) and
WebKit (native HLS with an iOS 12 user agent) resumed after simulated page
suspension, an offline interval longer than the test proxy's idle timeout, and
discarding the media source. Position and 1.25× speed were retained; Retry after
a media error resumed at 25 seconds, before any account progress save. No
uncaught page errors occurred. The browser test also covers a seek to zero and
the Play event used by native controls. Run `npm run test:playback`; see README
for browser selection and prerequisites.

These are browser recovery tests, not a physical iPad screen-lock test. The
earlier signed-in live-service checks below have not been repeated in this run.

Verified on 2026-09-06 against the signed-in live service with Playwright.

| Requirement | Evidence | Status |
| --- | --- | --- |
| Local server | `npm start`; health endpoint responds | Pass |
| Same-network access | Listener `*:3000`; HTTP request to the printed LAN address; fresh browser reaches login | Pass from host via LAN address; other-device confirmation pending |
| Original appearance | Original and local homepage screenshots; live original HTML/styles served locally | Main layout verified |
| Live catalog and navigation | 18 authenticated routes returned HTTP 200: home, popular, movie, serial, anime, concert, documovie, docuserial, tvshow, sport, favorites, history, new episodes, selection, award, kinoblog, plugin, search | Pass for page loading |
| Search and filtering controls | Selected IMDb sorting, submitted filter, received 48 cards; entered Matrix in search, received 10 matches | Pass |
| Bookmark persistence | Added a title to an existing folder, received HTTP 200, confirmed checked state after reload, then removed the test bookmark | Pass |
| Session isolation | A fresh browser context goes to login rather than inheriting another browser's account | Pass |
| Real video in Chrome | Compatibility player decoded live video at 1920×800 with progressing time and no media error | Pass |
| Original desktop player | Original player decoded live video at 1920×800 through the local server | Pass |
| Native Safari HLS | Playwright WebKit decoded live HLS without a blob/MSE source; 720×300, two audio tracks, 45 subtitle tracks, no JavaScript errors | Pass on current WebKit |
| Episode and season switching | Opened season 2, selected episode 2, URL changed to `/s2e2`, decoded video at 1280px width | Pass |
| Player settings | Audio/subtitle lists populated; audio, subtitle, speed selected; seeking reached 65 seconds | Pass for controls; native track switching still needs device check |
| Account progress transport | Real progress endpoint accepted POST with HTTP 200 and `success:true` | Pass for transport |
| Account progress readback | Test title returned zero immediately after saves on both local client and original website | Upstream behavior unresolved; browser-local resume fallback added |
| Local resume | Sought to 67 seconds, reloaded, started playback, confirmed resume at 67 seconds; cleared test position afterward | Pass |
| Older browser syntax | Local browser scripts parse as ES5; upstream legacy scripts transformed to Safari 12 target | Pass for checked syntax |
| Transfer size and caching | Against a mock upstream, a legacy page fell from 669KB to 193KB on the wire for a client sending `gzip, deflate`, which is what Safari offers over plain HTTP, and to 180KB for a client that also accepts Brotli. Local files use content-versioned immutable caching, and public site scripts/styles are cached in the proxy for five minutes. In a live test, a second fresh browser reached DOM-ready in 0.52s using the warm proxy asset cache, versus 6.48s while that proxy cache was cold. | Pass under measurement, not on device |
| Deferred player traffic | An authenticated legacy title page loaded the compatibility player without `hls.js` or a manifest request. Opening quality settings made one manifest request; forced desktop compatibility playback made one request and decoded live video at 1280×694. | Pass in current browsers |
| Regression checks | 18 automated checks, including CSRF cookie separation, unchanged account request bodies, cross-origin write rejection, video byte ranges, compressed documents, shared public assets, versioned local assets, and untouched relayed media | Pass |
| iPad responsive layout | 768×1024 WebKit viewport, touch/mobile settings; no horizontal overflow | Pass in emulation |
| Actual iOS 12 hardware | Awaiting user playback test | Pending |

Current WebKit with an iOS 12 user agent is **not** an iOS 12 runtime. It proves
the native HLS route and responsive layout, not physical-device compatibility.
AirPlay, picture-in-picture, native fullscreen, every account mutation, and
payment flows have not all been exercised. These remain platform/service-dependent.

The transfer figures come from a mock upstream and a bandwidth-throttled loopback
relay, which isolate the server's own cost. Against the live service, network
latency dominates a first visit, so an observed page load improves by less than
those ratios suggest. On realistic page markup, compressing repaid its own cost
at every size measured, from a 0.7KB fragment upward; the cost itself is about
0.03ms on a small document and 0.26ms on 24KB of script. Sub-millisecond
comparisons on small documents sit within measurement noise and should not be
read as a difference. The throttled figures were taken with a client accepting
Brotli; Safari over plain HTTP receives gzip instead, which is about 8% larger on
`hls.js` and roughly twice the size on a small HTML document, so a device sees
slightly less benefit than those ratios show. No timing has been taken on iOS 12
hardware.

Reference screenshots and temporary browser artifacts are ignored by Git.
Authenticated browser state is never persisted by the test harness.
