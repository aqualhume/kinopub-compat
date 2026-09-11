# Inspect and control Safari on an iOS 12 iPad

This procedure connects to **Safari running on a physical iPad** over USB.
It was verified with iOS **12.0.1**, Safari **12.0**, and a Mac.

The connection is:

```text
iPad Safari → USB / macOS usbmuxd → ios_webkit_debug_proxy
            → WebSocket / WebKit Inspector Protocol → Node.js helper
```

Playwright's current WebKit and an iOS 12 user-agent do not reproduce this
runtime. Playwright's Chrome/CDP connection cannot attach to this inspector
endpoint. Use the helper below for the device and Playwright separately for
browser regression checks.

## 1. Prepare the device and Mac

1. Connect the iPad to the Mac with a USB data cable.
2. Unlock the iPad and accept **Trust This Computer** if prompted.
3. On the iPad, enable **Settings → Safari → Advanced → Web Inspector**.
4. Keep Safari in the foreground with the affected Kinopub title page open.
   The proxy must be running at the address used by the iPad. Use the proxy
   address configured for your network, for example `http://proxy-host.local:3000`.

Install the USB inspector bridge once:

```sh
HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install ios-webkit-debug-proxy
```

Homebrew installs `libimobiledevice` and the other bridge dependencies. This
does not install software on the iPad. The verified bridge version was 1.9.2.
The repository helper requires Node.js 22 or later.

Confirm the device and OS:

```sh
ideviceinfo -k ProductVersion
ideviceinfo -k ProductType
```

Querying individual keys avoids dumping the device's full information record.

## 2. Start the USB bridge

In a terminal, keep this running:

```sh
ios_webkit_debug_proxy --no-frontend --config 'null:9231,:9232'
```

Port 9231 lists devices; port 9232 lists Safari pages on the first attached
device. These ports avoid the usual Playwright/Chrome debug port 9222.

In a second terminal:

```sh
curl --silent --show-error http://127.0.0.1:9232/json
```

Find the affected page's title, URL, and `webSocketDebuggerUrl`, for example:

```text
ws://127.0.0.1:9232/devtools/page/1
```

Page numbers can change after tabs are closed or the device reconnects. List
the pages again rather than assuming the page is always `1`.

## 3. Start the repository's inspector helper

From the repository or worktree root, in a second terminal:

```sh
node scripts/inspect-ipad.mjs
```

It selects the first `/item/view/` page and prints which page it attached to.
If several title tabs are open, select the page number explicitly:

```sh
IOS_PAGE_ID=1 node scripts/inspect-ipad.mjs
```

For different ports:

```sh
IOS_DEBUG_URL=http://127.0.0.1:9232 IOS_INSPECTOR_PORT=9233 IOS_PAGE_ID=1 node scripts/inspect-ipad.mjs
```

The helper exposes a command interface at `http://127.0.0.1:9233` on the Mac.
It connects directly to the real page, uses the page's existing login, and
keeps a bounded event log in memory. It does not write browser state or cookies
to disk. Only run one inspector client on the selected tab at a time; close
Mac Safari's inspector for that tab before attaching the helper.

## 4. Inspect page state

In a third terminal, confirm the **actual** user-agent and player:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"({ua:navigator.userAgent,compat:!!window.kinoCompatPlayer})"}'
```

The connected device reported:

```text
Mozilla/5.0 (iPad; CPU OS 12_0_1 like Mac OS X) AppleWebKit/605.1.15
(KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1
```

Inspect playback and HLS seekability:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"(function () { var v = document.querySelector(\"#kw-video\"), ranges = []; if (!v) return null; for (var i = 0; i < v.seekable.length; i++) ranges.push([v.seekable.start(i), v.seekable.end(i)]); return {time:v.currentTime,duration:v.duration,readyState:v.readyState,paused:v.paused,seeking:v.seeking,error:v.error && v.error.code,seekable:ranges}; }())"}'
```

Expressions execute **on the iPad**, so use Safari 12-compatible JavaScript
(for example, no optional chaining). Results appear under `result.value`.
Inspect `wasThrown` and the returned error description if evaluation fails.
Non-finite media durations appear as `null` in JSON.

To inspect resume records without exposing account credentials:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"(function () { var a = document.querySelector(\".nav-avatar a[href^=\\\"/users/\\\"]\"), account = a ? a.getAttribute(\"href\").split(\"/\").pop() : \"local\"; return (window.PLAYER_PLAYLIST || []).map(function (e) { return {id:e.media_id,season:e.season,episode:e.episode,marktime:e.marktime,completed:e.completed,saved:localStorage.getItem(\"kw_progress_\" + account + \"_\" + e.media_id)}; }); }())"}'
```

The player changes `entry.marktime` during playback, so capture playlist values
immediately after a fresh page load when checking upstream readback.

## 5. Control the page

Commands use WebKit's `Runtime.evaluate`. The helper maps `userGesture: true`
to the inspector's `emulateUserGesture` option.

Open the episode panel:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"document.querySelector(\"[data-action=episodes]\").click()","userGesture":true}'
```

