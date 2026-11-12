# Strict Shield — strict ad & popup blocker for Chrome

A Manifest V3 Chrome extension with one rule: **a page may only open its own site.**
Cross-site popups are closed, cross-site redirects are stopped, ads and trackers are blocked, and
everything it blocks is remembered on your device.

```
extension/          ← the extension itself (load this folder / zip this folder)
  manifest.json
  src/background.js       service worker: popup backstop, navigation guard, rules, history
  src/lib/site.js         "same site" logic + the single allow/block decision
  src/content/guard-main.js   wraps window.open() etc. inside the page (MAIN world)
  src/content/guard.js        click/submit guard, cosmetic filter, toast (isolated world)
  src/content/cosmetic.js     CSS selectors for ad containers
  src/content/overlay.js      on-screen popup closer (modals, cookie walls, click traps, layers over embedded players)
  rules/ads.json, rules/trackers.json   generated network rules
  pages/              toolbar popup, settings, last-resort "blocked" page
filters/ads.txt, filters/trackers.txt   ← edit these to change what is blocked
tools/build-rules.mjs   filters/*.txt → extension/rules/*.json
tools/package.sh        builds dist/strict-shield-<version>.zip for the Web Store
tools/make-icons.py     redraws the icons
test/                   end-to-end tests in a real Chromium
store/                  Web Store listing text and screenshots
PRIVACY.md              privacy policy to host publicly
```

## Install from GitHub

