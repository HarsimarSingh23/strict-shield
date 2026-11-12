#!/usr/bin/env python3
"""Builds NOTES_WITH_CODE.md: the project notes plus the full source of every file.

    python3 tools/build-notes.py

The code is read from disk each time, so re-run this after changing any file
and the notes stay in sync with the code.
"""
import re
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "NOTES_WITH_CODE.md"

LANG = {
    ".js": "javascript", ".mjs": "javascript", ".json": "json", ".html": "html",
    ".css": "css", ".py": "python", ".sh": "bash", ".txt": "text", ".md": "markdown",
}

INTRO = """\
# Strict Shield: notes with full source code

These notes go with the code. Part 1 explains how the extension works as a whole. Part 2 goes
through every file: what it does and how it connects to the others, followed by the file's full
code. Short guides are in [README.md](README.md), [PRIVACY.md](PRIVACY.md) and
[store/STORE_LISTING.md](store/STORE_LISTING.md).

_Generated {today} by `python3 tools/build-notes.py`. Re-run it after you change any file._
"""

PART1 = r"""
# Part 1: How it fits together

## The one rule

**A page may only open its own site.** "Site" means the registered domain (eTLD+1):

| URL | Site |
|---|---|
| `https://mail.google.com/inbox` | `google.com` |
| `https://www.bbc.co.uk/news` | `bbc.co.uk` (`co.uk` is a public suffix) |
| `https://me.github.io/blog` | `me.github.io` (each `github.io` user is their own site) |
| `http://localhost:3000` | `localhost` |

Every allow/block decision goes through one function, `StrictSite.decide()` in
`extension/src/lib/site.js`. The in-page scripts and the service worker both call it, so they never
disagree.

## The pieces

```
                ┌───────────────────────────── the web page ──────────────────────────────┐
                │  guard-main.js (MAIN world)          guard.js (ISOLATED world)          │
                │  wraps window.open, a.click(),  ──►  answers "same site?" via a sync    │
                │  form.submit(), iframe.open          DOM event; cancels link clicks;    │
                │                                      hides ads; shows the toast         │
                │                                      overlay.js: closes on-screen popups│
                └────────────────────────────────────────┬────────────────────────────────┘
                                         chrome.runtime.sendMessage │ ▲ chrome.tabs.sendMessage
                                                                    ▼ │ (toast)
┌──────────────────────── background.js (service worker) ─────────────────────────────────┐
│ webRequest.onBeforeRequest (main_frame)  → navigation guard → stop in page / go back    │
│ webNavigation.onCreatedNavigationTarget  → popup backstop   → close the tab             │
│ webNavigation.onCommitted                → remembers what each tab shows                │
│ overlaySeen / overlayClosed messages     → counts popups, learns heavy-popup sites      │
│ storage (settings, lists, log, stats)    → syncRules() → declarativeNetRequest rules    │
└──────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                   ▲
        │ storage + messages                │ network rules (rules/ads.json, rules/trackers.json)
 pages/popup.html, options.html,     Chrome's declarativeNetRequest engine
 blocked.html                         (blocks ad/tracker requests itself)
```

## What happens in each case

| Situation | Who stops it | Result |
|---|---|---|
| Page loads `doubleclick.net/gpt.js` | Chrome, using `rules/ads.json` | Request cancelled (`ERR_BLOCKED_BY_CLIENT`); badge count goes up |
| `<ins class="adsbygoogle">` on the page | `guard.js` cosmetic style | Hidden with `display:none` |
| `window.open('https://other.site')` | `guard-main.js` asks `guard.js` | Returns `null`, no tab; toast in the page |
| `<a target="_blank" href="https://other.site">` clicked | `guard.js` click listener | `preventDefault()`; toast |
| Same-tab link to another site (Strict mode) | `guard.js` click listener | Click cancelled; toast with **Open once** |
| `window.open('')` then `w.location = ad` | `background.js` popup backstop | New tab closed as soon as it heads to another site |
| Same-site "bounce" popup that redirects to an ad | `background.js` (`isYoungPopup`) | Popup tab closed |
| JS redirect, meta refresh, cross-site form post | `guard.js` (`navigate` event) | Cancelled before it leaves the page; notice with **Open once** |
| Server 302 to another site, ad iframe `top.location` | `background.js` navigation guard | Page told to `window.stop()`; you stay; notice. If it loaded anyway: tab goes back |
| Newsletter modal + dimmed backdrop on a heavy-popup site | `overlay.js` | Presses its close button, hides the backdrop, gives scrolling back; notice with **Undo** |
| Cookie bar with "Accept all" / "Reject all" | `overlay.js` | Presses **Reject all**, never Accept |
| "Turn off your ad blocker" wall with no close button | `overlay.js` | Hidden; scroll lock and blur removed |
| Invisible full-page link layer (click trap) | `overlay.js` | Hidden |
| Embedded player frame: invisible layer on `<body>`, ad frame or foreign link layer over the video | `overlay.js` inside that frame | Hidden; video, controls and the player's own click layer stay; notice in the page |
| Invisible layer over an embedded frame, in the page or in a wrapper frame | `overlay.js` | Hidden |
| Any empty layer whose own click handler opened a popup that got blocked | `guard-main.js` → `guard.js` → `overlay.js` | Hidden at once if invisible, after the second time if visible |
| Login box that opens right after you click "Log in" | nobody | Left open (it appeared within 1.5 s of your click) |
| You type a URL, use a bookmark, Back/Forward, reload | nobody | Always allowed |
| Domain on your "Always blocked" list | dynamic DNR redirect rule | `blocked.html?kind=blocklist` |

**How the worker tells "you" from "the page":** Chrome gives each top-level request an
`initiator`. Typed URLs, bookmarks and the extension's own `tabs.update()` have **no initiator**,
so they are always allowed. Anything with a web initiator was started by a page, and is compared
against the site the tab is showing.

## Data the extension stores

`chrome.storage.local` (kept on disk until cleared or uninstalled):

| Key | Shape | Written by |
|---|---|---|
| `settings` | `{ navMode, blockPopups, blockAds, blockTrackers, cosmetic, blockThirdPartyFrames, trustProviders, overlayMode, logLimit }` | `background.js` (`setSettings`, `resetAll`, install) |
| `lists` | `{ allowOutbound, trustedDestinations, paused, customBlock, overlaySites, overlayNever }` (arrays of sites) | `background.js` (`listOp`, `allowSource`, `continue`, `overlayPref`, learning) |
| `overlayCounts` | `{ "<site>": n }`: unsolicited on-screen popups seen per site, at most 2,000 sites | `background.js` `countOverlays()` |
| `log` | `[{ kind, url, site, from, fromSite, count, first, last }]`, newest first, at most 2,000 | `background.js` `logBlock()` |
| `stats` | `{ popup, navigation, link, blocklist, overlay, since }` | `background.js` `logBlock()` |

`chrome.storage.session` (cleared when the browser closes): `tabs` holds, per tab, the last committed
URL, the sites visited, the opener and a commit counter. The service worker can be stopped at any
time, so it keeps this state in session storage to pick up where it left off.

Only the service worker writes `settings`, `lists`, `log` and `stats`. Pages ask it with a
message, so two writers never overwrite each other.

## Default settings

| Setting | Default | Meaning |
|---|---|---|
| `navMode` | `'strict'` | `strict`: every link/redirect off the site asks first. `balanced`: links you click open. `off`: only popups blocked |
| `blockPopups` | `true` | Close/cancel cross-site popups and new tabs |
| `blockAds` | `true` | Enable the `ads` ruleset |
| `blockTrackers` | `true` | Enable the `trackers` ruleset |
| `cosmetic` | `true` | Hide ad containers |
| `blockThirdPartyFrames` | `false` | Extra strict: block every cross-site iframe except captcha/payment ones |
| `trustProviders` | `true` | Let sign-in and payment hosts open and send you back |
| `overlayMode` | `'auto'` | On-screen popups. `auto`: close them on sites in `overlaySites` (added by you, or learned after 3 popups). `everywhere`: on every site except `overlayNever`. `off`: only when you press the toolbar button |
| `logLimit` | `2000` | Maximum history entries |

## Messages to the service worker

| `type` | Sent by | Does |
|---|---|---|
| `blocked` | `guard.js` | Log a popup/link block, bump badge, show toast |
| `userGesture` | `guard.js` | Balanced mode: one-time permit for a link the user really clicked |
| `openOnce` | toast | Open the blocked URL once (new tab or same tab) |
| `allowSource` | toast | Add this page's site to `allowOutbound`, then open the URL |
| `overlaySeen` | `overlay.js` (learn mode) | Count unsolicited popups for this site; at 3, add it to `overlaySites` |
| `overlayClosed` | `overlay.js` (any frame) | Log one closed on-screen popup (the frame's address when it was in a frame), bump the badge; for a frame, show the notice in the page |
| `overlayUndo` | notice's **Undo** | Worker tells every frame of the tab to put back what it closed |
| `overlayPref` | notice's **Never on this site** | Move this site from `overlaySites` to `overlayNever` |
| `continue` | `blocked.html` | Open the destination; can also allow the source, trust the destination, or unblock it |
| `goBack` | `blocked.html` | Return the tab to the page it came from |
| `logBlocklistHit` | `blocked.html` | Record a visit to an always-blocked domain |
| `setSettings`, `listOp`, `clearLog`, `resetAll` | popup / options | Change settings or lists |

The last two groups only work from the extension's own pages (`isExtensionPage`). A web page can't
send them. Content-script messages can only affect the sender's own site.

The toolbar popup sends `closeOverlays` `{ tabId }`. The worker (`closeOverlaysInTab`) then sends
`closeOverlaysNow` to every frame of that tab, each `overlay.js` answers `{ closed: n }`, and the
worker returns the total.

## Dynamic network rules (built by `applyRules()`)

| id | When | Rule |
|---|---|---|
| 1 | `paused` not empty | `allowAllRequests` for paused sites (priority 100) |
| 2 | `customBlock` not empty | block every sub-request to those domains |
| 3 | `customBlock` not empty | redirect top-level visits to `blocked.html?kind=blocklist#<url>` |
| 4 | `blockThirdPartyFrames` | block third-party `sub_frame` except captcha/payment hosts |
| 5 | `blockThirdPartyFrames` | allow reCAPTCHA frames on google.com / recaptcha.net |
"""