Close it:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"document.querySelector(\".kw-panel .kw-close\").click()","userGesture":true}'
```

Opening and closing this panel was verified through the helper on the iPad.
The same interface can click the player's toolbar Play/Pause button:

```sh
curl --silent --show-error http://127.0.0.1:9233/eval \
  -H 'Content-Type: application/json' \
  --data '{"expression":"document.querySelector(\".kw-toolbar [data-action=play]\").click()","userGesture":true}'
```

That button toggles state; inspect `paused` before using it. If Safari requires
a physical gesture to start media, tap Play on the iPad and observe through the
helper. These controls operate the real player, including its account progress
saves. Playback, fullscreen, and screen-lock behavior need their own checks;
opening a panel does not verify those behaviors.

To reload through the inspector:

```sh
curl --silent --show-error http://127.0.0.1:9233/command \
  -H 'Content-Type: application/json' \
  --data '{"method":"Page.reload","params":{"ignoreCache":true}}'
```

## 6. Capture a save/resume failure

The helper observes native media events and account progress traffic. Read its
in-memory log while operating the iPad:

```sh
curl --silent --show-error http://127.0.0.1:9233/events
```

It records:

- Metadata, duration, seeking, playback, pause, error, and page-visibility events,
  including current time and seekable ranges.
- `/item/media-marktime` requests: media ID, requested time, HTTP status, and
  the JSON `success` acknowledgement when available.
- Playlist and watched-mark request metadata.

Request headers, CSRF tokens, session cookies, and signed media URLs are omitted
from this event log. Events stay in memory across page reloads while the helper
connection remains active. The page-side observer is reattached on load; account
network events come directly from Web Inspector. Time/progress events are
sampled to keep the log small. For events after a known timestamp:

```sh
curl --silent --show-error 'http://127.0.0.1:9233/events?after=<encoded-ISO-8601-timestamp>'
```

A useful reproduction sequence is:

1. Inspect the freshly loaded episode's server and local resume values.
2. Play past 60 seconds, the current account-save threshold, and pause.
3. Check the progress POST, response, and browser-local record.
4. Reload, inspect fresh playlist values, then press Play.
5. Compare the requested resume position with native metadata/seek events.

This separates a failed write, stale upstream readback, and a failed native seek.

## 7. Test a worktree player using the existing iPad login

If the iPad uses a proxy on another computer, a client-only player fix can be
tested in the existing Safari session. This temporary injection does not deploy
files to the other computer.

Start the worktree proxy on the Mac, in another terminal:

```sh
HOST=127.0.0.1 PORT=3000 node server.mjs
```

Pause playback, wait for any save acknowledgement, then reload the iPad page
using the command in section 5. Wait for the page to finish loading and **do not
press Play yet**. Run this from the worktree:

```sh
node --input-type=module -e '
const source = await (await fetch("http://127.0.0.1:3000/__local/compat-player.js")).text();
const prepare = function () {
  var v = document.querySelector("#kw-video");
  if (!v || v.currentSrc || v.readyState) throw new Error("Reload the title before injecting the worktree player");
  var shell = document.querySelector(".kw-player");
  var placeholder = document.createElement("div");
  placeholder.className = "player-shell";
  shell.parentNode.replaceChild(placeholder, shell);
};
const response = await fetch("http://127.0.0.1:9233/eval", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ expression: "(" + prepare.toString() + ")();" + source })
});
console.log(await response.text());
'
```

The original player must not have loaded media before replacement: its dormant
page listeners then have no active media state to save. Tap Play on the iPad to
exercise the replacement with a real touch gesture and inspect `/events`.

A page reload removes the replacement; reapply it after each reload during this
test. Restart the Mac's worktree proxy after editing the JavaScript, because it
caches local assets in memory. Persistent deployment requires updating and
restarting the proxy that normally serves the iPad.

## 8. Stop and reconnect

Press **Ctrl-C** in the helper terminal, then in the bridge terminal. The
helper's event log is discarded. Reload the iPad page to remove the temporary
page-side event listeners it installed.

If USB is disconnected, Safari closes the tab, or the debugger connection is
lost, list the targets again and restart the helper with the current page number.

## Troubleshooting

- **`ideviceinfo` cannot see the device:** unlock it, check the USB data cable,
  and confirm the trust prompt. `ioreg -p IOUSB -w 0` can confirm USB detection.
  On some Macs, `system_profiler SPUSBDataType` can return an empty list even
  though the iPad is connected and `ioreg` detects it.
- **No page at port 9232:** keep Safari open on the iPad, confirm Web Inspector
  is enabled, and restart the bridge. `http://127.0.0.1:9231/json` lists attached
  devices and their assigned inspector ports.
- **Wrong tab or a command timeout:** check `/json` again, close another
  inspector attached to that tab, and restart with `IOS_PAGE_ID`.
- **Port already in use:** inspect listeners with
  `lsof -nP -iTCP -sTCP:LISTEN`; use different bridge/helper ports if necessary.
- **Current-WebKit installation fails:** it is not required for this workflow.
  The real Safari engine is already installed on the iPad.
