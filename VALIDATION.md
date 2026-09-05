# Verification record

Verified on 2026-09-05 against the signed-in live service with Playwright.

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
| Regression checks | 11 automated checks, including CSRF cookie separation, unchanged account request bodies, cross-origin write rejection, and video byte ranges | Pass |
| iPad responsive layout | 768×1024 WebKit viewport, touch/mobile settings; no horizontal overflow | Pass in emulation |
| Actual iOS 12 hardware | Awaiting user playback test | Pending |

Current WebKit with an iOS 12 user agent is **not** an iOS 12 runtime. It proves
the native HLS route and responsive layout, not physical-device compatibility.
AirPlay, picture-in-picture, native fullscreen, every account mutation, and
payment flows have not all been exercised. These remain platform/service-dependent.

Reference screenshots and temporary browser artifacts are ignored by Git.
Authenticated browser state is never persisted by the test harness.