# (heading, intro, [(path, notes)])
FILES = [
    ("Extension manifest", "", [
        ("extension/manifest.json", """\
This file tells Chrome what the extension is and what it may do.

- **`permissions`**: `declarativeNetRequest` (network blocking), `declarativeNetRequestFeedback`
  (the "requests blocked" count), `webNavigation` and `webRequest` (watching tabs and
  navigations, read-only), `storage`.
- **`host_permissions: <all_urls>`**: needed so content scripts run on every site and the worker
  can read tab URLs.
- **`declarative_net_request.rule_resources`**: the two static rulesets, `ads` and `trackers`, both on
  at install. `background.js` turns them on or off to match the settings.
- **`content_scripts`**: two entries, both `document_start`, `all_frames`, `match_about_blank`.
  The first runs `site.js → cosmetic.js → guard.js` in the isolated world (in that order, because
  `guard.js` uses the globals the first two define). The second runs `guard-main.js` in the **MAIN**
  world, which is the only way to wrap `window.open` before page scripts run.
- **`web_accessible_resources`**: `blocked.html` must be reachable from web pages, because a network
  rule redirects always-blocked domains to it.
"""),
    ]),
    ("Shared logic", "", [
        ("extension/src/lib/site.js", """\
Shared by the service worker (`importScripts`), the content scripts (first in the bundle) and the
extension pages (`<script>`). It defines a single frozen global, `self.StrictSite`.

- **`MULTI_LABEL_SUFFIXES`**: public suffixes with more than one label (`co.uk`, `co.in`,
  `github.io`, `vercel.app`, ...). `siteOf()` checks these before falling back to "last two labels".
- **`siteOf(urlOrHost)`**: returns the registered domain. IP addresses and single-label hosts
  (`localhost`) are their own site.
- **`TRUSTED_PROVIDERS`**: sign-in and payment hosts. Entries can carry a path with `*`, e.g.
  `www.facebook.com/*/dialog/oauth`, matched by `matchesEntry()`.
- **`DEFAULT_SETTINGS` / `DEFAULT_LISTS`**: the defaults. `withDefaults()` merges stored values over
  them, so a missing key never breaks anything.
- **`normalizeEntry()`**: turns what you type (`https://www.x.com/`) into `x.com`.
- **`decide({ fromUrl, toUrl, kind, settings, lists })`**: the rule itself. It checks, in order:
  not a web URL → same site → source paused → feature switched off → source allowed → destination
  trusted → provider (as destination or source) → **block**. It returns `{ allow, reason }`.
"""),
    ]),
    ("Service worker", "", [
        ("extension/src/background.js", """\
The only code that can close tabs, redirect them, change network rules and write storage.

**State**
- `config`: cached settings and lists, refreshed by `storage.onChanged`.
- `tabs`: per-tab `{ url, visited, opener, commits, openedAt, own }`, mirrored to
  `storage.session` by `saveTabs()`. `ready` waits for both caches to load after the worker restarts.
- `permits`: one-time allowances (`tabId → site → expiry`) created by **Open once**, **Continue**
  and Balanced-mode clicks.
- `lastDecision`: the last verdict for each tab, so `onCommitted` knows whether a page it sees
  committing was already allowed or is about to be replaced.

**Network rules**: `syncRules()` queues `applyRules()` so calls never overlap. `applyRules()` turns
the static rulesets on or off and rebuilds the dynamic rules (ids 1–5) from your lists.

**Navigation guard**: `webRequest.onBeforeRequest` for `main_frame` calls `onTopLevelRequest()`:
1. No initiator, or a browser/extension initiator → allowed (you started it).
2. Find the reference URL: what the tab shows now. For a brand-new or "young" popup tab, use its
   opener instead. Then `kind` is `'popup'`.
3. `decide()`, then permits, then the tab's own `visited` list (so Back/Forward to a site you
   already opened keeps working).
4. Block. Popups go to `closePopup()` (close the tab, log, badge, toast in the opener). In Balanced
   mode a popup first waits up to 250 ms for a late `userGesture` permit from your click.
5. Navigations go to `stopNavigation()`. It sends `stopNavigation` to the exact document the tab is
   showing (`documentId`, recorded in `onCommitted`), and `guard.js` calls `window.stop()` and shows
   the notice. In Balanced mode it stops quietly first; if your click's permit then arrives, it
   re-opens the URL (`openUrl`), otherwise it logs and shows the notice.
6. If the blocked page commits anyway (it won the race), `onCommitted` calls `recover()`:
   `tabs.goBack()`, then the notice on the page you return to. If back lands somewhere else
   (Chrome skips pages that redirected on their own), it opens the original page. A page that
   redirects again each time (3 recoveries in 15 s) gets `showInterstitial()` in normal windows; in
   private windows, where extension pages can't load, it's let through.

`showInterstitial()` (`blocked.html?from=…&to=…`) is now only that last resort.

**Popup backstop**: `onCreatedNavigationTarget` records the opener and, when the new tab's URL is
already known, closes cross-site popups immediately.

**Commit tracking**: `onCommitted` updates `tabs`. It also re-checks navigations the request
listener never saw, such as pages served by a site's own service worker.

**On-screen popups**: `countOverlays()` adds to `overlayCounts[site]` through a queue, so counts
from several tabs don't overwrite each other. At `OVERLAY_LEARN_AT` (3) it adds the site to
`overlaySites`, unless the site is on `overlayNever`. `overlayClosed` logs a `kind: 'overlay'`
history entry (with the frame's address when it came from a frame) and, for a frame, shows the
notice in the page. `closeOverlaysInTab()` sends `closeOverlaysNow` to every frame
(`webNavigation.getAllFrames`) and adds up the answers.

**History**: `logBlock()` merges repeats (same kind + URL + source site → `count += times`), keeps the
newest first, trims to `logLimit`, and limits each tab to 40 entries a minute so a spammy page
can't flood the history.

**Messages**: `handleMessage()` handles everything in the message table in Part 1. Privileged
messages require `isExtensionPage(sender)`.
"""),
    ]),
    ("Content scripts", "", [
        ("extension/src/content/guard-main.js", """\
Runs in the page's own JavaScript world, before any of the page's scripts. It holds no settings
and makes no decisions. It intercepts the calls that open popups and asks `guard.js`.

- It saves the native functions (`dispatchEvent`, `URL`, property getters) at startup, so the page
  can't fake them later.
- **`allowed(url)`** dispatches a `__strictshield_q` CustomEvent. `guard.js` answers
  synchronously with `__strictshield_r` (`'allow'` / `'block'`). If no answer comes back (for example
  after the extension was reloaded), the call is allowed and the worker remains the safety net.
- **`listenerElement()`**: while a click event is being handled, `window.event.currentTarget` is the
  element whose own listener is running. The question is dispatched **on that element** (it bubbles
  to `window`, where `guard.js` listens), so `guard.js` learns which element opened the popup.
  Listeners on `document` or `window` give no element: any click reaches those, so they prove
  nothing about the element clicked.
- It wraps `window.open` with a `Proxy`, so the function still looks native. It also patches the
  `contentWindow` / `contentDocument` getters, so a freshly created iframe's `window.open` is
  wrapped before the page can use it.
- It wraps `HTMLElement.prototype.click`, `EventTarget.prototype.dispatchEvent` and
  `HTMLFormElement.prototype.submit`. These only act on **detached** `<a target=_blank>` elements and
  `target`-ed forms, the classic popunder tricks. Clicks on links inside the page reach `guard.js`
  normally.
"""),
        ("extension/src/content/guard.js", """\
Runs in the extension's isolated world in every frame.

- **`topUrl` / `topSite`**: rules always use the **top** page's site. Inside iframes it reads
  `location.ancestorOrigins`.
- **`popupAllowed()`**: the answer to `guard-main.js`. `about:blank` is allowed (the worker watches
  where it goes), `javascript:` and `data:` are blocked, `blob:` uses its origin, and other schemes
  (`mailto:`) are allowed.
- **Click guard** (`click` + `auxclick`, capture phase on `window`, so it runs before page
  handlers): it finds the link in `composedPath()` (works in shadow DOM and on SVG links) and works
  out whether the click opens a new tab. Middle-click, ctrl, cmd, shift, `target="_blank"` and
  `<base target>` count; a named target that is an existing iframe does not. If `decide()` says no,
  it calls `preventDefault()` and reports. In Balanced mode, real (`isTrusted`) same-tab clicks and
  modifier clicks send a `userGesture` permit instead.
- **`contextmenu`**: in Balanced mode, a right-click on a link grants a 30-second permit, so "Open
  link in new tab" works.
- **`submit`**: blocks `target="_blank"` forms to other sites.
- **`navigate`** (Navigation API, top frame): cancels page-initiated navigations of this tab to
  another site, such as `location.href = …`, meta refresh and same-tab form posts, before they
  leave the page. It skips back/forward, reloads, hash changes and downloads, and (in Balanced mode)
  navigations you started yourself (`userInitiated`). Server redirects and cross-origin frames
  never fire this event; the worker handles those.
- **`stopNavigation` message**: from the worker. It calls `window.stop()` to cancel a navigation
  already on its way, and shows the notice.
- **Cosmetic**: adds one `<style>` built from `StrictCosmetic`, and a `MutationObserver` puts it
  back if a page removes it.
- **Toast** (top frame only): a closed shadow root, so page CSS and scripts can't reach it. Repeats
  of the same site are grouped with a `×N` badge, at most 3 toasts show, and they auto-hide after
  10 s. The buttons check `isTrusted`, so a page can't click them itself. For `kind: 'overlay'`
  (from `overlay.js`, or relayed by the worker for a frame) the buttons are **Undo** and **Never on
  this site**; both go through the worker so every frame is reached.
- **Blocked-click evidence**: when a popup is blocked, the element the question came from (or the
  link that was clicked) is passed to `onBlockedClick` listeners.
- **`self.StrictShieldContent`**, in every frame: what `overlay.js` uses: `isTop`, `config()`,
  `onConfig()`, `onBlockedClick()`, `send()`, `topSite`, and in the top frame `toast()` and `isOwn()`
  (so the toast is never treated as a popup).
"""),
        ("extension/src/content/overlay.js", """\
The on-screen popup closer. It runs in every frame, after `guard.js`, and uses
`self.StrictShieldContent` for settings, the notice and blocked-click evidence. Page-level popups
(modals, backdrops, banners) are only looked for in the top frame; layers over players in every
frame. Captcha, payment and sign-in frames, and frames under 200×120 px, are skipped.

- **`mode()`**: `'close'` on sites in `overlaySites` (or every site in `everywhere` mode), `'learn'`
  elsewhere in `auto` mode, `'off'` for paused or `overlayNever` sites, or when the setting is off.
- **Finding popups (`findPopups`)**: `document.elementsFromPoint` at 5 points in the middle and 5
  near the edges. `fixedRoot()` walks up to the outermost `position: fixed` element (or a modal
  `<dialog>`). In the middle it must sit on top of real content, which rules out decorative fixed
  backgrounds.
- **`classify()`**: returns `backdrop` (full-screen with almost no content: dim layers and invisible
  click traps), `modal` (over the middle), `banner` (an edge bar with popup words such as cookie,
  newsletter, notification, ad block, "% off", without nav or many links), or `null`. It never
  touches the site's own layout (more than half of the page's elements), fullscreen video, or layers
  holding captcha, payment or sign-in iframes.
- **`openedByYou()`**: the observer records when each element was added or restyled (`changedAt`).
  If you pressed a button, link or key in the 1.5 s before that, the popup is yours and stays.
- **`close()`**: `dialog.close()` for dialogs. Otherwise `findCloseButton()` scores candidates:
  exact close text (`×`, "No thanks", "Reject all"...) beats `aria-label`/`title` hints, which
  beat `data-dismiss` and `close` classes. A button in the top-right corner scores higher. Accept,
  Subscribe, Sign up and similar are skipped, and links to other pages are never followed. Then it
  tries Escape, then `display: none !important`. If a page keeps re-showing a popup, it gives up
  after 5 tries.
- **`restorePage()`**: undoes scroll locks that weren't there at `DOMContentLoaded`, and blur
  filters on the page's top-level elements.
- **`scan()`**: up to 4 rounds, because closing a modal often reveals its backdrop or a cookie bar.
  In learn mode it only reports new popups (`overlaySeen`). Each closed popup is logged
  immediately (`overlayClosed`), then one notice is shown with **Undo** and **Never on this site**.
- **`players()`**: visible `<video>` and `<iframe>` elements of at least 200×120 px. In the top
  frame, the 6 largest. In a frame, only its main content (a video filling 30% or more of the frame,
  else such a nested frame, else the frame's own viewport).
- **`findCovers()`**: for each player, `elementsFromPoint` at 5 points inside it. Everything painted
  above the player there is traced up to its layer (`layerOf`: the highest ancestor that doesn't
  also hold the player) and judged by `classifyCover()`:
  `adframe` (another frame over a video inside a player frame, unless captcha/payment/sign-in or
  the IMA ad-controls frame), `adlink` (a link layer to a site that is neither the frame's nor the
  page's, covering enough of the player), `trap` (bare and invisible, covering 70% or more: over an
  embedded frame always, over a video only with `z-index` ≥ 9999 or attached to `<body>` in a
  frame). Layers with controls, media or a player-like class/id (`PLAYER_NAME`) return `null`.
- **`onBlockedClick`**: proof from a blocked popup. From the element that opened it, climb while
  the ancestors are bare; the outermost one that is positioned and lies over half the frame or 60%
  of a player is the trap. Invisible: hidden at once. Visible: after the second time. Visible
  links: never.
- **Frames and the notice**: a frame can't show a notice, so the worker shows it in the page when
  it receives `overlayClosed` from a frame. **Undo** is broadcast to every frame (`overlayUndo`).
- **When it scans**: in close mode, a `MutationObserver` (at most every 600 ms, 1 s in frames); in
  every mode, timed checks from 0.8 s to 60 s after load, on scroll, and when the mouse leaves the
  page (exit intent). Not while a mouse button is held, so drag shields aren't judged. It also
  answers `closeOverlaysNow`, which skips the "opened by you" check.
"""),
        ("extension/src/content/cosmetic.js", """\
Defines `self.StrictCosmetic`, the list of CSS selectors `guard.js` hides. It is kept narrow on
purpose. Broad patterns like `[class*="ad"]` would hide `header`/`download`/`shadow` elements and set
off anti-adblock checks. To hide more, add a selector here and reload the extension.
"""),
    ]),
    ("Filter lists and the rule builder", """\
Edit the `.txt` files, then run `node tools/build-rules.mjs` to regenerate the JSON that Chrome reads.
""", [
        ("filters/ads.txt", "Ad servers, exchanges, verification, native-ad widgets and popup/popunder networks, plus two `prebid` path rules."),
        ("filters/trackers.txt", "Analytics, session recording and data brokers. The `||…` lines block only specific paths (Facebook pixel, GA4 collect, Reddit pixel) so the rest of those sites keeps working."),
        ("tools/build-rules.mjs", """\
- `parseList()` accepts plain domains, Adblock Plus `||domain^` (with options) and `||`/`/` path
  rules. It skips comments, cosmetic (`##`) and exception (`@@`) rules. It also drops domains whose
  parent domain is already listed.
- `toRules()` puts **all domains into one rule** (`requestDomains`), which keeps the rule count tiny.
  Each path filter becomes its own `urlFilter` rule. The trackers list also gets a rule that blocks
  third-party `ping` requests.
- `--import file --into ads|trackers` adds the domain rules from a large list such as EasyList to
  a `.txt` file.
"""),
        ("extension/rules/ads.json", "Generated by `build-rules.mjs`. Don't edit by hand."),
        ("extension/rules/trackers.json", "Generated by `build-rules.mjs`. Don't edit by hand."),
    ]),
    ("Extension pages", "", [
        ("extension/pages/common.css", "Shared design tokens (light and dark through `prefers-color-scheme`), buttons, switches, pills and the segmented control used by every page."),
        ("extension/pages/ui.js", "Small helpers for the popup and options pages: `UI.send()` (a message that throws on `{error}`), `UI.h()` (builds DOM elements without `innerHTML`, so URLs are never treated as HTML), `UI.timeAgo()` and the kind labels."),
        ("extension/pages/popup.html", "The toolbar popup: the current site, two counters, four controls (protection, let this site open other sites, auto-close on-screen popups, Strict/Balanced), the **Close popups on this page now** button and the last five blocks on this site."),
        ("extension/pages/popup.js", """\
- Reads the active tab. On browser pages (`chrome://…`) it shows the "doesn't run here" card.
- **Requests blocked on this tab** comes from `declarativeNetRequest.getMatchedRules({ tabId })`.
- Switching **Protection** off adds the site to `paused` and reloads the tab, because pause takes
  effect on the next page load.
- **Auto-close on-screen popups**: on adds the site to `overlaySites` and removes it from
  `overlayNever`; off does the opposite, so learning won't turn it back on.
- **Close popups on this page now** sends `closeOverlays` to the worker, which asks every frame of
  the tab. If anything was closed and the mode is `auto`, the site is added to `overlaySites`.
- It re-renders on every `storage.onChanged`, so it stays live while open.
"""),
        ("extension/pages/options.html", "Settings, with four tabs selected by URL hash (`#protection`, `#lists`, `#history`, `#how`). Section ids are `sec-…` so the browser doesn't scroll to them."),
        ("extension/pages/options.js", """\
- **Protection**: each `data-setting` checkbox sends `setSettings`. The radio groups set `navMode`
  and `overlayMode`.
- **Lists**: six editors generated from `LISTS`, including the two on-screen popup lists. Add accepts several entries separated by spaces or
  commas. The worker normalises them (to sites, for `allowOutbound` and `paused`).
- **History**: summary cards from `stats`, a filter box, a type filter, 100 rows at a time,
  per-row **Always block** / **Allow site** (or **Never close here** for on-screen popups),
  **Export JSON** and **Clear history**.
"""),
        ("extension/pages/blocked.html", "The last-resort blocked page: shown only when a page keeps redirecting each time it's sent back (normal windows only), or when you visit an always-blocked domain."),
        ("extension/pages/blocked.css", "Layout for the blocked page card."),
        ("extension/pages/blocked.js", """\
- `kind=navigation` (from the navigation guard) reads `from` and `to` from the query string.
  `kind=blocklist` (from the DNR redirect) reads the URL from the hash, because a
  `regexSubstitution` can't URL-encode.
- It shows "Blocked N times so far" from the saved `log`. This is the "remember" requirement
  showing up in the UI.
- None of the buttons navigate the page directly. They ask the worker (`continue`, `goBack`), so
  the navigation has no web initiator and the guard lets it through.
"""),
    ]),
    ("Build, package and icons", "", [
        ("tools/package.sh", "Rebuilds the rules and zips `extension/` into `dist/strict-shield-<version>.zip`. It leaves out `.DS_Store` and `_metadata/`, which Chrome writes when you load the folder unpacked and which the Web Store rejects."),
        ("tools/make-icons.py", "Draws the red shield with a white bar at 1024 px and scales it down to 16/32/48/128 px with Pillow. It also writes `store/store-icon-128.png`."),
        ("tools/build-notes.py", "This file's generator. It reads every source file and writes `NOTES_WITH_CODE.md`."),
        ("package.json", "Only scripts and the `puppeteer` dev dependency for the tests. The extension itself has no dependencies."),
        (".gitignore", ""),
    ]),
    ("Tests", "", [
        ("test/server.mjs", """\
One HTTP server that plays several sites. Chrome is started with `--host-resolver-rules`, so
`site-a.test`, `site-b.test`, `site-c.test`, `doubleclick.net` and `www.google-analytics.com` all
resolve to `127.0.0.1`, and the server routes on the `Host` header. `site-a.test/` has one button
or link for each popup trick. `OVERLAY_PAGES` (`/overlay`, `/overlay-plain`, `/user-modal`, `/trap`,
`/dialog`) imitate heavy-popup sites on any `*.test` host. `/embed-host` embeds `/player` (a video
with its own click layer and control bar, plus per-case layers on top) or `/wrapper` (a frame
whose player is one frame deeper) from another site. `static.site-c.test/widget.js` is a
third-party script blocked only by your custom list; its name avoids "ad" so a browser's own
blocker (e.g. Brave Shields) can't interfere.
"""),
        ("test/run.mjs", """\
Starts Chromium with the unpacked extension (`enableExtensions`), waits for the service worker to
finish installing, then runs 48 cases in groups: network and cosmetic, the same-site rule, popups,
memory, Balanced mode, lists, on-screen popups, embedded players. `deepText()` reads closed shadow
roots through the DevTools protocol to check the toast, and `clickInShadow()` presses its buttons. `setConfig()` writes storage from inside the worker, then waits for
`rulesChain` so the network rules are updated before the next page loads. A
240-second deadline kills the run if the browser hangs.
"""),
        ("test/screenshots.mjs", "Generates the 1280×800 store screenshots and the popup image in `store/`. Use `THEME=dark` for dark ones."),
    ]),
]