1. Download the code: **Code → Download ZIP** on [the repository page](https://github.com/HarsimarSingh23/strict-shield) and unzip it,
   or clone it:
   ```bash
   git clone https://github.com/HarsimarSingh23/strict-shield.git
   ```
   Keep the folder somewhere permanent. The browser runs the extension straight from it.
2. Open `chrome://extensions` (or `brave://extensions`, `edge://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the `extension` folder inside it.
4. Reload any tabs that were already open (content scripts only start on new page loads).

To update later: `git pull` (or download again), then click ↻ on the extension's card.

## How the filtering works

Nothing is blocked by one trick alone. There are five layers, from earliest to latest:

| # | Layer | Where | What it stops |
|---|---|---|---|
| 1 | **Network rules** | Chrome's built-in `declarativeNetRequest` engine | Any request to a domain in `filters/ads.txt` / `filters/trackers.txt` is cancelled before it leaves the browser. Third-party `ping`/beacon requests are blocked too. Fast, and the extension never sees the traffic. |
| 2 | **Popup guard in the page** | `guard-main.js`, injected before the page's own scripts | Wraps `window.open()`, detached `<a>.click()`, `form.submit()` and fresh iframes' `window.open`. For each one it asks `guard.js` "same site?" synchronously; if not, the call returns `null` and no tab is created. |
| 3 | **Click guard** | `guard.js` | Cancels clicks on links that would open another site (`target="_blank"`, middle/ctrl-click, and in strict mode same-tab links too), then shows a toast with **Open once** / **Always allow**. |
| 4 | **Browser backstop** | `background.js` | Watches `webNavigation.onCreatedNavigationTarget` and every top-level request (`webRequest`, read-only). A new tab whose address is a different site from its opener is closed — this catches tricks the page guard can't see, like `window.open('')` followed by `w.location = ad`, or a same-site "bounce" page that redirects to an ad. A page sending **its own tab** to another site is stopped **where it is**: scripted redirects are cancelled inside the page (Navigation API `navigate` event), server redirects and ad-frame `top.location` jumps are stopped by the worker (`window.stop()` in that exact page). You stay on the page and a notice offers **Open once** / **Always allow**. If one slips through, the tab goes back. |
| 5 | **Cosmetic filter** | `cosmetic.js` + `guard.js` | A style sheet hides known ad containers so you don't see empty boxes. |
| 6 | **On-screen popup closer** | `overlay.js` | Closes things a page puts over its own content: newsletter and "subscribe" modals, cookie walls, "turn off your ad blocker" boxes, notification prompts, interstitial ads, invisible click-trap layers. It also runs inside frames and clears what is laid over a video or embedded player. See below. |

**How it decides "same site":** it compares registered domains (eTLD+1): `mail.google.com` and
`www.google.com` are one site; `google.com` and `youtube.com` are two; `bbc.co.uk` handles the
`co.uk` suffix. One function, `StrictSite.decide()` in `src/lib/site.js`, makes every decision so the
page and the service worker can never disagree.

**What is never blocked:** addresses you type, bookmarks, back/forward, reloads, and anything you
allow. "Sign in with Google/Microsoft/Apple" and payment providers (PayPal, Stripe, Razorpay, Paytm,
PhonePe, PayU, BillDesk, CCAvenue, Cashfree) are trusted by default so logins and checkouts keep
working — turn **Allow sign-in and payment providers** off in Settings for maximum strictness.

**Modes** (Settings → Links and redirects to other sites):
- **Strict** (default): every link, redirect or form that leaves the site is stopped and asks first.
- **Balanced**: links you click yourself open; automatic redirects, scripted navigation and all
  cross-site popups are still blocked.
- **Off**: only popups are blocked.

### On-screen popups (auto-closer)

Some sites cover the page with popups instead of opening new windows. `overlay.js` deals with those.

**How it finds them.** When the page changes, a few seconds after it loads, and when you scroll or
move the mouse to leave the page, it asks the browser what sits on top at five points in the middle
of the screen and five near the edges (`document.elementsFromPoint`). It walks up from the top
element to the outermost `position: fixed` layer and classifies it:
- **modal**: a fixed layer over the middle of the page that sits on top of real content
- **backdrop**: a full-screen layer with almost nothing in it (a dimmed background, or an invisible
  click trap that turns any click into an ad)
- **banner**: a fixed bar at an edge that talks like a popup (cookies, newsletter, notifications,
  "open in app", "% off", ad blocker…), without navigation or lots of links
- a modal `<dialog>`

It leaves alone: the site's own layout (a fixed element holding most of the page), fullscreen
video, anything containing a captcha, payment or sign-in frame, and **anything that appears within
1.5 s after you click a button or link or press a key**. That last rule keeps login boxes and menus
you open yourself working.

**How it closes them**, in order:
1. Press the popup's own close button: `×`, "Close", "No thanks", "Not now", "Maybe later", "Skip",
   "Reject all", "Continue without accepting"… It **never** presses Accept, Agree, Allow,
   Subscribe, Sign up, Log in or OK, and never follows a "close" link that points to another page
   (a common fake close button on ads).
2. Press Escape.
3. Hide it (`display: none !important`).

Then it gives scrolling back (undoes `overflow: hidden` / `position: fixed` scroll locks that
appeared after the page loaded) and removes the blur sites put on the content behind. A small notice
says what was closed, with **Undo** and **Never on this site**.

**Embedded players and frames (video first).** The closer also runs inside every frame of the page,
and always follows the settings of the site in the address bar. The idea: in an embedded player,
only the video and its own controls should be left. Whatever lies on top of a video, or on top of
an embedded player frame, without being part of the player is removed:

| On top of the player | Removed when |
|---|---|
| Invisible layer that only catches your click | Over an embedded frame: always. Over a video: only if it looks injected (attached straight to `<body>` inside a player frame, or `z-index` 9999 and up), because players have invisible click layers of their own. |
| Another frame laid over the video, inside a player frame | Always, except captcha, payment and sign-in frames, and Google's video-ad controls frame (hiding that would hide "Skip ad"). |
| Link layer to another site stretched over the player | When it covers a good part of the player and leads to neither the frame's own site nor the page's site. |

Layers that hold controls (buttons, sliders, a video) or carry a known player name (`vjs-`, `jw-`,
`plyr`, `ytp-`, "control", "caption", "poster"…) are never touched. In a wrapper frame, the inner
player frame counts as the player. A frame with no video yet is treated as the player itself.
The notice for a frame is shown in the page, and its **Undo** puts everything back in every frame.

**Proven click traps.** If a click on a layer tries to open a popup and Strict Shield blocks it, that
layer has shown what it is. An empty, invisible layer lying over the page or a player is then
removed on the spot, so your next click reaches the player. This works on every site where the
closer isn't off, learned or not. Something you can see is only removed after doing it twice (it
may be the real play button showing an ad on the first click), and visible links are never removed
this way.

Loading *only* the video file in a frame isn't possible in general: a player needs its own scripts to
fetch and play the video. So the frame's code still runs; its popups and redirects are blocked by
the layers above, and what it lays over the video is removed here.

**Where it runs** (Settings → On-screen popups):
- **Auto** (default): on sites in your "Auto-close on-screen popups on" list. A site is added by
  itself once it has shown **3** unsolicited popups (counted across visits), which is what "sites that
  use heavy popups" means here. Before that, popups are only counted.
- **Every site**: everywhere except your "never" list.
- **Off**: never by itself.

The toolbar popup has a per-site switch, and a **Close popups on this page now** button that works
in every mode and reaches every frame of the page. Using that button also adds the site to the
auto-close list.

### Memory ("remember what was blocked")

Every blocked popup, redirect, link and closed on-screen popup is saved in `chrome.storage.local` with the URL, the site that
tried to open it, first/last time and a counter. It survives browser restarts and is deleted only when
you clear it or uninstall. See it in the toolbar popup (this site) or Settings → **Blocked history**
(search, export JSON, "Always block" a domain, or allow a site). The last-resort blocked page also
tells you how many times that redirect was blocked before. Up to 2,000 entries are kept. A per-site count of
on-screen popups (`overlayCounts`) is kept too, for learning heavy-popup sites.

### Private windows (Brave Private, Chrome Incognito)

Extensions are off in private windows until you allow them: `brave://extensions` → Strict Shield
→ **Details** → **Allow in Private**. Everything works there the same way, except the last-resort
blocked page (see Known limits). The blocked history and your lists are shared with normal windows.

## Change what is blocked

Edit `filters/ads.txt` or `filters/trackers.txt` (one domain per line, or a `||host/path` rule), then:

```bash
node tools/build-rules.mjs
```

To pull in a big public list such as EasyList (check its licence first — EasyList is GPLv3 / CC BY-SA):

```bash
node tools/build-rules.mjs --import easylist.txt --into ads
```

The importer only takes whole-domain rules (`||domain^`), which is what `declarativeNetRequest`
handles best. Chrome guarantees an extension 30,000 static rules; each list here compiles to a handful
of rules because one rule can hold thousands of domains.

## Test

```bash
npm install
npm test
```

The tests start Chromium with the extension, serve fake sites (`site-a.test`, `site-b.test`,
`doubleclick.net`…) from a local server, and check 48 cases: ad/tracker blocking, cosmetic hiding,
every popup trick above, server and JS redirects (you stay on the page), undoing a redirect that got
through, the last-resort blocked page's buttons, balanced mode, pause,
allow and block lists, that the history is saved, and the on-screen popup closer (learning a
heavy-popup site, close button vs "Reject all" vs never "Accept", hiding a wall with no close
button and restoring scroll and blur, leaving a login box you opened alone, click traps, `<dialog>`,
"never" sites, the manual button, every-site mode), and embedded players (click traps, ad frames
and link layers over a video inside a frame; the video, its controls and its own click layer staying;
a wrapper frame; a layer proven by a blocked popup; a play button that shows one ad first; the notice
and Undo across frames). `HEADFUL=1 npm test` to watch.
If the Chrome for Testing download fails, point it at any Chromium build:
`CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" npm test`.

## Publish to the Chrome Web Store

1. **Build the zip:** `bash tools/package.sh` → `dist/strict-shield-1.0.0.zip`.
2. **Developer account:** register at <https://chrome.google.com/webstore/devconsole> (one-time US$5
   fee, 2-step verification required).
3. **Privacy policy:** GitHub Pages publishes `PRIVACY.md` at
   <https://harsimarsingh23.github.io/strict-shield/PRIVACY.html>. Paste that link into the dashboard.
4. **New item** → upload the zip.
5. **Store listing / Privacy practices / Distribution:** copy everything from
   [store/STORE_LISTING.md](store/STORE_LISTING.md) — description, single purpose, a justification
   for every permission, and the data-usage answers. Upload `store/store-icon-128.png` and the
   1280×800 screenshots from `store/`.
6. **Submit for review.** Because the extension can read all sites, expect an in-depth review: a few
   days, sometimes a couple of weeks. Vague permission justifications are the most common rejection
   reason — the ones in `STORE_LISTING.md` are written to match exactly what the code does.
7. **Updates:** bump `"version"` in `extension/manifest.json`, re-run `tools/package.sh`, upload.

## Known limits

- Chrome's MV3 rules cannot block by "this request is cross-site from the tab's page". Scripted
  redirects are cancelled inside the page before they start, but a **server** redirect (or an ad frame
  changing `top.location`) is stopped while it is already on its way. On a very fast server the other
  site can appear for a moment before the tab goes back to where you were.
- In normal windows, a page that keeps redirecting every time it's sent back gets the full blocked
  page as a last resort. **Private windows** never get it: Chrome and Brave don't let an extension's
  own pages load in private windows, so there the redirect is let through after two tries. Your
  "Always blocked" list has the same limit: in private windows a blocked site shows the browser's
  own "blocked" error instead of Strict Shield's page.
- Cross-site **form posts** (some SSO and bank 3-D Secure pages) are stopped in strict mode;
  "Continue once" re-opens the address but cannot resend the form. Use **Always allow** and submit
  again.
- YouTube video ads need site-specific scripts and are out of scope. Anti-adblock walls are hidden
  by the on-screen popup closer, but a site that also withholds its content until you allow ads
  will still show an empty page.
- The on-screen popup closer works by looking at the page, not from a list, so it can miss an unusual
  popup or, rarely, close something you wanted. Use **Close popups on this page now** for the first,
  and **Undo** / **Never on this site** for the second.
- Inside embedded players the closer is careful on purpose. An invisible layer inside the player's
  own container is only removed after a click on it proved it opens popups (one wasted click), and a
  fake play button you can see after two. Things the player's own code draws, such as a video ad
  with its countdown, are left alone.
- The public-suffix list in `site.js` covers common suffixes, not all ~9,000.

## License

[MIT](LICENSE) © 2026 Harsimar Singh. Privacy policy: [PRIVACY.md](PRIVACY.md)
([web version](https://harsimarsingh23.github.io/strict-shield/PRIVACY.html)).