PART3 = """
# Part 3: Publishing checklist

1. `bash tools/package.sh` → `dist/strict-shield-<version>.zip`
2. Host `PRIVACY.md` publicly and fill in your support email.
3. Developer Dashboard → New item → upload the zip.
4. Paste the listing, single purpose, permission justifications and data-usage answers from
   `store/STORE_LISTING.md`. Upload the icon and the screenshots from `store/`.
5. Submit. Expect an in-depth review because of `<all_urls>`.
6. For each update: bump `version` in `manifest.json`, re-package, upload.

Known limits are listed at the end of [README.md](README.md#known-limits).
"""


def slug(title):
    s = title.strip().lower()
    s = re.sub(r"[^\w\- ]", "", s)
    return s.replace(" ", "-")


def fence_for(text):
    longest = max((len(m) for m in re.findall(r"`+", text)), default=0)
    return "`" * max(3, longest + 1)


def main():
    out = [INTRO.format(today=date.today().isoformat())]

    toc = ["## Contents", "", "- [Part 1: How it fits together](#part-1-how-it-fits-together)",
           "- [Part 2: Every file with its code](#part-2-every-file-with-its-code)"]
    n = 0
    for heading, _, files in FILES:
        toc.append(f"  - {heading}")
        for path, _ in files:
            n += 1
            title = f"2.{n} {path}"
            toc.append(f"    - [{path}](#{slug(title)})")
    toc.append("- [Part 3: Publishing checklist](#part-3-publishing-checklist)")
    out.append("\n".join(toc) + "\n")

    out.append(PART1)
    out.append("\n# Part 2: Every file with its code\n")
    n = 0
    total_lines = 0
    for heading, intro, files in FILES:
        out.append(f"\n## {heading}\n")
        if intro:
            out.append(intro)
        for path, notes in files:
            n += 1
            src = (ROOT / path).read_text(encoding="utf-8")
            lines = src.count("\n") + (0 if src.endswith("\n") else 1)
            total_lines += lines
            lang = LANG.get(Path(path).suffix, "")
            fence = fence_for(src)
            out.append(f"\n### 2.{n} {path}\n")
            out.append(f"[Open file]({path.replace(' ', '%20')}) · {lines} lines\n")
            if notes:
                out.append("\n" + notes.strip() + "\n")
            out.append(f"\n{fence}{lang}\n{src.rstrip()}\n{fence}\n")
    out.append(PART3)

    OUT.write_text("\n".join(out), encoding="utf-8")
    print(f"wrote {OUT.name}: {n} files, {total_lines} lines of code")


if __name__ == "__main__":
    main()
