# Strict Shield: notes with full source code

These notes go with the code. Part 1 explains how the extension works as a whole. Part 2 goes
through every file: what it does and how it connects to the others, followed by the file's full
code. Short guides are in [README.md](README.md), [PRIVACY.md](PRIVACY.md) and
[store/STORE_LISTING.md](store/STORE_LISTING.md).

_Generated 2026-11-12 by `python3 tools/build-notes.py`. Re-run it after you change any file._

## Contents

- [Part 1: How it fits together](#part-1-how-it-fits-together)
- [Part 2: Every file with its code](#part-2-every-file-with-its-code)
  - Extension manifest
    - [extension/manifest.json](#21-extensionmanifestjson)
  - Shared logic
    - [extension/src/lib/site.js](#22-extensionsrclibsitejs)
  - Service worker
    - [extension/src/background.js](#23-extensionsrcbackgroundjs)
  - Content scripts
    - [extension/src/content/guard-main.js](#24-extensionsrccontentguard-mainjs)
    - [extension/src/content/guard.js](#25-extensionsrccontentguardjs)
    - [extension/src/content/overlay.js](#26-extensionsrccontentoverlayjs)
    - [extension/src/content/cosmetic.js](#27-extensionsrccontentcosmeticjs)
  - Filter lists and the rule builder
    - [filters/ads.txt](#28-filtersadstxt)
    - [filters/trackers.txt](#29-filterstrackerstxt)
    - [tools/build-rules.mjs](#210-toolsbuild-rulesmjs)
    - [extension/rules/ads.json](#211-extensionrulesadsjson)
    - [extension/rules/trackers.json](#212-extensionrulestrackersjson)
  - Extension pages
    - [extension/pages/common.css](#213-extensionpagescommoncss)
    - [extension/pages/ui.js](#214-extensionpagesuijs)
    - [extension/pages/popup.html](#215-extensionpagespopuphtml)
    - [extension/pages/popup.js](#216-extensionpagespopupjs)
    - [extension/pages/options.html](#217-extensionpagesoptionshtml)
    - [extension/pages/options.js](#218-extensionpagesoptionsjs)
    - [extension/pages/blocked.html](#219-extensionpagesblockedhtml)
    - [extension/pages/blocked.css](#220-extensionpagesblockedcss)
    - [extension/pages/blocked.js](#221-extensionpagesblockedjs)
  - Build, package and icons
    - [tools/package.sh](#222-toolspackagesh)
    - [tools/make-icons.py](#223-toolsmake-iconspy)
    - [tools/build-notes.py](#224-toolsbuild-notespy)
    - [package.json](#225-packagejson)
    - [.gitignore](#226-gitignore)
  - Tests
    - [test/server.mjs](#227-testservermjs)
    - [test/run.mjs](#228-testrunmjs)
    - [test/screenshots.mjs](#229-testscreenshotsmjs)
- [Part 3: Publishing checklist](#part-3-publishing-checklist)


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


# Part 2: Every file with its code


## Extension manifest


### 2.1 extension/manifest.json

[Open file](extension/manifest.json) · 64 lines


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


```json
{
  "manifest_version": 3,
  "name": "Strict Shield: Ad & Popup Blocker",
  "short_name": "Strict Shield",
  "version": "1.0.0",
  "description": "Strict ad, tracker and popup blocker. Pages can only open their own site; cross-site popups and redirects are blocked.",
  "minimum_chrome_version": "116",
  "homepage_url": "https://github.com/HarsimarSingh23/strict-shield",
  "icons": {
    "16": "icons/icon16.png",
    "32": "icons/icon32.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "action": {
    "default_title": "Strict Shield",
    "default_popup": "pages/popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "32": "icons/icon32.png"
    }
  },
  "options_page": "pages/options.html",
  "background": {
    "service_worker": "src/background.js"
  },
  "permissions": [
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "storage",
    "webNavigation",
    "webRequest"
  ],
  "host_permissions": ["<all_urls>"],
  "declarative_net_request": {
    "rule_resources": [
      { "id": "ads", "enabled": true, "path": "rules/ads.json" },
      { "id": "trackers", "enabled": true, "path": "rules/trackers.json" }
    ]
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["src/lib/site.js", "src/content/cosmetic.js", "src/content/guard.js", "src/content/overlay.js"],
      "run_at": "document_start",
      "all_frames": true,
      "match_about_blank": true
    },
    {
      "matches": ["<all_urls>"],
      "js": ["src/content/guard-main.js"],
      "run_at": "document_start",
      "all_frames": true,
      "match_about_blank": true,
      "world": "MAIN"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["pages/blocked.html", "pages/blocked.js", "pages/blocked.css", "pages/common.css"],
      "matches": ["<all_urls>"]
    }
  ]
}
```


## Shared logic


### 2.2 extension/src/lib/site.js

[Open file](extension/src/lib/site.js) · 208 lines


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


```javascript
/*
 * Shared helpers: "same site" detection, allow/trust lists and the single
 * decision function used by both the service worker and content scripts.
 *
 * Loaded as a classic script (importScripts in the worker, listed first in the
 * content script bundle) and exposed as self.StrictSite.
 */
(function (root) {
  'use strict';

  // Multi-label public suffixes. A "site" is one label + its public suffix,
  // e.g. news.bbc.co.uk -> bbc.co.uk, user.github.io -> user.github.io.
  // Not the full Public Suffix List, but covers the suffixes people meet daily.
  const MULTI_LABEL_SUFFIXES = new Set(`
    co.uk org.uk me.uk ltd.uk plc.uk net.uk ac.uk gov.uk sch.uk nhs.uk police.uk
    co.in net.in org.in firm.in gen.in ind.in ac.in edu.in res.in gov.in nic.in mil.in
    com.au net.au org.au edu.au gov.au asn.au id.au
    co.nz org.nz net.nz govt.nz ac.nz geek.nz
    co.jp ne.jp or.jp ac.jp go.jp gr.jp ed.jp lg.jp
    co.kr or.kr ne.kr go.kr ac.kr re.kr
    com.cn net.cn org.cn gov.cn edu.cn ac.cn
    com.hk net.hk org.hk edu.hk gov.hk
    com.tw net.tw org.tw edu.tw gov.tw
    com.sg net.sg org.sg edu.sg gov.sg
    com.my net.my org.my edu.my gov.my
    co.id or.id ac.id go.id web.id net.id my.id
    co.th in.th ac.th go.th or.th
    com.ph net.ph org.ph gov.ph edu.ph
    com.vn net.vn org.vn edu.vn gov.vn
    com.pk net.pk org.pk edu.pk gov.pk
    com.bd net.bd org.bd edu.bd gov.bd
    com.lk org.lk edu.lk gov.lk
    com.np org.np edu.np gov.np
    com.br net.br org.br gov.br edu.br art.br blog.br
    com.ar net.ar org.ar gob.ar edu.ar
    com.mx net.mx org.mx gob.mx edu.mx
    com.co net.co org.co gov.co edu.co
    com.pe net.pe org.pe gob.pe com.ve
    co.za org.za net.za gov.za ac.za web.za
    com.ng org.ng gov.ng edu.ng
    co.ke or.ke go.ke ac.ke
    com.eg gov.eg edu.eg
    com.sa gov.sa edu.sa net.sa org.sa
    co.ae gov.ae ac.ae net.ae org.ae
    co.il org.il ac.il gov.il net.il
    com.tr net.tr org.tr gov.tr edu.tr gen.tr
    com.ua net.ua org.ua gov.ua in.ua
    com.pl net.pl org.pl gov.pl edu.pl
    com.es org.es nom.es gob.es edu.es
    com.pt org.pt gov.pt com.gr gov.gr edu.gr gouv.fr
    github.io githubusercontent.com gitlab.io blogspot.com wordpress.com
    herokuapp.com vercel.app netlify.app pages.dev workers.dev web.app
    firebaseapp.com appspot.com azurewebsites.net cloudfront.net onrender.com
    fly.dev glitch.me replit.app surge.sh ngrok.io ngrok-free.app
    myshopify.com wixsite.com weebly.com translate.goog duckdns.org
  `.trim().split(/\s+/));

  // Sign-in and payment hosts. They are allowed as destinations (so "Sign in
  // with Google" and checkout popups work) and as sources (so they can send
  // you back to the site you came from). Toggle with settings.trustProviders.
  const TRUSTED_PROVIDERS = [
    'accounts.google.com', 'accounts.youtube.com', 'pay.google.com',
    'login.microsoftonline.com', 'login.live.com', 'login.microsoft.com',
    'appleid.apple.com', 'idmsa.apple.com',
    'github.com/login', 'github.com/sessions',
    'www.facebook.com/dialog/oauth', 'www.facebook.com/*/dialog/oauth',
    'paypal.com', 'checkout.stripe.com', 'hooks.stripe.com',
    'api.razorpay.com', 'checkout.razorpay.com',
    'paytm.in', 'paytm.com', 'phonepe.com', 'secure.payu.in', 'billdesk.com',
    'ccavenue.com', 'cashfree.com', 'challenges.cloudflare.com'
  ];

  const DEFAULT_SETTINGS = Object.freeze({
    navMode: 'strict',            // 'strict' | 'balanced' | 'off'
    blockPopups: true,
    blockAds: true,
    blockTrackers: true,
    cosmetic: true,
    blockThirdPartyFrames: false,
    trustProviders: true,
    overlayMode: 'auto',          // on-screen popups: 'auto' | 'everywhere' | 'off'
    logLimit: 2000
  });

  const DEFAULT_LISTS = Object.freeze({
    allowOutbound: [],        // sites allowed to open/redirect to any site
    trustedDestinations: [],  // destinations any site may open
    paused: [],               // sites with all protection off
    customBlock: [],          // domains blocked everywhere
    overlaySites: [],         // sites where on-screen popups are closed (added or learned)
    overlayNever: []          // sites where on-screen popups are never touched
  });

  function parse(url) {
    try { return new URL(url); } catch { return null; }
  }

  function isWeb(url) {
    const u = typeof url === 'string' ? parse(url) : url;
    return !!u && (u.protocol === 'http:' || u.protocol === 'https:');
  }

  function hostOf(url) {
    const u = parse(url);
    if (!u) return '';
    if (u.protocol === 'blob:') return hostOf(u.origin);
    return u.hostname.toLowerCase().replace(/\.$/, '');
  }

  function isIp(host) {
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[');
  }

  // Registrable domain ("site") of a host or URL.
  function siteOf(urlOrHost) {
    if (!urlOrHost) return '';
    const host = urlOrHost.includes('/') || urlOrHost.includes(':')
      ? hostOf(urlOrHost)
      : String(urlOrHost).toLowerCase().replace(/\.$/, '');
    if (!host) return '';
    if (isIp(host) || !host.includes('.')) return host;
    const labels = host.split('.');
    for (let k = Math.min(3, labels.length - 1); k >= 2; k--) {
      if (MULTI_LABEL_SUFFIXES.has(labels.slice(-k).join('.'))) {
        return labels.slice(-(k + 1)).join('.');
      }
    }
    return labels.slice(-2).join('.');
  }

  function sameSite(a, b) {
    const sa = siteOf(a);
    return !!sa && sa === siteOf(b);
  }

  // Normalises what a user types into a list ("https://www.x.com/" -> "x.com").
  function normalizeEntry(value, { keepPath = false } = {}) {
    let v = String(value || '').trim().toLowerCase();
    if (!v) return '';
    v = v.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '');
    if (!keepPath) v = v.split('/')[0];
    return v.replace(/\/+$/, '').split('?')[0].split('#')[0];
  }

  function globToRegExp(glob) {
    const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp('^' + escaped);
  }

  // Entry is "host" or "host/path-prefix" (path may contain *). A host entry
  // also matches its subdomains.
  function matchesEntry(url, entry) {
    const u = parse(url);
    if (!u || !entry) return false;
    const host = u.hostname.toLowerCase();
    const slash = entry.indexOf('/');
    const entryHost = slash === -1 ? entry : entry.slice(0, slash);
    const hostOk = host === entryHost || host.endsWith('.' + entryHost)
      || (entryHost.startsWith('www.') && host === entryHost.slice(4));
    if (!hostOk) return false;
    if (slash === -1) return true;
    return globToRegExp(entry.slice(slash)).test(u.pathname);
  }

  function matchesAny(url, entries) {
    return !!url && Array.isArray(entries) && entries.some((e) => matchesEntry(url, e));
  }

  function isTrustedProvider(url, settings) {
    return !!(settings && settings.trustProviders) && matchesAny(url, TRUSTED_PROVIDERS);
  }

  /*
   * The one rule of this extension: a page may only open its own site.
   *   kind: 'popup'      new tab / window opened by a page
   *         'navigation' a page sending its own tab to a different site
   * Returns { allow: boolean, reason: string }.
   */
  function decide({ fromUrl, toUrl, kind, settings, lists }) {
    settings = settings || DEFAULT_SETTINGS;
    lists = lists || DEFAULT_LISTS;
    const fromSite = siteOf(fromUrl);
    const toSite = siteOf(toUrl);
    if (!fromSite || !toSite) return { allow: true, reason: 'not-web' };
    if (fromSite === toSite) return { allow: true, reason: 'same-site' };
    if (lists.paused.includes(fromSite)) return { allow: true, reason: 'paused' };
    if (kind === 'popup' && !settings.blockPopups) return { allow: true, reason: 'popups-off' };
    if (kind === 'navigation' && settings.navMode === 'off') return { allow: true, reason: 'nav-off' };
    if (lists.allowOutbound.includes(fromSite)) return { allow: true, reason: 'source-allowed' };
    if (matchesAny(toUrl, lists.trustedDestinations)) return { allow: true, reason: 'trusted-destination' };
    if (isTrustedProvider(toUrl, settings)) return { allow: true, reason: 'provider' };
    if (isTrustedProvider(fromUrl, settings)) return { allow: true, reason: 'from-provider' };
    return { allow: false, reason: 'cross-site' };
  }

  function withDefaults(settings, lists) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings || {});
    const l = Object.assign({}, DEFAULT_LISTS, lists || {});
    for (const key of Object.keys(DEFAULT_LISTS)) if (!Array.isArray(l[key])) l[key] = [];
    return { settings: s, lists: l };
  }

  root.StrictSite = Object.freeze({
    DEFAULT_SETTINGS, DEFAULT_LISTS, TRUSTED_PROVIDERS,
    parse, isWeb, hostOf, siteOf, sameSite, normalizeEntry,
    matchesEntry, matchesAny, isTrustedProvider, decide, withDefaults
  });
})(typeof self !== 'undefined' ? self : globalThis);
```


## Service worker


### 2.3 extension/src/background.js

[Open file](extension/src/background.js) · 684 lines


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


```javascript
/*
 * Strict Shield service worker.
 *
 * Three layers of blocking:
 *   1. Network filtering  – declarativeNetRequest rulesets (rules/*.json) plus
 *                           dynamic rules built from the user's lists.
 *   2. Popup guard        – cross-site tabs/windows opened by a page are closed.
 *   3. Navigation guard   – a page sending its own tab to another site is
 *                           stopped where it is (the page stays, a notice
 *                           offers "Open once"); if it slips through, the tab
 *                           goes back. pages/blocked.html is only a last resort,
 *                           and never in private windows, where an extension's
 *                           own pages can't load.
 *   4. On-screen popups   – content/overlay.js closes them; this worker logs
 *                           them and learns which sites are heavy on popups.
 * Content scripts stop most popups before they open; this worker is the
 * backstop that also catches what they cannot see.
 */
importScripts('lib/site.js');

const S = self.StrictSite;
const BLOCKED_PAGE = chrome.runtime.getURL('pages/blocked.html');
const EXTENSION_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;

const RULE = { PAUSED: 1, CUSTOM_BLOCK: 2, CUSTOM_BLOCK_PAGE: 3, THIRD_PARTY_FRAMES: 4, CAPTCHA_FRAMES: 5 };
const FRAME_EXCEPTIONS = [
  'recaptcha.net', 'hcaptcha.com', 'challenges.cloudflare.com', 'stripe.com',
  'razorpay.com', 'paypal.com', 'accounts.google.com', 'appleid.apple.com'
];
// Navigations the user started from browser UI; never blocked.
const USER_TRANSITIONS = new Set([
  'typed', 'auto_bookmark', 'generated', 'keyword', 'keyword_generated',
  'start_page', 'reload', 'auto_toplevel'
]);
const SITE_LISTS = ['allowOutbound', 'paused', 'overlaySites', 'overlayNever'];
const OVERLAY_LEARN_AT = 3; // unsolicited on-screen popups before a site is learned
const PERMIT_MS = 8000;
const BALANCED_GRACE_MS = 250;

/* ------------------------------------------------------------------ state */

let config = S.withDefaults();
const configReady = chrome.storage.local.get(['settings', 'lists'])
  .then(({ settings, lists }) => { config = S.withDefaults(settings, lists); });

// tabId -> { url, documentId, visited: [site], opener: {tabId, url} | null, commits, openedAt, own }
// Mirrored to storage.session so it survives the worker being suspended.
const tabs = new Map();
const tabsReady = chrome.storage.session.get('tabs').then(({ tabs: saved }) => {
  for (const [id, t] of Object.entries(saved || {})) if (!tabs.has(+id)) tabs.set(+id, t);
});
const ready = Promise.all([configReady, tabsReady]);

let saveTimer = 0;
function saveTabs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    chrome.storage.session.set({ tabs: Object.fromEntries(tabs) }).catch(() => {});
  }, 200);
}

function tabState(tabId) {
  let t = tabs.get(tabId);
  if (!t) { t = { url: '', visited: [], opener: null, commits: 0, openedAt: Date.now(), own: false }; tabs.set(tabId, t); }
  return t;
}

// One-shot allowances: tabId -> Map(site -> expiry). Created by "Open once",
// "Continue", and (in balanced mode) real user clicks.
const permits = new Map();
const trustedRequests = new Set();   // webRequest requestIds allowed by a permit
const lastDecision = new Map();      // tabId -> { site, allow, from?, to?, recovering? }
const recovering = new Map();        // tabId -> { from, to, tries } while undoing a blocked navigation
const recoveries = new Map();        // tabId -> recent recover() times, to spot redirect loops
const closing = new Set();           // popup tabIds already being closed

function addPermit(tabId, site, ms = PERMIT_MS) {
  if (tabId < 0 || !site) return;
  if (!permits.has(tabId)) permits.set(tabId, new Map());
  permits.get(tabId).set(site, Date.now() + ms);
}

function hasPermit(tabId, site) {
  const until = permits.get(tabId)?.get(site);
  return !!until && until > Date.now();
}

function waitForPermit(tabId, site, ms) {
  const end = Date.now() + ms;
  return new Promise((resolve) => {
    (function check() {
      if (hasPermit(tabId, site)) return resolve(true);
      if (Date.now() >= end) return resolve(false);
      setTimeout(check, 20);
    })();
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.settings || changes.lists)) return;
  config = S.withDefaults(
    changes.settings ? changes.settings.newValue : config.settings,
    changes.lists ? changes.lists.newValue : config.lists
  );
  syncRules().catch(console.error);
});

/* ------------------------------------------------------- network filtering */

let rulesChain = Promise.resolve();
function syncRules() {
  rulesChain = rulesChain.then(applyRules).catch(console.error);
  return rulesChain;
}

async function applyRules() {
  const { settings, lists } = config;
  const enable = [];
  const disable = [];
  (settings.blockAds ? enable : disable).push('ads');
  (settings.blockTrackers ? enable : disable).push('trackers');
  await chrome.declarativeNetRequest.updateEnabledRulesets({
    enableRulesetIds: enable, disableRulesetIds: disable
  });

  const addRules = [];
  if (lists.paused.length) {
    addRules.push({
      id: RULE.PAUSED, priority: 100,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: lists.paused, resourceTypes: ['main_frame'] }
    });
  }
  if (lists.customBlock.length) {
    addRules.push({
      id: RULE.CUSTOM_BLOCK, priority: 50,
      action: { type: 'block' },
      condition: { requestDomains: lists.customBlock }
    });
    addRules.push({
      id: RULE.CUSTOM_BLOCK_PAGE, priority: 50,
      action: { type: 'redirect', redirect: { regexSubstitution: BLOCKED_PAGE + '?kind=blocklist#\\0' } },
      condition: { regexFilter: '^https?://.*', requestDomains: lists.customBlock, resourceTypes: ['main_frame'] }
    });
  }
  if (settings.blockThirdPartyFrames) {
    addRules.push({
      id: RULE.THIRD_PARTY_FRAMES, priority: 10,
      action: { type: 'block' },
      condition: { domainType: 'thirdParty', resourceTypes: ['sub_frame'], excludedRequestDomains: FRAME_EXCEPTIONS }
    });
    addRules.push({
      id: RULE.CAPTCHA_FRAMES, priority: 11,
      action: { type: 'allow' },
      condition: { regexFilter: '^https://www\\.(google\\.com|recaptcha\\.net)/recaptcha/', resourceTypes: ['sub_frame'] }
    });
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules
  });
}

async function setup() {
  await ready;
  await syncRules();
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  await chrome.action.setBadgeBackgroundColor({ color: '#c62828' });
  // Remember what is already open so the first navigation has a reference site.
  for (const tab of await chrome.tabs.query({})) {
    if (S.isWeb(tab.url) && !tabs.get(tab.id)?.url) {
      const t = tabState(tab.id);
      t.url = tab.url;
      t.visited = [S.siteOf(tab.url)];
      t.documentId = (await chrome.webNavigation.getFrame({ tabId: tab.id, frameId: 0 }).catch(() => null))?.documentId;
    }
  }
  saveTabs();
}

chrome.runtime.onInstalled.addListener(async () => {
  await ready;
  await chrome.storage.local.set({ settings: config.settings, lists: config.lists });
  await setup();
});
chrome.runtime.onStartup.addListener(() => { setup().catch(console.error); });

/* ---------------------------------------------------------- block logging */

let logChain = Promise.resolve();
const logBudget = new Map(); // tabId -> { windowStart, n } – stops log spam

function logBlock({ kind, url, fromUrl, tabId, times = 1 }) {
  const now = Date.now();
  const b = logBudget.get(tabId) || { windowStart: now, n: 0 };
  if (now - b.windowStart > 60000) { b.windowStart = now; b.n = 0; }
  if (++b.n > 40) return logChain;
  logBudget.set(tabId, b);

  const entry = {
    kind,
    url: String(url).slice(0, 1000),
    site: S.siteOf(url) || url,
    from: String(fromUrl || '').slice(0, 1000),
    fromSite: S.siteOf(fromUrl || '') || '',
    count: times,
    first: now,
    last: now
  };
  logChain = logChain.then(async () => {
    const { log = [], stats = {} } = await chrome.storage.local.get(['log', 'stats']);
    const key = (e) => `${e.kind}|${e.url}|${e.fromSite}`;
    const i = log.findIndex((e) => key(e) === key(entry));
    if (i !== -1) {
      const [old] = log.splice(i, 1);
      entry.count = old.count + times;
      entry.first = old.first;
    }
    log.unshift(entry);
    log.length = Math.min(log.length, config.settings.logLimit);
    stats[kind] = (stats[kind] || 0) + times;
    stats.since = stats.since || now;
    await chrome.storage.local.set({ log, stats });
  }).catch(console.error);
  return logChain;
}

function bumpBadge(tabId, increment = 1) {
  if (tabId < 0) return;
  chrome.declarativeNetRequest.setExtensionActionOptions({ tabUpdate: { tabId, increment } }).catch(() => {});
}

// "Remember" heavy-popup sites: count unsolicited on-screen popups per site and
// switch auto-closing on for a site once it reaches OVERLAY_LEARN_AT.
let overlayChain = Promise.resolve();
function countOverlays(site, n) {
  const run = overlayChain.then(async () => {
    const { overlayCounts = {} } = await chrome.storage.local.get('overlayCounts');
    const count = (overlayCounts[site] || 0) + Math.max(1, Math.min(10, n | 0));
    delete overlayCounts[site];
    overlayCounts[site] = count; // re-insert so the oldest sites are first to go
    const keys = Object.keys(overlayCounts);
    for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete overlayCounts[k];
    await chrome.storage.local.set({ overlayCounts });
    const { lists } = config;
    if (count < OVERLAY_LEARN_AT || lists.overlaySites.includes(site) || lists.overlayNever.includes(site)) return false;
    await updateLists((l) => l.overlaySites.push(site));
    return true;
  });
  overlayChain = run.catch(() => false);
  return run;
}

function toast(tabId, payload) {
  if (tabId < 0) return;
  chrome.tabs.sendMessage(tabId, { type: 'toast', ...payload }, { frameId: 0 }).catch(() => {});
}

// Toolbar button: close on-screen popups in every frame of a tab, right now.
async function closeOverlaysInTab(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null) || [];
  const answers = await Promise.all(frames.map((f) =>
    chrome.tabs.sendMessage(tabId, { type: 'closeOverlaysNow' }, { frameId: f.frameId })
      .then((r) => ({ frameId: f.frameId, closed: (r && r.closed) || 0 }), () => null)));
  const ok = answers.filter(Boolean);
  return { reached: ok.some((a) => a.frameId === 0), closed: ok.reduce((n, a) => n + a.closed, 0) };
}

/* ------------------------------------------------------------ the guards */

function closePopup(tabId, opener, url, reason) {
  if (closing.has(tabId)) return;
  closing.add(tabId);
  lastDecision.set(tabId, { site: S.siteOf(url), allow: false });
  chrome.tabs.remove(tabId).catch(() => {}).finally(() => setTimeout(() => closing.delete(tabId), 5000));
  logBlock({ kind: 'popup', url, fromUrl: opener.url, tabId: opener.tabId });
  bumpBadge(opener.tabId);
  toast(opener.tabId, { kind: 'popup', url, fromUrl: opener.url, reason });
}

// A page tried to send its own tab to another site. Keep you on the page: ask
// the exact document that is showing to stop the navigation and show a notice.
// If it can't (already gone, no content script), onCommitted undoes it instead.
// notify=false stops quietly (Balanced mode decides a moment later whether
// it was your own click after all).
async function stopNavigation(tabId, t, fromUrl, toUrl, notify = true) {
  lastDecision.set(tabId, { site: S.siteOf(toUrl), allow: false, from: fromUrl, to: toUrl });
  if (notify) reportNavigation(tabId, fromUrl, toUrl, false);
  if (!t.documentId) return;
  await chrome.tabs.sendMessage(tabId, { type: 'stopNavigation', url: toUrl, notify }, { documentId: t.documentId })
    .catch(() => null);
}

function reportNavigation(tabId, fromUrl, toUrl, withToast) {
  logBlock({ kind: 'navigation', url: toUrl, fromUrl, tabId });
  bumpBadge(tabId);
  if (withToast) toast(tabId, { kind: 'navigation', url: toUrl });
}

// The blocked page loaded anyway. Go back to where you were and show the
// notice there; with no history to go back to, open the page it came from.
async function recover(tabId, dec) {
  if (dec.recovering) return;
  dec.recovering = true;
  const now = Date.now();
  const recent = (recoveries.get(tabId) || []).filter((at) => now - at < 15000);
  recent.push(now);
  recoveries.set(tabId, recent);
  if (recent.length > 2) {
    // The page redirects again every time we go back. Stop looping.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && !tab.incognito) return showInterstitial(tabId, dec.from, dec.to);
    // Private window: no page of our own can load there, so let this one stay.
    dec.allow = true;
    const t = tabState(tabId);
    t.url = dec.to;
    t.documentId = (await chrome.webNavigation.getFrame({ tabId, frameId: 0 }).catch(() => null))?.documentId;
    saveTabs();
    return;
  }
  recovering.set(tabId, { from: dec.from, to: dec.to, tries: 1 });
  if (await chrome.tabs.goBack(tabId).then(() => true, () => false)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return recovering.delete(tabId);
  if (!tab.incognito) {
    // Last resort in normal windows: the full blocked page with its buttons.
    recovering.delete(tabId);
    return showInterstitial(tabId, dec.from, dec.to);
  }
  recovering.set(tabId, { from: dec.from, to: dec.to, tries: 2 });
  addPermit(tabId, S.siteOf(dec.from));
  chrome.tabs.update(tabId, { url: dec.from }).catch(() => recovering.delete(tabId));
}

function showInterstitial(tabId, fromUrl, toUrl) {
  lastDecision.set(tabId, { site: S.siteOf(toUrl), allow: false, from: fromUrl, to: toUrl, recovering: true });
  const params = new URLSearchParams({ kind: 'navigation', from: fromUrl, to: toUrl });
  chrome.tabs.update(tabId, { url: `${BLOCKED_PAGE}?${params}` }).catch(() => {});
}

async function openerOf(tabId) {
  const t = tabs.get(tabId);
  if (t?.own) return null;
  if (t?.opener?.url) return t.opener;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.openerTabId == null) return null;
  const ot = tabs.get(tab.openerTabId);
  let url = ot?.url;
  if (!url) url = (await chrome.tabs.get(tab.openerTabId).catch(() => null))?.url;
  return S.isWeb(url) ? { tabId: tab.openerTabId, url } : null;
}

// A popup is a tab a page opened that has not settled on a page of its own yet:
// nothing committed, or only a same-site "bounce" page that redirects within
// a few seconds (the usual trick to get past popup blockers).
function isYoungPopup(t) {
  if (!t.opener || t.own) return false;
  return t.commits === 0 || (t.commits === 1 && Date.now() - t.openedAt < 3000);
}

function isBrowserInitiator(initiator) {
  if (initiator === undefined) return true;
  return /^(chrome|chrome-extension|chrome-search|chrome-untrusted|devtools|edge|brave):/.test(initiator);
}

// Every top-level request: decide before the page commits.
chrome.webRequest.onBeforeRequest.addListener((d) => {
  if (d.tabId < 0 || d.frameId !== 0 || d.documentLifecycle === 'prerender') return;
  onTopLevelRequest(d).catch(console.error);
}, { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] });

async function onTopLevelRequest(d) {
  await ready;
  const targetSite = S.siteOf(d.url);
  const t = tabState(d.tabId);

  // Typed URLs, bookmarks, extension "Continue"/"Open once": always allowed.
  if (isBrowserInitiator(d.initiator) || trustedRequests.has(d.requestId)) {
    lastDecision.set(d.tabId, { site: targetSite, allow: true });
    return;
  }

  let fromUrl = isYoungPopup(t) ? '' : t.url;
  let opener = null;
  let kind = 'navigation';
  if (!fromUrl) {
    opener = t.opener || await openerOf(d.tabId);
    if (opener) {
      kind = 'popup';
      fromUrl = opener.url;
    } else {
      const tab = await chrome.tabs.get(d.tabId).catch(() => null);
      fromUrl = S.isWeb(tab?.url) ? tab.url : (S.isWeb(d.initiator) ? d.initiator : '');
    }
  }
  if (!fromUrl) return;

  const { settings, lists } = config;
  const verdict = S.decide({ fromUrl, toUrl: d.url, kind, settings, lists });
  const permitTab = kind === 'popup' ? opener.tabId : d.tabId;
  let allow = verdict.allow || hasPermit(permitTab, targetSite)
    || (kind === 'navigation' && t.visited.includes(targetSite));
  if (allow && !verdict.allow) trustedRequests.add(d.requestId);
  if (trustedRequests.size > 200) trustedRequests.delete(trustedRequests.values().next().value);
  if (allow) {
    lastDecision.set(d.tabId, { site: targetSite, allow });
    return;
  }

  // Balanced mode trusts links you click. The click's permit is normally here
  // already; if it's a moment late, a popup can wait (we close it anyway), but
  // a navigation is stopped first and re-opened if the permit then arrives.
  const balanced = settings.navMode === 'balanced';
  if (kind === 'popup') {
    if (balanced && await waitForPermit(permitTab, targetSite, BALANCED_GRACE_MS)) {
      trustedRequests.add(d.requestId);
      lastDecision.set(d.tabId, { site: targetSite, allow: true });
      return;
    }
    closePopup(d.tabId, opener, d.url, verdict.reason);
    return;
  }
  await stopNavigation(d.tabId, t, fromUrl, d.url, !balanced);
  if (!balanced) return;
  if (await waitForPermit(d.tabId, targetSite, BALANCED_GRACE_MS)) {
    await openUrl(d.tabId, d.url, false);
  } else {
    reportNavigation(d.tabId, fromUrl, d.url, true);
  }
}

// New tab/window opened by a page (window.open, target=_blank, ...).
chrome.webNavigation.onCreatedNavigationTarget.addListener(async (d) => {
  await ready;
  let srcUrl = tabs.get(d.sourceTabId)?.url;
  if (!srcUrl) srcUrl = (await chrome.tabs.get(d.sourceTabId).catch(() => null))?.url;
  if (!S.isWeb(srcUrl)) return;
  const t = tabState(d.tabId);
  t.opener = { tabId: d.sourceTabId, url: srcUrl };
  saveTabs();
  if (!S.isWeb(d.url) || t.commits > 0) return;

  const verdict = S.decide({ fromUrl: srcUrl, toUrl: d.url, kind: 'popup', settings: config.settings, lists: config.lists });
  if (!verdict.allow && !hasPermit(d.sourceTabId, S.siteOf(d.url))) {
    closePopup(d.tabId, t.opener, d.url, verdict.reason);
  }
});

// Track what each tab actually shows, and catch navigations the request
// listener never saw (e.g. pages served from a site's service worker).
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  await ready;
  if (closing.has(d.tabId)) return;
  const site = S.siteOf(d.url);

  // Coming back after undoing a blocked navigation: show the notice here.
  const rec = recovering.get(d.tabId);
  if (rec && site !== S.siteOf(rec.to)) {
    recovering.delete(d.tabId);
    if (site === S.siteOf(rec.from)) {
      setTimeout(() => toast(d.tabId, { kind: 'navigation', url: rec.to }), 300);
    } else if (rec.tries < 2) {
      // Back went somewhere else: Chrome's back button skips pages that
      // redirected on their own, and some pages replace their history entry.
      recovering.set(d.tabId, { ...rec, tries: 2 });
      addPermit(d.tabId, S.siteOf(rec.from));
      chrome.tabs.update(d.tabId, { url: rec.from }).catch(() => recovering.delete(d.tabId));
    }
  }

  if (!S.isWeb(d.url)) return;
  const t = tabState(d.tabId);
  const quals = d.transitionQualifiers || [];
  const userDriven = USER_TRANSITIONS.has(d.transitionType)
    || quals.includes('from_address_bar') || quals.includes('forward_back');
  const dec = lastDecision.get(d.tabId);

  if (!userDriven && t.url && S.siteOf(t.url) !== site) {
    // A blocked navigation that couldn't be stopped in time: undo it.
    if (dec && dec.site === site && !dec.allow) {
      recover(d.tabId, dec);
      return;
    }
    if (!dec || dec.site !== site) {
      const verdict = S.decide({ fromUrl: t.url, toUrl: d.url, kind: 'navigation', settings: config.settings, lists: config.lists });
      if (!verdict.allow && !hasPermit(d.tabId, site) && !t.visited.includes(site)) {
        const blocked = { site, allow: false, from: t.url, to: d.url };
        lastDecision.set(d.tabId, blocked);
        logBlock({ kind: 'navigation', url: d.url, fromUrl: t.url, tabId: d.tabId });
        recover(d.tabId, blocked);
        return;
      }
    }
  }

  t.url = d.url;
  t.documentId = d.documentId;
  t.commits += 1;
  if (!t.visited.includes(site)) t.visited = [site, ...t.visited].slice(0, 50);
  saveTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  permits.delete(tabId);
  lastDecision.delete(tabId);
  recovering.delete(tabId);
  recoveries.delete(tabId);
  logBudget.delete(tabId);
  saveTabs();
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  if (tabs.has(removed)) { tabs.set(added, tabs.get(removed)); tabs.delete(removed); saveTabs(); }
});

/* --------------------------------------------------------------- messages */

async function updateLists(mutate) {
  await ready;
  const lists = S.withDefaults(null, JSON.parse(JSON.stringify(config.lists))).lists;
  mutate(lists);
  for (const k of Object.keys(lists)) lists[k] = [...new Set(lists[k].filter(Boolean))].sort();
  config = S.withDefaults(config.settings, lists);
  await chrome.storage.local.set({ lists });
  return lists;
}

async function openUrl(tabId, url, newTab) {
  if (!S.isWeb(url)) return;
  addPermit(tabId, S.siteOf(url));
  if (newTab) {
    const src = await chrome.tabs.get(tabId).catch(() => null);
    const tab = await chrome.tabs.create({ url, openerTabId: src?.id, index: src ? src.index + 1 : undefined });
    const t = tabState(tab.id);
    t.own = true;
    t.opener = null;
    saveTabs();
  } else {
    await chrome.tabs.update(tabId, { url });
  }
}

const isExtensionPage = (sender) => sender.id === chrome.runtime.id && (sender.url || '').startsWith(EXTENSION_ORIGIN);

async function handleMessage(msg, sender) {
  await ready;
  const tabId = sender.tab ? sender.tab.id : -1;
  const pageUrl = sender.tab?.url || '';

  switch (msg.type) {
    // ---- from content scripts --------------------------------------
    case 'blocked': {
      const kind = ['link', 'navigation'].includes(msg.kind) ? msg.kind : 'popup';
      if (typeof msg.url !== 'string') return { error: 'bad url' };
      // A tab a page just opened tried to bounce elsewhere: it's a popup, close it.
      const st = tabs.get(tabId);
      if (kind === 'navigation' && st && isYoungPopup(st)) {
        closePopup(tabId, st.opener, msg.url, 'cross-site');
        return { ok: true };
      }
      logBlock({ kind, url: msg.url, fromUrl: pageUrl, tabId });
      bumpBadge(tabId);
      toast(tabId, { kind, url: msg.url, fromUrl: pageUrl, newTab: !!msg.newTab });
      return { ok: true };
    }
    case 'userGesture': {
      // Balanced mode: a real click on a link. Allow that navigation once.
      if (config.settings.navMode === 'balanced') addPermit(tabId, S.siteOf(msg.url), msg.contextMenu ? 30000 : PERMIT_MS);
      return { ok: true };
    }
    case 'openOnce': {
      await openUrl(tabId, msg.url, msg.newTab);
      return { ok: true };
    }
    case 'allowSource': {
      const site = S.siteOf(pageUrl);
      if (site) await updateLists((l) => l.allowOutbound.push(site));
      if (msg.url) await openUrl(tabId, msg.url, msg.newTab);
      return { ok: true };
    }
    // On-screen popups (content/overlay.js). They only ever affect the sender's own site.
    case 'overlaySeen': {
      const site = S.siteOf(pageUrl);
      if (!site || config.settings.overlayMode !== 'auto') return { ok: true, learned: false };
      return { ok: true, learned: await countOverlays(site, msg.count) };
    }
    case 'overlayClosed': {
      const times = Math.max(1, Math.min(10, msg.count | 0));
      // Closed inside an embedded frame: log that frame's address, and show
      // the notice in the page itself (a frame is too small for one).
      const inFrame = !!sender.frameId;
      const where = inFrame && S.isWeb(sender.url) ? sender.url : pageUrl;
      if (S.isWeb(pageUrl)) logBlock({ kind: 'overlay', url: where, fromUrl: pageUrl, tabId, times });
      bumpBadge(tabId, times);
      if (inFrame) {
        toast(tabId, { kind: 'overlay', title: 'Popup closed', text: 'Removed a popup layer from an embedded player on this page.' });
      }
      return { ok: true };
    }
    case 'overlayUndo': {
      // Every frame of this tab puts back what it closed.
      if (tabId >= 0) chrome.tabs.sendMessage(tabId, { type: 'overlayUndo' }).catch(() => {});
      return { ok: true };
    }
    case 'overlayPref': {
      const site = S.siteOf(pageUrl);
      if (site && msg.pref === 'never') {
        await updateLists((l) => {
          l.overlaySites = l.overlaySites.filter((s) => s !== site);
          l.overlayNever.push(site);
        });
      }
      return { ok: true };
    }
  }

  if (!isExtensionPage(sender)) return { error: 'forbidden' };

  switch (msg.type) {
    // ---- from the interstitial -------------------------------------
    case 'continue': {
      const to = msg.to;
      if (msg.alsoAllowSource) await updateLists((l) => l.allowOutbound.push(S.siteOf(msg.from)));
      if (msg.alsoTrustDestination) await updateLists((l) => l.trustedDestinations.push(S.siteOf(to)));
      if (msg.unblock) {
        await updateLists((l) => { l.customBlock = l.customBlock.filter((d) => !S.matchesEntry(to, d)); });
        await syncRules(); // the redirect rule must be gone before we navigate
      }
      await openUrl(tabId, to, false);
      return { ok: true };
    }
    case 'goBack': {
      if (S.isWeb(msg.from)) await chrome.tabs.update(tabId, { url: msg.from });
      else await chrome.tabs.remove(tabId);
      return { ok: true };
    }
    case 'logBlocklistHit': {
      logBlock({ kind: 'blocklist', url: msg.url, fromUrl: '', tabId });
      return { ok: true };
    }
    // ---- from popup / options --------------------------------------
    case 'setSettings': {
      const settings = Object.assign({}, config.settings, msg.patch);
      config = S.withDefaults(settings, config.lists);
      await chrome.storage.local.set({ settings: config.settings });
      return { ok: true, settings: config.settings };
    }
    case 'listOp': {
      if (!(msg.list in S.DEFAULT_LISTS)) return { error: 'unknown list' };
      const keepPath = msg.list === 'trustedDestinations';
      const values = [].concat(msg.value || []).map((v) => {
        const n = S.normalizeEntry(v, { keepPath });
        return SITE_LISTS.includes(msg.list) ? S.siteOf(n) : n;
      }).filter(Boolean);
      const lists = await updateLists((l) => {
        if (msg.op === 'add') l[msg.list].push(...values);
        else if (msg.op === 'remove') l[msg.list] = l[msg.list].filter((v) => !values.includes(v));
        else if (msg.op === 'set') l[msg.list] = values;
      });
      return { ok: true, lists };
    }
    case 'closeOverlays': {
      return { ok: true, ...(await closeOverlaysInTab(msg.tabId)) };
    }
    case 'clearLog': {
      await chrome.storage.local.set({ log: [], stats: { since: Date.now() } });
      return { ok: true };
    }
    case 'resetAll': {
      config = S.withDefaults();
      await chrome.storage.local.set({ settings: config.settings, lists: config.lists, overlayCounts: {} });
      return { ok: true };
    }
  }
  return { error: 'unknown message' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg || {}, sender).then(sendResponse, (e) => sendResponse({ error: String(e) }));
  return true;
});
```


## Content scripts


### 2.4 extension/src/content/guard-main.js

[Open file](extension/src/content/guard-main.js) · 186 lines


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


```javascript
/*
 * Runs in the page's own JavaScript world (MAIN) before any page script.
 *
 * Pages open popups through APIs that never fire an event a content script
 * could cancel: window.open(), anchor.click() on a detached <a>, form.submit().
 * This file wraps those APIs and asks the isolated content script (guard.js)
 * for a verdict through a synchronous DOM event. It holds no settings itself;
 * the service worker independently closes anything that slips past.
 * The question is sent from the element whose click listener is opening the
 * popup, which tells overlay.js which element on the page is a click trap.
 */
(() => {
  'use strict';

  const ASK = '__strictshield_q';
  const ANSWER = '__strictshield_r';

  // Capture natives before the page can tamper with them.
  const win = window;
  const apply = Reflect.apply;
  const getDesc = Object.getOwnPropertyDescriptor;
  const defineProperty = Object.defineProperty;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const listen = EventTarget.prototype.addEventListener;
  const stringify = JSON.stringify;
  const CustomEvt = CustomEvent;
  const NativeURL = URL;
  const NativeProxy = Proxy;
  const NativeWeakSet = WeakSet;
  const urlHref = getDesc(URL.prototype, 'href').get;
  const baseURI = getDesc(Node.prototype, 'baseURI').get;
  const isConnected = getDesc(Node.prototype, 'isConnected').get;
  const anchorHref = getDesc(HTMLAnchorElement.prototype, 'href').get;
  const anchorTarget = getDesc(HTMLAnchorElement.prototype, 'target').get;
  const formAction = getDesc(HTMLFormElement.prototype, 'action').get;
  const formTarget = getDesc(HTMLFormElement.prototype, 'target').get;
  const AnchorEl = HTMLAnchorElement;
  const FormEl = HTMLFormElement;
  const ElementCtor = Element;
  const doc = document;
  const toLower = String.prototype.toLowerCase;
  const ownerDoc = getDesc(Node.prototype, 'ownerDocument').get;
  const evType = getDesc(Event.prototype, 'type').get;
  const evCurrentTarget = getDesc(Event.prototype, 'currentTarget').get;
  const currentEvent = (getDesc(win, 'event') || getDesc(Window.prototype, 'event') || {}).get;
  const CLICKS = { __proto__: null, click: 1, auxclick: 1, dblclick: 1, mousedown: 1, mouseup: 1,
    pointerdown: 1, pointerup: 1, touchstart: 1, touchend: 1 };

  let answer = null;
  apply(listen, win, [ANSWER, (e) => { answer = e.detail; }, true]);

  function resolve(url) {
    if (url === undefined || url === null || url === '') return 'about:blank';
    try {
      return apply(urlHref, new NativeURL(String(url), apply(baseURI, document, [])), []);
    } catch {
      return String(url);
    }
  }

  // The element whose own click listener is running right now, if there is
  // one. (Listeners on document or window give null: any click reaches those.)
  function listenerElement() {
    try {
      const ev = currentEvent ? apply(currentEvent, win, []) : null;
      if (!ev || !CLICKS[apply(evType, ev, [])]) return null;
      const el = apply(evCurrentTarget, ev, []);
      if (!(el instanceof ElementCtor) || !apply(isConnected, el, []) || apply(ownerDoc, el, []) !== doc) return null;
      return el;
    } catch {
      return null;
    }
  }

  function ask(target, detail) {
    try {
      apply(dispatch, target, [new CustomEvt(ASK, { detail, bubbles: true, composed: true })]);
    } catch { /* no answer */ }
  }

  // Synchronous round trip to guard.js. No answer (extension reloaded,
  // paused, ...) means allow: the service worker is still the backstop.
  // The question is sent from the element whose click listener is opening
  // the popup, so guard.js can tell which element is a click trap.
  function allowed(url, via) {
    answer = null;
    const detail = stringify({ url, via });
    const el = listenerElement();
    if (el) ask(el, detail);
    if (answer === null) ask(win, detail);
    return answer !== 'block';
  }

  function opensNewWindow(target) {
    const t = apply(toLower, String(target || ''), []);
    return !!t && t !== '_self' && t !== '_top' && t !== '_parent';
  }

  // window.open(), also on windows of iframes the page creates.
  const patched = new NativeWeakSet();
  function patchOpen(w) {
    if (!w || patched.has(w)) return;
    patched.add(w);
    try {
      const native = w.open;
      w.open = new NativeProxy(native, {
        apply(target, thisArg, args) {
          if (!allowed(resolve(args[0]), 'window.open')) return null;
          return apply(target, thisArg, args);
        }
      });
    } catch { /* cross-origin frame */ }
  }
  patchOpen(win);

  // A fresh about:blank iframe has an unpatched window.open until its own
  // content scripts run, so patch it the moment the page reaches for it.
  for (const [proto, prop] of [
    [HTMLIFrameElement.prototype, 'contentWindow'],
    [HTMLFrameElement.prototype, 'contentWindow'],
    [HTMLObjectElement.prototype, 'contentWindow']
  ]) {
    const desc = getDesc(proto, prop);
    if (!desc || !desc.get) continue;
    defineProperty(proto, prop, Object.assign({}, desc, {
      get: new NativeProxy(desc.get, {
        apply(target, thisArg, args) {
          const w = apply(target, thisArg, args);
          patchOpen(w);
          return w;
        }
      })
    }));
  }
  const docDesc = getDesc(HTMLIFrameElement.prototype, 'contentDocument');
  if (docDesc && docDesc.get) {
    const defaultView = getDesc(Document.prototype, 'defaultView').get;
    defineProperty(HTMLIFrameElement.prototype, 'contentDocument', Object.assign({}, docDesc, {
      get: new NativeProxy(docDesc.get, {
        apply(target, thisArg, args) {
          const d = apply(target, thisArg, args);
          if (d) patchOpen(apply(defaultView, d, []));
          return d;
        }
      })
    }));
  }

  // anchor.click() / dispatchEvent(click) on an <a> that is not in the page.
  // Clicks on attached links bubble to window, where guard.js handles them.
  function detachedAnchorAllowed(el, type) {
    if (type !== 'click' || !(el instanceof AnchorEl) || apply(isConnected, el, [])) return true;
    if (!opensNewWindow(apply(anchorTarget, el, []))) return true;
    return allowed(apply(anchorHref, el, []), 'anchor.click');
  }

  const nativeClick = HTMLElement.prototype.click;
  HTMLElement.prototype.click = new NativeProxy(nativeClick, {
    apply(target, thisArg, args) {
      if (!detachedAnchorAllowed(thisArg, 'click')) return undefined;
      return apply(target, thisArg, args);
    }
  });

  EventTarget.prototype.dispatchEvent = new NativeProxy(dispatch, {
    apply(target, thisArg, args) {
      const evt = args[0];
      try {
        if (evt && !detachedAnchorAllowed(thisArg, evt.type)) return false;
      } catch { /* fall through */ }
      return apply(target, thisArg, args);
    }
  });

  // form.submit() skips the submit event entirely.
  const nativeSubmit = HTMLFormElement.prototype.submit;
  HTMLFormElement.prototype.submit = new NativeProxy(nativeSubmit, {
    apply(target, thisArg, args) {
      if (thisArg instanceof FormEl && opensNewWindow(apply(formTarget, thisArg, []))
          && !allowed(apply(formAction, thisArg, []), 'form.submit')) {
        return undefined;
      }
      return apply(target, thisArg, args);
    }
  });
})();
```


### 2.5 extension/src/content/guard.js

[Open file](extension/src/content/guard.js) · 376 lines


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


```javascript
/*
 * Isolated-world content script (every frame, document_start).
 *   - answers guard-main.js: may this window.open()/click open that URL?
 *   - cancels clicks on links that would open another site
 *   - hides ad containers (cosmetic filtering)
 *   - shows the "blocked" toast in the top frame
 *   - exposes self.StrictShieldContent (config, toast, blocked-click evidence)
 *     to overlay.js, in every frame
 */
(() => {
  'use strict';
  const S = self.StrictSite;
  const ASK = '__strictshield_q';
  const ANSWER = '__strictshield_r';
  const isTop = window.top === window;

  let { settings, lists } = S.withDefaults();

  // The site whose rules apply: always the top-level page, even inside iframes.
  const topUrl = (() => {
    if (isTop) return S.isWeb(location.href) ? location.href : (self.origin !== 'null' ? self.origin : '');
    const ao = location.ancestorOrigins;
    if (ao && ao.length) return ao[ao.length - 1];
    return '';
  })();
  const topSite = S.siteOf(topUrl);
  const paused = () => lists.paused.includes(topSite);

  function send(msg) {
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch { /* extension reloaded */ }
  }

  function report(kind, url, newTab) {
    send({ type: 'blocked', kind, url, newTab });
  }

  /* -------------------------------------------------------------- verdicts */

  function popupAllowed(rawUrl) {
    if (paused() || !settings.blockPopups) return true;
    const u = S.parse(rawUrl);
    if (!u || u.protocol === 'about:') return true; // blank popups: the worker watches where they go
    if (u.protocol === 'javascript:' || u.protocol === 'data:') return false;
    const target = u.protocol === 'blob:' ? u.origin : rawUrl;
    if (!S.isWeb(target)) return true;               // mailto:, tel:, app links
    return S.decide({ fromUrl: topUrl, toUrl: target, kind: 'popup', settings, lists }).allow;
  }

  // overlay.js listens here: (element, isLink) for every click whose popup was blocked.
  const blockedClickListeners = [];
  function notifyBlockedClick(el, isLink) {
    for (const cb of blockedClickListeners) { try { cb(el, isLink); } catch { /* listener bug */ } }
  }

  window.addEventListener(ASK, (e) => {
    let req;
    try { req = JSON.parse(e.detail); } catch { return; }
    const allow = popupAllowed(req.url);
    if (!allow) report('popup', req.url, true);
    window.dispatchEvent(new CustomEvent(ANSWER, { detail: allow ? 'allow' : 'block' }));
    // guard-main.js sends the question from the element whose own click
    // listener tried to open the popup: evidence that it is a click trap.
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!allow && el && el.nodeType === 1) notifyBlockedClick(el, false);
  }, true);

  /* ---------------------------------------------------------- link clicks */

  function linkFrom(e) {
    for (const el of e.composedPath ? e.composedPath() : []) {
      if (el && el.nodeType === 1 && (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href')) return el;
    }
    return null;
  }

  function hrefOf(a) {
    const h = a.href;
    if (typeof h === 'string') return h;
    try { return new URL(h.baseVal, document.baseURI).href; } catch { return ''; } // SVG <a>
  }

  function namedFrameExists(name) {
    try {
      return !!document.querySelector(`iframe[name="${CSS.escape(name)}"],frame[name="${CSS.escape(name)}"]`);
    } catch { return false; }
  }

  function targetOf(el, attr = 'target') {
    const own = el.getAttribute(attr);
    if (own) return own;
    const base = document.querySelector('base[target]');
    return base ? base.getAttribute('target') : '';
  }

  function opensNewTab(target, e) {
    if (e && (e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey)) return true;
    const t = (target || '').toLowerCase();
    if (!t || t === '_self' || t === '_top' || t === '_parent') return false;
    return t === '_blank' || !namedFrameExists(target);
  }

  const modifierClick = (e) => e.button === 1 || e.ctrlKey || e.metaKey || e.shiftKey;

  function onClick(e) {
    if (paused()) return;
    if (e.type === 'click' && e.button !== 0) return;
    if (e.type === 'auxclick' && e.button !== 1) return;
    const a = linkFrom(e);
    if (!a) return;
    const href = hrefOf(a);
    if (!S.isWeb(href)) return;

    const newTab = opensNewTab(targetOf(a), e);
    // A frame navigating itself is not a top-level navigation; _top/_parent
    // links are judged by the service worker when the top page navigates.
    if (!newTab && !isTop) return;
    if (newTab ? !settings.blockPopups : settings.navMode === 'off') return;

    const kind = newTab ? 'popup' : 'navigation';
    if (S.decide({ fromUrl: topUrl, toUrl: href, kind, settings, lists }).allow) return;

    // Balanced mode trusts a real click on a same-tab link, and a deliberate
    // middle/ctrl/cmd-click. Plain clicks on target=_blank stay blocked: that
    // is how full-page ad overlays open their popups.
    if (settings.navMode === 'balanced' && e.isTrusted && (!newTab || modifierClick(e))) {
      send({ type: 'userGesture', url: href });
      return;
    }
    e.preventDefault();
    report(newTab ? 'popup' : 'link', href, newTab);
    notifyBlockedClick(a, true);
  }
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  // Scripted navigations of this tab (location.href = ..., form posts,
  // meta refresh): the Navigation API lets us cancel them before they leave
  // the page, so you stay where you are. Server redirects and ad frames that
  // set top.location never reach this event; the service worker handles those.
  if (isTop && self.navigation) {
    navigation.addEventListener('navigate', (e) => {
      if (paused() || settings.navMode === 'off' || !e.cancelable) return;
      if (e.navigationType === 'traverse' || e.navigationType === 'reload' || e.hashChange || e.downloadRequest) return;
      const href = e.destination.url;
      if (!S.isWeb(href)) return;
      if (S.decide({ fromUrl: topUrl, toUrl: href, kind: 'navigation', settings, lists }).allow) return;
      if (settings.navMode === 'balanced' && e.userInitiated) return; // your click (onClick sent the permit)
      e.preventDefault();
      report(e.userInitiated ? 'link' : 'navigation', href, false);
    });
  }

  // Balanced mode: "Open link in new tab" from the context menu.
  window.addEventListener('contextmenu', (e) => {
    if (settings.navMode !== 'balanced' || !e.isTrusted) return;
    const a = linkFrom(e);
    if (a && S.isWeb(hrefOf(a))) send({ type: 'userGesture', url: hrefOf(a), contextMenu: true });
  }, true);

  // <form target="_blank"> to another site. Same-tab submits are judged by
  // the service worker (it shows the interstitial).
  const formActionGet = Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'action').get;
  window.addEventListener('submit', (e) => {
    const form = e.target;
    if (paused() || !settings.blockPopups || !(form instanceof HTMLFormElement)) return;
    const sub = e.submitter;
    const target = (sub && sub.getAttribute('formtarget')) || targetOf(form);
    if (!opensNewTab(target)) return;
    let action = formActionGet.call(form);
    if (sub && sub.hasAttribute('formaction')) {
      try { action = new URL(sub.getAttribute('formaction'), document.baseURI).href; } catch { /* keep */ }
    }
    if (popupAllowed(action)) return;
    e.preventDefault();
    report('popup', action, true);
  }, true);

  /* ------------------------------------------------------------ cosmetics */

  let style = null;
  let styleGuard = null;
  function applyCosmetic() {
    const want = settings.cosmetic && !paused() && Array.isArray(self.StrictCosmetic);
    if (want && !style) {
      style = document.createElement('style');
      style.textContent = self.StrictCosmetic.join(',\n') + ' { display: none !important; }';
      document.documentElement.appendChild(style);
      // Some anti-adblock scripts delete injected styles; put it back.
      styleGuard = new MutationObserver(() => {
        if (style && !style.isConnected) document.documentElement.appendChild(style);
      });
      styleGuard.observe(document.documentElement, { childList: true });
    } else if (!want && style) {
      styleGuard.disconnect();
      style.remove();
      style = null;
    }
  }
  if (document.documentElement && document.documentElement.namespaceURI === 'http://www.w3.org/1999/xhtml') applyCosmetic();

  /* --------------------------------------------------------------- config */

  const configListeners = [];
  let configLoaded = false;
  function setConfig(s, l) {
    ({ settings, lists } = S.withDefaults(s, l));
    configLoaded = true;
    if (style || settings.cosmetic) applyCosmetic();
    for (const cb of configListeners) { try { cb(); } catch { /* listener bug */ } }
  }
  try {
    chrome.storage.local.get(['settings', 'lists']).then((r) => setConfig(r.settings, r.lists), () => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(changes.settings || changes.lists)) return;
      setConfig(changes.settings ? changes.settings.newValue : settings, changes.lists ? changes.lists.newValue : lists);
    });
  } catch { /* extension reloaded */ }

  // For overlay.js, which runs next in this same isolated world.
  const api = {
    isTop,
    topUrl,
    topSite,
    send,
    config: () => ({ settings, lists, loaded: configLoaded }),
    onConfig: (cb) => { configListeners.push(cb); },
    onBlockedClick: (cb) => { blockedClickListeners.push(cb); },
    toast: () => {},      // only the top frame shows notices
    isOwn: () => false
  };
  self.StrictShieldContent = api;

  /* ---------------------------------------------------------------- toast */

  if (!isTop) return;

  let host = null;
  let shadow = null;
  const rows = new Map(); // site|kind -> { el, count, timer }

  const TOAST_CSS = `
    :host { all: initial; }
    .stack { position: fixed; z-index: 2147483647; right: 16px; bottom: 16px; display: flex;
      flex-direction: column; gap: 8px; max-width: min(380px, calc(100vw - 32px));
      font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .toast { background: #1d1f23; color: #f3f4f6; border-radius: 10px; padding: 12px 14px;
      box-shadow: 0 6px 24px rgba(0,0,0,.35); border-left: 4px solid #e53935; }
    .head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
    .head .t { flex: 1; }
    .count { background: #e53935; color: #fff; border-radius: 999px; padding: 0 7px; font-size: 11px; }
    .x { all: unset; cursor: pointer; color: #9ca3af; font-size: 16px; line-height: 1; padding: 0 2px; }
    .x:hover { color: #fff; }
    .url { color: #cbd5e1; margin: 4px 0 10px; word-break: break-all; }
    .url b { color: #fff; }
    .btns { display: flex; gap: 8px; flex-wrap: wrap; }
    button.b { all: unset; cursor: pointer; padding: 5px 10px; border-radius: 6px; background: #374151;
      color: #f9fafb; font-size: 12px; }
    button.b:hover { background: #4b5563; }
    button.b:focus-visible, .x:focus-visible { outline: 2px solid #93c5fd; outline-offset: 2px; }
  `;

  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    shadow = host.attachShadow({ mode: 'closed' });
    const css = document.createElement('style');
    css.textContent = TOAST_CSS;
    const stack = document.createElement('div');
    stack.className = 'stack';
    shadow.append(css, stack);
    (document.body || document.documentElement).appendChild(host);
  }

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  // msg: { kind, url } for something blocked, or { kind: 'overlay', title, text }
  // for on-screen popups closed here or (relayed by the worker) in a frame.
  function showToast(msg) {
    ensureHost();
    const url = String(msg.url || '');
    const web = S.isWeb(url);
    const overlay = msg.kind === 'overlay';
    const site = overlay ? topSite : (web ? S.hostOf(url) : url.split(':')[0] + ':');
    const key = `${msg.kind}|${site}`;
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      existing.badge.textContent = '×' + existing.count;
      existing.badge.hidden = false;
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => dismiss(key), 10000);
      return;
    }

    const title = msg.title
      || { link: 'Link to another site blocked', navigation: 'Redirect to another site blocked' }[msg.kind]
      || 'Popup blocked';
    const box = el('div', 'toast');
    box.setAttribute('role', 'status');
    const head = el('div', 'head');
    const badge = el('span', 'count');
    badge.hidden = true;
    const close = el('button', 'x', '×');
    close.setAttribute('aria-label', 'Dismiss');
    head.append(el('span', 't', `🛡 ${title}`), badge, close);

    const line = el('div', 'url');
    if (msg.text) {
      line.textContent = msg.text;
    } else {
      line.append(document.createTextNode(web ? 'This page tried to open ' : 'This page tried to open a '));
      line.append(el('b', '', site));
    }
    const actions = overlay ? [
      // The worker tells every frame of this tab to put back what it closed.
      { label: 'Undo', run: () => send({ type: 'overlayUndo' }) },
      { label: `Never on ${topSite}`, run: () => { send({ type: 'overlayUndo' }); send({ type: 'overlayPref', pref: 'never' }); } }
    ] : (web ? [
      { label: 'Open once', run: () => send({ type: 'openOnce', url, newTab: msg.kind === 'popup' }) },
      { label: `Always allow ${topSite}`, run: () => send({ type: 'allowSource', url, newTab: msg.kind === 'popup' }) }
    ] : []);
    const btns = el('div', 'btns');
    for (const action of actions) {
      const b = el('button', 'b', action.label);
      b.addEventListener('click', (e) => {
        if (!e.isTrusted) return; // the page can't press these for you
        action.run();
        dismiss(key);
      });
      btns.append(b);
    }
    close.addEventListener('click', () => dismiss(key));
    box.append(head, line, btns);
    shadow.querySelector('.stack').appendChild(box);

    const row = { el: box, badge, count: 1, timer: setTimeout(() => dismiss(key), 10000) };
    box.addEventListener('mouseenter', () => clearTimeout(row.timer));
    box.addEventListener('mouseleave', () => { row.timer = setTimeout(() => dismiss(key), 4000); });
    rows.set(key, row);
    while (rows.size > 3) dismiss(rows.keys().next().value);
  }

  function dismiss(key) {
    const row = rows.get(key);
    if (!row) return;
    clearTimeout(row.timer);
    row.el.remove();
    rows.delete(key);
  }

  function whenBody(fn) {
    if (document.body || document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn, { once: true });
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'toast') whenBody(() => showToast(msg));
      // The worker blocked this page's attempt to send the tab to another
      // site: cancel the pending navigation so you stay on this page.
      if (msg && msg.type === 'stopNavigation') {
        window.stop();
        if (msg.notify !== false) whenBody(() => showToast({ kind: 'navigation', url: msg.url }));
        sendResponse({ stopped: true });
      }
    });
  } catch { /* extension reloaded */ }

  api.toast = (msg) => whenBody(() => showToast(msg));
  api.isOwn = (node) => !!host && node === host;
})();
```


### 2.6 extension/src/content/overlay.js

[Open file](extension/src/content/overlay.js) · 653 lines


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


```javascript
/*
 * On-screen popup closer (every frame, isolated world, after guard.js).
 *
 * In the page itself it finds things put over the content without being
 * asked: newsletter / "subscribe" modals, cookie walls, "turn off your ad
 * blocker" boxes, notification prompts, interstitial ads and invisible
 * click-trap layers. For each one it tries, in order:
 *   1. the popup's own close / "No thanks" / "Reject all" button
 *   2. the Escape key
 *   3. hiding it
 * and then gives scrolling back and removes the blur the page put behind it.
 * It never presses Accept, Subscribe, Allow or Sign up.
 *
 * Embedded players (video first): in the page and inside every frame, what
 * sits on top of a video or an embedded player frame without being part of
 * it is removed, so only the video and its own controls are left:
 *   - invisible layers that only exist to catch your click
 *   - ad frames laid over a video
 *   - link layers to another site stretched over the player
 * A layer whose own click handler tried to open a popup that was blocked is
 * removed too, in every mode but "off": that is proof it was a click trap.
 *
 * Where it acts (settings.overlayMode), always by the site of the top page:
 *   'auto'       sites in lists.overlaySites: ones you added, plus sites it
 *                learned because they showed 3 popups; elsewhere it only counts
 *   'everywhere' every site
 *   'off'        nowhere (the toolbar "Close popups now" button still works)
 * Popups that appear right after you click a button or link are yours
 * (a login box, a menu) and are left alone.
 */
(() => {
  'use strict';
  const S = self.StrictSite;
  const C = self.StrictShieldContent;
  if (!S || !C) return;

  // Never touch captcha, payment or sign-in frames.
  const SAFE_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|stripe|razorpay|paypal|checkout|payments?\b|accounts\.google|appleid|login\.(microsoft|live)/i;
  const isFrame = !C.isTop;
  if (isFrame && SAFE_FRAME.test(location.href)) return;
  const frameSite = S.siteOf(location.href) || C.topSite;

  // Where to look: the middle of the screen for modals, the edges for banners.
  const CENTER_PROBES = [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.65], [0.7, 0.65]];
  const EDGE_PROBES = [[0.5, 0.97], [0.15, 0.97], [0.85, 0.97], [0.5, 0.03], [0.85, 0.85]];
  // A bar at the edge only counts as a popup if it talks like one.
  const BANNER_WORDS = /cookie|consent|gdpr|newsletter|notification|ad ?block|allowlist|whitelist|get the app|open in (the )?app|download (the |our )?app|\d+ ?% off|discount|sign up for|subscribe to|don'?t miss/i;
  // Button text that closes without agreeing to anything.
  const CLOSE_TEXT = /^(×|✕|✖|✗|╳|x|close|close this|close ad|dismiss|no,? thanks?\b.*|no thank you.*|not now|maybe later|later|skip|skip ad|cancel|continue (reading|to (the )?site|without .*)|i'?ll pass|not interested|reject|reject all|decline( all)?|deny|necessary (cookies )?only|only necessary.*)$/i;
  const CLOSE_HINT = /close|dismiss|no.?thanks|not.?now|maybe.?later|skip|cancel|reject|decline/i;
  const NOT_CLOSE = /accept|agree|allow|subscribe|sign.?up|log.?in|sign.?in|register|continue with|yes|^ok$|got it|enable|install|download|buy|shop|claim|get |join/i;
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[onclick],[contenteditable]';
  const RESCAN_AFTER_MS = [800, 2000, 4000, 8000, 15000, 30000, 60000];
  const MIN_GAP_MS = isFrame ? 1000 : 600; // between two scans

  // Embedded players.
  const MIN_PLAYER = { width: 200, height: 120 };
  // What a player's own layers hold ...
  const PLAYER_PARTS = 'video,audio,canvas,iframe,embed,object,input,select,textarea,button,[role=button],[role=slider],[role=menu]';
  // ... and what they are usually called.
  const PLAYER_NAME = /(^|\s)(vjs-|jw-|ytp-|fp-|art-|mejs)|video-js|jwplayer|plyr|html5-video|flowplayer|dplayer|shaka|clappr|bmpui|theoplayer|control|caption|subtitle|poster|spinner|loading|progress|seek|volume/i;
  // The controls of a playing video ad live in this frame; hiding it would hide "Skip ad".
  const AD_UI_FRAME = /imasdk\.googleapis\.com/i;

  let lastGesture = { t: -Infinity, interactive: false };
  let pressedAt = 0;          // a mouse button is down: you may be dragging something
  let prevScan = performance.now();
  let lastScanEnd = 0;
  let busy = false;
  let stopped = false;        // set by Undo for the rest of this page
  let baseline = null;        // scroll lock state at DOMContentLoaded
  let lastMode = null;
  let learnedNow = false;
  let observer = null;
  let timer = 0;

  const firstSeen = new WeakMap(); // element -> { user }
  const changedAt = new WeakMap(); // element -> when it was added or restyled (from the observer)
  const attempts = new WeakMap();  // element -> times we closed it (pages that re-open)
  const strikes = new WeakMap();   // visible layer -> blocked popups its clicks caused
  const counted = new WeakSet();   // elements already reported for learning
  const hidden = [];               // { el, value, priority } for Undo
  const restyled = [];             // { el, prop, value, priority } for Undo

  /* ------------------------------------------------------------ settings */

  function mode() {
    const { settings, lists, loaded } = C.config();
    const site = C.topSite;
    if (!loaded || !site || lists.paused.includes(site)) return 'off';
    if (settings.overlayMode === 'off' || lists.overlayNever.includes(site)) return 'off';
    if (settings.overlayMode === 'everywhere' || lists.overlaySites.includes(site)) return 'close';
    return 'learn';
  }

  /* ------------------------------------------------------- your gestures */

  addEventListener('pointerdown', onGesture, true);
  addEventListener('keydown', onGesture, true);
  function onGesture(e) {
    if (!e.isTrusted) return;
    if (e.type === 'pointerdown') pressedAt = performance.now();
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    const interactive = e.type === 'keydown' || !!(t && t.closest && t.closest(INTERACTIVE));
    lastGesture = { t: performance.now(), interactive };
  }
  for (const type of ['pointerup', 'pointercancel']) addEventListener(type, () => { pressedAt = 0; }, true);
  // While you drag (a slider, a splitter), pages put up short-lived shields. Don't judge those.
  const pressing = () => pressedAt > 0 && performance.now() - pressedAt < 5000;

  // When did this popup (or the wrapper it was added in) appear?
  function appearedAt(el) {
    for (let n = el; n && n !== document.body; n = parentOf(n)) {
      const t = changedAt.get(n);
      if (t !== undefined) return t;
    }
    return null;
  }

  // Did you open this? If you pressed a button, link or key up to 1.5 s
  // before it appeared, it's yours (a login box, a menu) and stays.
  function openedByYou(el) {
    let info = firstSeen.get(el);
    if (!info) {
      const g = lastGesture;
      const at = appearedAt(el);
      const user = g.interactive && (at !== null
        ? g.t <= at + 50 && g.t >= at - 1500
        : g.t >= prevScan - 1500); // no observer here: anything since the last check
      info = { user };
      firstSeen.set(el, info);
    }
    return info.user;
  }

  /* ------------------------------------------------------------ geometry */

  const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;
  const area = (r) => Math.max(0, r.width) * Math.max(0, r.height);
  const viewport = () => ({ left: 0, top: 0, right: innerWidth, bottom: innerHeight, width: innerWidth, height: innerHeight });

  function intersect(a, b) {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  }

  function coverage(el) {
    const rect = el.getBoundingClientRect();
    return { rect, cover: intersect(rect, viewport()) / (innerWidth * innerHeight) };
  }

  function shown(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  /* -------------------------------------------------- page-level popups */

  // Outermost position:fixed ancestor (or a modal <dialog>) of a hit element.
  function fixedRoot(el) {
    let root = null;
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      if (n.nodeType !== 1) continue;
      if (n.localName === 'dialog' && n.open && n.matches(':modal')) return n;
      if (getComputedStyle(n).position === 'fixed') root = n;
    }
    return root;
  }

  // 'modal' | 'backdrop' | 'banner' | null
  function classify(root, where) {
    if (C.isOwn(root)) return null;
    const fs = document.fullscreenElement;
    if (fs && (root === fs || root.contains(fs) || fs.contains(root))) return null;
    const cs = getComputedStyle(root);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return null;
    const { rect, cover } = coverage(root);
    if (cover < 0.01) return null;
    for (const f of root.querySelectorAll('iframe')) if (SAFE_FRAME.test(f.src || '')) return null;
    // A fixed element holding most of the page is the site's layout, not a popup.
    const total = document.body.getElementsByTagName('*').length;
    if (total > 150 && root.getElementsByTagName('*').length > total * 0.5) return null;

    const text = (root.innerText || '').replace(/\s+/g, ' ').trim();
    const media = root.querySelector('img,video,iframe,canvas');
    // Full-screen layer with nothing in it: a dimmed backdrop or an invisible click trap.
    if (cover >= 0.85 && text.length < 20 && !media) return 'backdrop';
    if (where === 'center') return Number(cs.opacity) < 0.05 ? null : 'modal';

    if (cover > 0.6 || rect.height < 40 || text.length > 1500 || !BANNER_WORDS.test(text)) return null;
    if (root.querySelector('nav,[role=navigation],input[type=search]')) return null;
    if (root.querySelectorAll('a[href]').length > 8) return null;
    return 'banner';
  }

  function findPagePopups(found) {
    const probe = (points, where) => {
      for (const [px, py] of points) {
        const stack = document.elementsFromPoint(innerWidth * px, innerHeight * py);
        if (!stack.length) continue;
        const root = fixedRoot(stack[0]);
        if (!root || found.has(root)) continue;
        // In the middle it has to sit on top of real content (rules out
        // decorative fixed backgrounds behind the page).
        if (where === 'center' && !stack.some((e) => e !== document.body && e !== document.documentElement
            && !root.contains(e) && !e.contains(root))) continue;
        const type = classify(root, where);
        if (type) found.set(root, type);
      }
    };
    probe(CENTER_PROBES, 'center');
    probe(EDGE_PROBES, 'edge');
    for (const d of document.querySelectorAll('dialog[open]')) {
      if (!found.has(d) && d.matches(':modal') && classify(d, 'center')) found.set(d, 'modal');
    }
  }

  /* ---------------------------------------------- embedded players */

  // Videos and embedded frames big enough to be a player, most important first.
  // Inside a frame only its main content counts; with none, the frame itself.
  function players() {
    const view = viewport();
    const out = [];
    for (const el of document.querySelectorAll('video,iframe')) {
      const rect = el.getBoundingClientRect();
      if (rect.width < MIN_PLAYER.width || rect.height < MIN_PLAYER.height) continue;
      const visible = intersect(rect, view);
      if (visible < area(rect) * 0.3 || (isFrame && visible < area(view) * 0.3)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue;
      if (el.localName === 'iframe' && SAFE_FRAME.test(el.src || '')) continue;
      out.push({ el, rect, video: el.localName === 'video', size: area(rect) });
    }
    out.sort((a, b) => b.size - a.size);
    if (!isFrame) return out.slice(0, 6);
    const videos = out.filter((p) => p.video);
    const main = (videos.length ? videos : out).slice(0, 2);
    return main.length ? main : [{ el: null, rect: view, video: false, size: area(view) }];
  }

  // The whole layer a hit element belongs to: its highest ancestor that does
  // not also hold the player. z is the highest z-index on the way up.
  function layerOf(hit, playerEl) {
    let root = hit;
    let z = parseInt(getComputedStyle(hit).zIndex, 10) || 0;
    for (let p = parentOf(root); p && p !== document.body && p !== document.documentElement; p = parentOf(p)) {
      if (playerEl && p.contains(playerEl)) break;
      root = p;
      z = Math.max(z, parseInt(getComputedStyle(p).zIndex, 10) || 0);
    }
    return { root, z };
  }

  function alphaOf(color) {
    if (color === 'transparent') return 0;
    const m = /^rgba?\((.+)\)$/.exec(color);
    if (!m) return 1;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 ? parseFloat(parts[3]) : 1;
  }

  const painted = (cs) => cs.backgroundImage !== 'none' || alphaOf(cs.backgroundColor) > 0.1;

  // Nothing to see: fully transparent, no picture, no text.
  function invisible(el) {
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) < 0.1) return true;
    if (painted(cs) || el.querySelector('img,svg,picture')) return false;
    if ((el.innerText || '').trim()) return false;
    const inner = el.getElementsByTagName('*');
    if (inner.length > 5) return false;
    for (const child of inner) if (painted(getComputedStyle(child))) return false;
    return true;
  }

  // Holds nothing a player or a real dialog would: no media, controls or text.
  function bare(el) {
    if (el.matches(PLAYER_PARTS) || el.querySelector(PLAYER_PARTS)) return false;
    return (el.innerText || '').replace(/\s+/g, ' ').trim().length <= 40;
  }

  const named = (el) => PLAYER_NAME.test(`${el.getAttribute('class') || ''} ${el.id || ''}`);

  // A link that leaves both this frame's site and the page's site.
  function foreignLink(a) {
    const href = typeof a.href === 'string' ? a.href : '';
    const site = S.isWeb(href) ? S.siteOf(href) : '';
    return !!site && site !== frameSite && site !== C.topSite;
  }

  // What is this thing sitting on top of a video or embedded player?
  // 'adframe' | 'adlink' | 'trap', or null: part of the player, or unknown. Leave it.
  function classifyCover(root, z, player) {
    if (root === document.body || root === document.documentElement || C.isOwn(root)) return null;
    const fs = document.fullscreenElement;
    if (fs && (root === fs || root.contains(fs))) return null;
    const cs = getComputedStyle(root);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.pointerEvents === 'none') return null;
    const over = intersect(root.getBoundingClientRect(), player.rect) / player.size; // share of the player it covers
    if (over < 0.05) return null;

    // Another frame laid over the video inside a player frame: an ad.
    const frames = root.localName === 'iframe' ? [root] : [...root.querySelectorAll('iframe')];
    if (frames.length) {
      if (!isFrame || !player.video || named(root) || root.querySelector('video,audio')) return null;
      if (frames.some((f) => SAFE_FRAME.test(f.src || '') || AD_UI_FRAME.test(f.src || ''))) return null;
      return 'adframe';
    }
    if (named(root) || !bare(root)) return null;

    // A link to another site stretched over the player. (Not judged for a
    // video in the page itself: cards there often link out on purpose.)
    const a = root.matches('a[href]') ? root : root.querySelector('a[href]');
    if (a && foreignLink(a) && (isFrame || !player.video)) {
      const need = !player.el ? 0.7 : (player.video ? 0.3 : 0.5);
      if (over >= need && area(a.getBoundingClientRect()) >= area(root.getBoundingClientRect()) * 0.5) return 'adlink';
    }

    // An invisible layer that only exists to catch your click.
    if (over >= (player.el ? 0.7 : 0.85) && invisible(root)) {
      // Nothing invisible belongs over an embedded frame. Over a video it could
      // be the player's own click layer, so there it also has to look injected.
      if (player.el && !player.video) return 'trap';
      const onBody = root.parentElement === document.body || root.parentElement === document.documentElement;
      if (z >= 9999 || (isFrame && onBody)) return 'trap';
    }
    return null;
  }

  function findCovers(found) {
    for (const player of players()) {
      const r = player.rect;
      for (const [px, py] of CENTER_PROBES) {
        const x = r.left + r.width * px;
        const y = r.top + r.height * py;
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const stack = document.elementsFromPoint(x, y);
        // Everything painted above the player at this point (or, in a frame
        // without a player yet, just the topmost thing).
        const above = player.el ? stack.slice(0, Math.max(0, stack.indexOf(player.el))) : stack.slice(0, 1);
        for (const hit of above) {
          if (player.el && hit.contains(player.el)) continue;
          const { root, z } = layerOf(hit, player.el);
          if (found.has(root)) continue;
          const type = classifyCover(root, z, player);
          if (type) found.set(root, type);
        }
      }
    }
  }

  function findPopups() {
    const found = new Map();
    if (!isFrame) findPagePopups(found);
    findCovers(found);
    return [...found].map(([el, type]) => ({ el, type }));
  }

  /* -------------------------------------------------------------- closing */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function findCloseButton(root) {
    const box = root.getBoundingClientRect();
    let best = null;
    let bestScore = 0;
    let seen = 0;
    const candidates = root.querySelectorAll(
      'button,[role=button],a,[aria-label],[title],[data-dismiss],[data-bs-dismiss],[data-close],' +
      '[class*="close" i],[id*="close" i],[class*="dismiss" i],span,div,i,svg');
    for (const el of candidates) {
      if (++seen > 400) break;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || r.width > 420 || r.height > 120) continue;
      const text = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text.length > 40) continue;
      // Fake close buttons on ad overlays are links to the ad. Never follow one.
      if (el.localName === 'a') {
        const href = el.getAttribute('href') || '';
        if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) continue;
      }
      const label = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
      const cls = `${el.getAttribute('class') || ''} ${el.id || ''}`;
      let score;
      if (CLOSE_TEXT.test(text) || CLOSE_TEXT.test(label)) score = 5;
      else if (NOT_CLOSE.test(text) || NOT_CLOSE.test(label)) continue;
      else if (CLOSE_HINT.test(label)) score = 4;
      else if (el.matches('[data-dismiss],[data-bs-dismiss],[data-close]')) score = 4;
      else if (/(^|[\s_-])(close|dismiss)/i.test(cls)) score = 3;
      else continue;
      if (el.localName === 'button' || el.getAttribute('role') === 'button') score += 1;
      if (r.top < box.top + box.height * 0.35 && r.left > box.left + box.width * 0.5) score += 1; // top-right corner
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  function press(el) {
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
      el.dispatchEvent(new (type.startsWith('pointer') ? PointerEvent : MouseEvent)(type, opts));
    }
    if (typeof el.click === 'function') el.click();
    else el.dispatchEvent(new MouseEvent('click', opts));
  }

  function pressEscape() {
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    }
  }

  function setStyle(el, prop, value, list) {
    list.push({ el, prop, value: el.style.getPropertyValue(prop), priority: el.style.getPropertyPriority(prop) });
    el.style.setProperty(prop, value, 'important');
  }

  function hide(el) {
    hidden.push({ el, prop: 'display', value: el.style.getPropertyValue('display'), priority: el.style.getPropertyPriority('display') });
    el.style.setProperty('display', 'none', 'important');
  }

  // Returns true if the popup is gone afterwards. Modals and banners get
  // their own close button pressed first; everything else is simply hidden.
  async function close({ el, type }) {
    if (!el.isConnected) return false;
    const n = (attempts.get(el) || 0) + 1;
    attempts.set(el, n);
    if (n > 5) return false; // the page keeps putting it back; stop fighting

    if (el.localName === 'dialog' && el.open) {
      el.close();
      if (!el.open) return true;
    }
    if (type === 'modal' || type === 'banner') {
      const button = findCloseButton(el);
      if (button) {
        press(button);
        await sleep(350);
      }
      if (type === 'modal' && shown(el)) {
        pressEscape();
        await sleep(200);
      }
    }
    if (el.isConnected && (type === 'backdrop' || shown(el))) hide(el);
    return true;
  }

  function lockState() {
    const hs = getComputedStyle(document.documentElement);
    const bs = document.body ? getComputedStyle(document.body) : null;
    return {
      html: hs.overflowY === 'hidden',
      body: !!bs && bs.overflowY === 'hidden',
      bodyFixed: !!bs && bs.position === 'fixed'
    };
  }

  // Give scrolling back and un-blur the page, but only undo locks that
  // appeared after the page loaded (some sites scroll inside their own layout).
  function restorePage() {
    const base = baseline || { html: false, body: false, bodyFixed: false };
    const now = lockState();
    if (now.html && !base.html) setStyle(document.documentElement, 'overflow', 'auto', restyled);
    if (now.body && !base.body) setStyle(document.body, 'overflow', 'auto', restyled);
    if (now.bodyFixed && !base.bodyFixed) {
      const top = parseFloat(getComputedStyle(document.body).top) || 0;
      setStyle(document.body, 'position', 'static', restyled);
      if (top < 0) scrollTo(0, -top);
    }
    const layers = [document.documentElement, document.body, ...document.body.children].slice(0, 40);
    for (const el of layers) {
      if (C.isOwn(el) || hidden.some((h) => h.el === el)) continue;
      if (getComputedStyle(el).filter.includes('blur')) setStyle(el, 'filter', 'none', restyled);
    }
  }

  function undo() {
    stopped = true;
    for (const h of hidden.splice(0).reverse()) h.el.style.setProperty(h.prop, h.value, h.priority);
    for (const r of restyled.splice(0).reverse()) r.el.style.setProperty(r.prop, r.value, r.priority);
  }

  // The notice. For a frame, the worker shows it in the page when it gets
  // 'overlayClosed' from here. Its Undo reaches every frame through the worker.
  function notify(n) {
    if (isFrame) return;
    C.toast({
      kind: 'overlay',
      title: 'Popup closed',
      text: learnedNow
        ? `Strict Shield now closes popups on ${C.topSite} automatically.`
        : `Closed ${n === 1 ? 'a popup' : `${n} popups`} covering this page.`
    });
    learnedNow = false;
  }

  /* ------------------------------------------------- proven click traps */

  // Out of the normal flow and lying over most of this frame, or of a player.
  function liesOverPlayer(el) {
    const position = getComputedStyle(el).position;
    if (position !== 'absolute' && position !== 'fixed') return false;
    const rect = el.getBoundingClientRect();
    if (intersect(rect, viewport()) >= innerWidth * innerHeight * 0.5) return true;
    return players().some((p) => p.el && intersect(rect, p.rect) >= p.size * 0.6);
  }

  // guard.js calls this when a click tried to open a popup that was blocked:
  // `el` is the element whose own click handler did it, or the link clicked.
  // If that is an empty layer lying over the page or a player, it is a trap.
  C.onBlockedClick((el, isLink) => {
    if (stopped || !document.body || mode() === 'off') return;
    let layer = null;
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement; n = parentOf(n)) {
      if (!bare(n)) break;
      if (liesOverPlayer(n)) layer = n;
    }
    if (!layer || C.isOwn(layer)) return;
    // Something you can see may be the real play button showing an ad on the
    // first click, so it gets a second chance. A visible link is never hidden
    // here: you may want it (the notice offers "Open once").
    if (!invisible(layer)) {
      if (isLink) return;
      const n = (strikes.get(layer) || 0) + 1;
      strikes.set(layer, n);
      if (n < 2) return;
    }
    hide(layer);
    C.send({ type: 'overlayClosed', count: 1 });
    if (mode() === 'learn' && !counted.has(layer)) C.send({ type: 'overlaySeen', count: 1 });
    counted.add(layer);
    notify(1);
  });

  /* -------------------------------------------------------------- scanning */

  async function scan(force = false) {
    if (busy || !document.body || (stopped && !force)) return 0;
    if (isFrame && (innerWidth < MIN_PLAYER.width || innerHeight < MIN_PLAYER.height)) return 0; // too small to hold a player
    const m = force ? 'close' : mode();
    if (m === 'off') return 0;
    if (pressing() && !force) {
      schedule(500);
      return 0;
    }
    busy = true;
    let closed = 0;
    try {
      // Closing a modal often reveals the next layer (its backdrop, a cookie bar).
      for (let round = 0; round < 4; round++) {
        const popups = findPopups().filter((p) => force || !openedByYou(p.el));
        if (!popups.length) break;
        if (m === 'learn') {
          const fresh = popups.filter((p) => !counted.has(p.el));
          fresh.forEach((p) => counted.add(p.el));
          if (fresh.length) C.send({ type: 'overlaySeen', count: fresh.length });
          break;
        }
        let progress = 0;
        for (const p of popups) {
          if (!(await close(p))) continue;
          progress++;
          C.send({ type: 'overlayClosed', count: 1 }); // logged right away, even if the tab closes next
        }
        closed += progress;
        if (!progress) break;
      }
      if (closed && !isFrame) {
        restorePage();
        notify(closed);
      }
    } finally {
      busy = false;
      prevScan = lastScanEnd = performance.now();
    }
    return closed;
  }

  function schedule(delay) {
    if (timer) return;
    const wait = Math.max(delay, MIN_GAP_MS - (performance.now() - lastScanEnd));
    timer = setTimeout(() => { timer = 0; scan(); }, wait);
  }

  // On sites where it closes popups, react to page changes right away.
  // Elsewhere a few timed checks are enough to learn.
  function watch(m) {
    if (m === 'close' && !observer) {
      observer = new MutationObserver((records) => {
        const now = performance.now();
        for (const r of records) {
          if (r.type === 'attributes') changedAt.set(r.target, now);
          else for (const n of r.addedNodes) if (n.nodeType === 1) changedAt.set(n, now);
        }
        schedule(200);
      });
      observer.observe(document.documentElement, {
        childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'open', 'hidden']
      });
    } else if (m !== 'close' && observer) {
      observer.disconnect();
      observer = null;
    }
  }

  function onConfig() {
    const m = mode();
    if (lastMode === 'learn' && m === 'close') learnedNow = true;
    lastMode = m;
    watch(m);
    if (m !== 'off' && document.body) schedule(100);
  }
  C.onConfig(onConfig);
  if (C.config().loaded) onConfig();

  function onReady() {
    baseline = lockState();
    for (const ms of RESCAN_AFTER_MS) setTimeout(() => schedule(0), ms);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
  else onReady();

  // Scroll-triggered and "exit intent" popups.
  let lastScrollCheck = 0;
  addEventListener('scroll', () => {
    const t = performance.now();
    if (t - lastScrollCheck > 1000) { lastScrollCheck = t; schedule(300); }
  }, { passive: true, capture: true });
  if (document.documentElement) document.documentElement.addEventListener('mouseleave', () => schedule(300));

  // From the worker: the toolbar's "Close popups on this page now" (sent to
  // every frame), and the notice's Undo.
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.type === 'overlayUndo') undo();
      if (!msg || msg.type !== 'closeOverlaysNow') return;
      (async () => {
        for (let i = 0; busy && i < 40; i++) await sleep(50);
        stopped = false;
        sendResponse({ closed: await scan(true) });
      })();
      return true;
    });
  } catch { /* extension reloaded */ }
})();
```


### 2.7 extension/src/content/cosmetic.js

[Open file](extension/src/content/cosmetic.js) · 62 lines


Defines `self.StrictCosmetic`, the list of CSS selectors `guard.js` hides. It is kept narrow on
purpose. Broad patterns like `[class*="ad"]` would hide `header`/`download`/`shadow` elements and set
off anti-adblock checks. To hide more, add a selector here and reload the extension.


```javascript
/*
 * Cosmetic filters: CSS selectors for ad containers that are hidden on every
 * page. Network rules stop most ads from loading; these remove the empty
 * boxes and the ads that are served first-party.
 *
 * Keep selectors specific. Broad ones like [class*="ad"] hide real content
 * ("header", "download", "shadow"...) and trip anti-adblock bait checks.
 */
self.StrictCosmetic = [
  // Google AdSense / Ad Manager
  'ins.adsbygoogle',
  '.adsbygoogle',
  '[id^="div-gpt-ad"]',
  '[id^="google_ads_iframe"]',
  '[id^="google_ads_frame"]',
  '[data-google-query-id]',
  '[data-ad-client]',
  '[data-ad-slot]',
  '[data-ad-unit]',
  '[data-adunit]',
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="amazon-adsystem.com"]',
  'iframe[src*="adnxs.com"]',
  'iframe[src*="taboola.com"]',
  'iframe[src*="outbrain.com"]',
  // Standard IAB banner sizes
  'iframe[width="728"][height="90"]',
  'iframe[width="300"][height="250"]',
  'iframe[width="160"][height="600"]',
  'iframe[width="320"][height="50"]',
  'iframe[width="970"][height="250"]',
  // AMP
  'amp-ad',
  'amp-sticky-ad',
  'amp-embed[type="taboola"]',
  'amp-embed[type="outbrain"]',
  'amp-embed[type="mgid"]',
  // Native-ad widgets
  '.trc_rbox_container',
  '[id^="taboola-"]',
  '.OUTBRAIN',
  '.ob-widget',
  '[data-widget-id][class*="outbrain"]',
  '[id^="mgid_"]',
  '[id^="rc-widget-"]',
  // Common ad slot names used by CMSs and ad managers
  '.ad-slot',
  '.ad-unit',
  '.ad-container',
  '.ad-wrapper',
  '.ad-leaderboard',
  '.adslot',
  '.adunit',
  '.advertisement',
  '.sponsored-ad',
  '[id^="ad-slot"]',
  '[id^="adslot"]',
  '[aria-label="Advertisement"]',
  '[aria-label="advertisement"]',
  '[aria-label="Sponsored ad"]'
];
```


## Filter lists and the rule builder

Edit the `.txt` files, then run `node tools/build-rules.mjs` to regenerate the JSON that Chrome reads.


### 2.8 filters/ads.txt

[Open file](filters/ads.txt) · 117 lines


Ad servers, exchanges, verification, native-ad widgets and popup/popunder networks, plus two `prebid` path rules.


```text
# Ad servers, ad exchanges, popup/popunder and native-ad networks.
# One domain per line; subdomains are blocked too. Lines starting with # are comments.
# Path rules use the declarativeNetRequest urlFilter syntax and start with "||" or "/".
# Rebuild after editing:  node tools/build-rules.mjs

# Google
doubleclick.net
googlesyndication.com
googleadservices.com
googletagservices.com
adservice.google.com
adservice.google.co.in
adservice.google.co.uk
fundingchoicesmessages.google.com
2mdn.net

# Exchanges / SSPs / DSPs
adnxs.com
adsrvr.org
adform.net
adroll.com
amazon-adsystem.com
bidswitch.net
casalemedia.com
contextweb.com
criteo.com
criteo.net
indexww.com
openx.net
pubmatic.com
rubiconproject.com
smartadserver.com
spotxchange.com
spotx.tv
teads.tv
tribalfusion.com
yieldmo.com
33across.com
sharethrough.com
sovrn.com
lijit.com
gumgum.com
media.net
yieldlab.net
stickyadstv.com
smaato.net
adtechus.com
advertising.com
serving-sys.com
flashtalking.com
innovid.com
zedo.com
districtm.io
an.facebook.com
ads.linkedin.com
ads-twitter.com
ads.yahoo.com
inmobi.com
applovin.com
unityads.unity3d.com
vungle.com
chartboost.com
adcolony.com

# Ad verification / viewability
moatads.com
doubleverify.com
adsafeprotected.com

# Native / "around the web" widgets
taboola.com
outbrain.com
zemanta.com
revcontent.com
mgid.com
adblade.com
content.ad

# Popup, popunder and push-ad networks
propellerads.com
propellerclick.com
monetag.com
popads.net
popcash.net
adsterra.com
exoclick.com
exosrv.com
clickadu.com
hilltopads.net
adcash.com
ad-maven.com
galaksion.com
trafficstars.com
tsyndicate.com
juicyads.com
plugrush.com
adxpansion.com
ero-advertising.com
trafficjunky.net
trafficjunky.com
trafficfactory.biz
adskeeper.com
adskeeper.co.uk
bidvertiser.com
infolinks.com
chitika.com
yllix.com
a-ads.com
coinzilla.com
coinzilla.io
bitmedia.io
buysellads.com
carbonads.net

# Header-bidding scripts, wherever they are hosted
/prebid.js
/prebid.min.js
```


### 2.9 filters/trackers.txt

[Open file](filters/trackers.txt) · 72 lines


Analytics, session recording and data brokers. The `||…` lines block only specific paths (Facebook pixel, GA4 collect, Reddit pixel) so the rest of those sites keeps working.


```text
# Analytics, session recording and cross-site tracking.
# Same format as ads.txt. Rebuild after editing:  node tools/build-rules.mjs

google-analytics.com
googletagmanager.com
||analytics.google.com/g/collect
hotjar.com
hotjar.io
mouseflow.com
fullstory.com
crazyegg.com
luckyorange.com
luckyorange.net
clarity.ms
cdn.segment.com
api.segment.io
mxpnl.com
api-js.mixpanel.com
api.amplitude.com
api2.amplitude.com
cdn.amplitude.com
heapanalytics.com
chartbeat.com
chartbeat.net
nr-data.net
js-agent.newrelic.com
quantserve.com
quantcount.com
scorecardresearch.com
imrworldwide.com
omtrdc.net
2o7.net
demdex.net
everesttech.net
krxd.net
bluekai.com
exelator.com
agkn.com
rlcdn.com
adsymptotic.com
tapad.com
mathtag.com
crwdcntrl.net
eyeota.net
liadm.com
id5-sync.com
bounceexchange.com
pippio.com
addthis.com
sharethis.com
bat.bing.com
snap.licdn.com
analytics.tiktok.com
tr.snapchat.com
analytics.twitter.com
ct.pinterest.com
mc.yandex.ru
mc.yandex.com
hm.baidu.com
cnzz.com
c.statcounter.com
histats.com
in.getclicky.com
static.getclicky.com
static.cloudflareinsights.com
hs-analytics.net
track.hubspot.com
munchkin.marketo.net
pi.pardot.com
||connect.facebook.net/*/fbevents.js
||facebook.com/tr^
||redditstatic.com/ads/
```


### 2.10 tools/build-rules.mjs

[Open file](tools/build-rules.mjs) · 96 lines


- `parseList()` accepts plain domains, Adblock Plus `||domain^` (with options) and `||`/`/` path
  rules. It skips comments, cosmetic (`##`) and exception (`@@`) rules. It also drops domains whose
  parent domain is already listed.
- `toRules()` puts **all domains into one rule** (`requestDomains`), which keeps the rule count tiny.
  Each path filter becomes its own `urlFilter` rule. The trackers list also gets a rule that blocks
  third-party `ping` requests.
- `--import file --into ads|trackers` adds the domain rules from a large list such as EasyList to
  a `.txt` file.


```javascript
#!/usr/bin/env node
/*
 * Turns the human-editable lists in filters/*.txt into Chrome
 * declarativeNetRequest rulesets in extension/rules/*.json.
 *
 *   node tools/build-rules.mjs
 *   node tools/build-rules.mjs --import easylist.txt --into ads
 *
 * List syntax (one per line, # starts a comment):
 *   example.com                  block example.com and all subdomains
 *   ||example.com^               same thing, Adblock Plus style
 *   ||example.com/path/*.js      urlFilter rule (blocks matching URLs only)
 *   /prebid.js                   urlFilter rule matched anywhere in a URL
 *
 * --import pulls the domain-only rules ("||domain^", optionally with
 * $third-party etc.) out of an Adblock Plus style list such as EasyList and
 * merges them into the chosen list. Check the list's licence before shipping.
 */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const LISTS = ['ads', 'trackers'];
const DOMAIN = /^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/;

function parseList(text) {
  const domains = new Set();
  const filters = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!') || line.startsWith('[')) continue;
    if (line.startsWith('@@') || line.includes('##') || line.includes('#@#') || line.includes('#?#')) continue;
    const abpDomain = line.match(/^\|\|([a-z0-9.-]+)\^(\$[^,]*(,[^,]*)*)?$/i);
    if (abpDomain && !/\$.*(domain=|~third-party|first-party|1p)/.test(line)) {
      const d = abpDomain[1].toLowerCase();
      if (DOMAIN.test(d)) domains.add(d);
      continue;
    }
    if (line.startsWith('||') || line.startsWith('/')) {
      filters.add(line.split('$')[0]);
      continue;
    }
    const d = line.toLowerCase();
    if (DOMAIN.test(d)) domains.add(d);
    else console.warn(`skipped: ${line}`);
  }
  // Drop domains already covered by a parent domain in the list.
  for (const d of domains) {
    const parts = d.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (domains.has(parts.slice(i).join('.'))) { domains.delete(d); break; }
    }
  }
  return { domains: [...domains].sort(), filters: [...filters].sort() };
}

function toRules(name, { domains, filters }) {
  const rules = [];
  let id = 1;
  if (domains.length) {
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { requestDomains: domains } });
  }
  for (const urlFilter of filters) {
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { urlFilter, isUrlFilterCaseSensitive: false } });
  }
  if (name === 'trackers') {
    // <a ping> and navigator.sendBeacon() to other sites are pure tracking.
    rules.push({ id: id++, priority: 1, action: { type: 'block' }, condition: { domainType: 'thirdParty', resourceTypes: ['ping'] } });
  }
  return rules;
}

const args = process.argv.slice(2);
const importIdx = args.indexOf('--import');
if (importIdx !== -1) {
  const source = args[importIdx + 1];
  const into = args[args.indexOf('--into') + 1] || 'ads';
  if (!source || !LISTS.includes(into)) {
    console.error('usage: node tools/build-rules.mjs --import <file> --into ads|trackers');
    process.exit(1);
  }
  const imported = parseList(readFileSync(source, 'utf8')).domains;
  const target = join(root, 'filters', `${into}.txt`);
  const existing = new Set(parseList(readFileSync(target, 'utf8')).domains);
  const fresh = imported.filter((d) => !existing.has(d));
  appendFileSync(target, `\n# Imported from ${source} on ${new Date().toISOString().slice(0, 10)}\n${fresh.join('\n')}\n`);
  console.log(`imported ${fresh.length} new domains into filters/${into}.txt`);
}

for (const name of LISTS) {
  const parsed = parseList(readFileSync(join(root, 'filters', `${name}.txt`), 'utf8'));
  const rules = toRules(name, parsed);
  writeFileSync(join(root, 'extension', 'rules', `${name}.json`), JSON.stringify(rules, null, 1) + '\n');
  console.log(`${name}: ${parsed.domains.length} domains, ${parsed.filters.length} url filters -> ${rules.length} rules`);
}
```


### 2.11 extension/rules/ads.json

[Open file](extension/rules/ads.json) · 134 lines


Generated by `build-rules.mjs`. Don't edit by hand.


```json
[
 {
  "id": 1,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "requestDomains": [
    "2mdn.net",
    "33across.com",
    "a-ads.com",
    "ad-maven.com",
    "adblade.com",
    "adcash.com",
    "adcolony.com",
    "adform.net",
    "adnxs.com",
    "adroll.com",
    "ads-twitter.com",
    "ads.linkedin.com",
    "ads.yahoo.com",
    "adsafeprotected.com",
    "adservice.google.co.in",
    "adservice.google.co.uk",
    "adservice.google.com",
    "adskeeper.co.uk",
    "adskeeper.com",
    "adsrvr.org",
    "adsterra.com",
    "adtechus.com",
    "advertising.com",
    "adxpansion.com",
    "amazon-adsystem.com",
    "an.facebook.com",
    "applovin.com",
    "bidswitch.net",
    "bidvertiser.com",
    "bitmedia.io",
    "buysellads.com",
    "carbonads.net",
    "casalemedia.com",
    "chartboost.com",
    "chitika.com",
    "clickadu.com",
    "coinzilla.com",
    "coinzilla.io",
    "content.ad",
    "contextweb.com",
    "criteo.com",
    "criteo.net",
    "districtm.io",
    "doubleclick.net",
    "doubleverify.com",
    "ero-advertising.com",
    "exoclick.com",
    "exosrv.com",
    "flashtalking.com",
    "fundingchoicesmessages.google.com",
    "galaksion.com",
    "googleadservices.com",
    "googlesyndication.com",
    "googletagservices.com",
    "gumgum.com",
    "hilltopads.net",
    "indexww.com",
    "infolinks.com",
    "inmobi.com",
    "innovid.com",
    "juicyads.com",
    "lijit.com",
    "media.net",
    "mgid.com",
    "moatads.com",
    "monetag.com",
    "openx.net",
    "outbrain.com",
    "plugrush.com",
    "popads.net",
    "popcash.net",
    "propellerads.com",
    "propellerclick.com",
    "pubmatic.com",
    "revcontent.com",
    "rubiconproject.com",
    "serving-sys.com",
    "sharethrough.com",
    "smaato.net",
    "smartadserver.com",
    "sovrn.com",
    "spotx.tv",
    "spotxchange.com",
    "stickyadstv.com",
    "taboola.com",
    "teads.tv",
    "trafficfactory.biz",
    "trafficjunky.com",
    "trafficjunky.net",
    "trafficstars.com",
    "tribalfusion.com",
    "tsyndicate.com",
    "unityads.unity3d.com",
    "vungle.com",
    "yieldlab.net",
    "yieldmo.com",
    "yllix.com",
    "zedo.com",
    "zemanta.com"
   ]
  }
 },
 {
  "id": 2,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "/prebid.js",
   "isUrlFilterCaseSensitive": false
  }
 },
 {
  "id": 3,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "/prebid.min.js",
   "isUrlFilterCaseSensitive": false
  }
 }
]
```


### 2.12 extension/rules/trackers.json

[Open file](extension/rules/trackers.json) · 135 lines


Generated by `build-rules.mjs`. Don't edit by hand.


```json
[
 {
  "id": 1,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "requestDomains": [
    "2o7.net",
    "addthis.com",
    "adsymptotic.com",
    "agkn.com",
    "analytics.tiktok.com",
    "analytics.twitter.com",
    "api-js.mixpanel.com",
    "api.amplitude.com",
    "api.segment.io",
    "api2.amplitude.com",
    "bat.bing.com",
    "bluekai.com",
    "bounceexchange.com",
    "c.statcounter.com",
    "cdn.amplitude.com",
    "cdn.segment.com",
    "chartbeat.com",
    "chartbeat.net",
    "clarity.ms",
    "cnzz.com",
    "crazyegg.com",
    "crwdcntrl.net",
    "ct.pinterest.com",
    "demdex.net",
    "everesttech.net",
    "exelator.com",
    "eyeota.net",
    "fullstory.com",
    "google-analytics.com",
    "googletagmanager.com",
    "heapanalytics.com",
    "histats.com",
    "hm.baidu.com",
    "hotjar.com",
    "hotjar.io",
    "hs-analytics.net",
    "id5-sync.com",
    "imrworldwide.com",
    "in.getclicky.com",
    "js-agent.newrelic.com",
    "krxd.net",
    "liadm.com",
    "luckyorange.com",
    "luckyorange.net",
    "mathtag.com",
    "mc.yandex.com",
    "mc.yandex.ru",
    "mouseflow.com",
    "munchkin.marketo.net",
    "mxpnl.com",
    "nr-data.net",
    "omtrdc.net",
    "pi.pardot.com",
    "pippio.com",
    "quantcount.com",
    "quantserve.com",
    "rlcdn.com",
    "scorecardresearch.com",
    "sharethis.com",
    "snap.licdn.com",
    "static.cloudflareinsights.com",
    "static.getclicky.com",
    "tapad.com",
    "tr.snapchat.com",
    "track.hubspot.com"
   ]
  }
 },
 {
  "id": 2,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "||analytics.google.com/g/collect",
   "isUrlFilterCaseSensitive": false
  }
 },
 {
  "id": 3,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "||connect.facebook.net/*/fbevents.js",
   "isUrlFilterCaseSensitive": false
  }
 },
 {
  "id": 4,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "||facebook.com/tr^",
   "isUrlFilterCaseSensitive": false
  }
 },
 {
  "id": 5,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "urlFilter": "||redditstatic.com/ads/",
   "isUrlFilterCaseSensitive": false
  }
 },
 {
  "id": 6,
  "priority": 1,
  "action": {
   "type": "block"
  },
  "condition": {
   "domainType": "thirdParty",
   "resourceTypes": [
    "ping"
   ]
  }
 }
]
```


## Extension pages


### 2.13 extension/pages/common.css

[Open file](extension/pages/common.css) · 89 lines


Shared design tokens (light and dark through `prefers-color-scheme`), buttons, switches, pills and the segmented control used by every page.


```css
:root {
  --bg: #f6f7f9;
  --card: #ffffff;
  --text: #15171a;
  --muted: #5f6670;
  --line: #e3e6ea;
  --brand: #c62828;
  --brand-soft: #fdecec;
  --ok: #1b7f4b;
  --ok-soft: #e6f4ec;
  --warn: #9a5b00;
  --warn-soft: #fff4e0;
  --chip: #eef0f3;
  --focus: #2563eb;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #111316;
    --card: #1a1d21;
    --text: #eceef1;
    --muted: #9aa1ab;
    --line: #2b3036;
    --brand: #ef5350;
    --brand-soft: #3a1d1d;
    --ok: #4cc38a;
    --ok-soft: #173025;
    --warn: #f0b354;
    --warn-soft: #33270f;
    --chip: #262a30;
    --focus: #60a5fa;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
h1, h2, h3 { margin: 0; line-height: 1.25; }
a { color: inherit; }
code, .mono { font-family: var(--mono); font-size: 12.5px; }
.muted { color: var(--muted); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; }

button, .btn {
  font: inherit; cursor: pointer; border-radius: 8px; padding: 7px 14px;
  border: 1px solid var(--line); background: var(--card); color: var(--text);
}
button:hover { border-color: var(--muted); }
button.primary { background: var(--brand); border-color: var(--brand); color: #fff; }
button.primary:hover { filter: brightness(1.08); }
button.link { border: 0; background: none; padding: 0; color: var(--muted); text-decoration: underline; }
button.link:hover { color: var(--text); }
button.danger { color: var(--brand); }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

input[type="text"], input[type="search"], select {
  font: inherit; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--bg); color: var(--text); min-width: 0;
}

/* Switch */
.switch { position: relative; display: inline-block; width: 38px; height: 22px; flex: none; }
.switch input { opacity: 0; width: 0; height: 0; position: absolute; }
.switch span {
  position: absolute; inset: 0; border-radius: 999px; background: var(--line); transition: background .15s;
}
.switch span::after {
  content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,.3); transition: transform .15s;
}
.switch input:checked + span { background: var(--brand); }
.switch input:checked + span::after { transform: translateX(16px); }
.switch input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 2px; }

.row { display: flex; align-items: center; gap: 12px; }
.row > .grow { flex: 1; min-width: 0; }
.pill { display: inline-block; padding: 1px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; }
.pill.ok { background: var(--ok-soft); color: var(--ok); }
.pill.off { background: var(--warn-soft); color: var(--warn); }
.pill.kind { background: var(--chip); color: var(--muted); font-weight: 500; }

.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.seg button { border: 0; border-radius: 0; padding: 5px 11px; background: transparent; color: var(--muted); }
.seg button + button { border-left: 1px solid var(--line); }
.seg button[aria-pressed="true"] { background: var(--brand); color: #fff; }
```


### 2.14 extension/pages/ui.js

[Open file](extension/pages/ui.js) · 41 lines


Small helpers for the popup and options pages: `UI.send()` (a message that throws on `{error}`), `UI.h()` (builds DOM elements without `innerHTML`, so URLs are never treated as HTML), `UI.timeAgo()` and the kind labels.


```javascript
/* Small helpers shared by the popup and options pages. */
const UI = {
  send(msg) {
    return chrome.runtime.sendMessage(msg).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r;
    });
  },

  // h('li', { className: 'x', onclick }, 'text', childNode)
  h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v !== undefined && v !== null) el[k] = v;
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  },

  timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  },

  KIND_LABEL: {
    popup: 'Popup',
    navigation: 'Redirect',
    link: 'Link',
    blocklist: 'Blocklist',
    overlay: 'On-screen'
  }
};
```


### 2.15 extension/pages/popup.html

[Open file](extension/pages/popup.html) · 92 lines


The toolbar popup: the current site, two counters, four controls (protection, let this site open other sites, auto-close on-screen popups, Strict/Balanced), the **Close popups on this page now** button and the last five blocks on this site.


```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Strict Shield</title>
  <link rel="stylesheet" href="common.css">
  <style>
    body { width: 340px; padding: 14px; }
    header { margin-bottom: 12px; }
    header img { width: 24px; height: 24px; }
    header h1 { font-size: 15px; }
    .site { font-weight: 600; font-size: 15px; word-break: break-all; }
    .stats { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin: 12px 0; }
    .stat { padding: 10px 12px; }
    .stat b { display: block; font-size: 22px; line-height: 1.1; font-variant-numeric: tabular-nums; }
    .stat span { font-size: 12px; color: var(--muted); }
    .controls { padding: 4px 12px; }
    .controls .row { padding: 9px 0; }
    .controls .row + .row { border-top: 1px solid var(--line); }
    .controls small { display: block; color: var(--muted); font-size: 12px; }
    .zap { margin-top: 10px; display: grid; gap: 6px; }
    .zap button { width: 100%; }
    .zap span { font-size: 12px; text-align: center; }
    h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 6px; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { padding: 6px 0; border-bottom: 1px solid var(--line); font-size: 12.5px; }
    li .u { word-break: break-all; }
    .empty { color: var(--muted); font-size: 12.5px; padding: 6px 0; }
    footer { margin-top: 12px; display: flex; justify-content: space-between; }
    .unsupported { padding: 14px; text-align: center; color: var(--muted); }
  </style>
</head>
<body>
  <header class="row">
    <img src="../icons/icon48.png" alt="">
    <h1 class="grow">Strict Shield</h1>
    <button class="link" id="openOptions">Settings</button>
  </header>

  <div id="unsupported" class="card unsupported" hidden>Strict Shield doesn't run on browser pages like this one.</div>

  <main id="main" hidden>
    <div class="row">
      <div class="grow site" id="site"></div>
      <span class="pill" id="status"></span>
    </div>

    <div class="stats">
      <div class="card stat"><b id="netCount">–</b><span>requests blocked on this tab</span></div>
      <div class="card stat"><b id="pageCount">0</b><span>popups, redirects &amp; overlays blocked here</span></div>
    </div>

    <div class="card controls">
      <label class="row">
        <div class="grow">Protection on this site<small>Turn off if the site is broken</small></div>
        <span class="switch"><input type="checkbox" id="protect"><span></span></span>
      </label>
      <label class="row">
        <div class="grow">Let this site open other sites<small>Allows its popups and outbound redirects</small></div>
        <span class="switch"><input type="checkbox" id="outbound"><span></span></span>
      </label>
      <label class="row">
        <div class="grow">Auto-close on-screen popups<small id="overlayHint"></small></div>
        <span class="switch"><input type="checkbox" id="overlay"><span></span></span>
      </label>
      <div class="row">
        <div class="grow">Links to other sites<small id="modeHint"></small></div>
        <div class="seg" id="mode">
          <button data-mode="strict">Strict</button>
          <button data-mode="balanced">Balanced</button>
        </div>
      </div>
    </div>

    <div class="zap">
      <button id="zap">Close popups on this page now</button>
      <span class="muted" id="zapResult" role="status"></span>
    </div>

    <h2>Recently blocked here</h2>
    <ul id="recent"></ul>
  </main>

  <footer>
    <button class="link" id="openHistory">All blocked pages</button>
    <span class="muted" id="version"></span>
  </footer>
  <script src="../src/lib/site.js"></script>
  <script src="ui.js"></script>
  <script src="popup.js"></script>
</body>
</html>
```


### 2.16 extension/pages/popup.js

[Open file](extension/pages/popup.js) · 120 lines


- Reads the active tab. On browser pages (`chrome://…`) it shows the "doesn't run here" card.
- **Requests blocked on this tab** comes from `declarativeNetRequest.getMatchedRules({ tabId })`.
- Switching **Protection** off adds the site to `paused` and reloads the tab, because pause takes
  effect on the next page load.
- **Auto-close on-screen popups**: on adds the site to `overlaySites` and removes it from
  `overlayNever`; off does the opposite, so learning won't turn it back on.
- **Close popups on this page now** sends `closeOverlays` to the worker, which asks every frame of
  the tab. If anything was closed and the mode is `auto`, the site is added to `overlaySites`.
- It re-renders on every `storage.onChanged`, so it stays live while open.


```javascript
(async () => {
  const S = self.StrictSite;
  const { h, send, timeAgo, KIND_LABEL } = UI;
  const $ = (id) => document.getElementById(id);

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('openHistory').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#history') });
    window.close();
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !S.isWeb(tab.url)) {
    $('unsupported').hidden = false;
    return;
  }
  const site = S.siteOf(tab.url);
  $('main').hidden = false;
  $('site').textContent = site;

  // Network requests blocked on this tab.
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    $('netCount').textContent = rulesMatchedInfo.length;
  } catch {
    $('netCount').textContent = '–';
  }

  function render({ settings, lists, log }) {
    const paused = lists.paused.includes(site);
    $('status').textContent = paused ? 'Paused' : 'Protected';
    $('status').className = 'pill ' + (paused ? 'off' : 'ok');
    $('protect').checked = !paused;
    $('outbound').checked = lists.allowOutbound.includes(site);
    $('outbound').disabled = paused;

    for (const b of $('mode').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === settings.navMode));
    }
    const om = settings.overlayMode;
    const never = lists.overlayNever.includes(site);
    const overlayOn = !paused && om !== 'off' && !never && (om === 'everywhere' || lists.overlaySites.includes(site));
    $('overlay').checked = overlayOn;
    $('overlay').disabled = paused || om === 'off';
    $('overlayHint').textContent = paused ? 'Protection is paused here'
      : om === 'off' ? 'Turned off in Settings'
      : overlayOn ? 'Closes newsletter boxes, cookie walls and overlays'
      : never ? 'Never on this site'
      : 'Turns on by itself if this site keeps showing popups';

    $('modeHint').textContent = {
      strict: 'Every link to another site asks first',
      balanced: 'Links you click open; redirects and popups are blocked',
      off: 'Only popups are blocked'
    }[settings.navMode] || '';

    const mine = log.filter((e) => e.fromSite === site);
    $('pageCount').textContent = mine.reduce((n, e) => n + e.count, 0);
    const list = $('recent');
    list.replaceChildren();
    if (!mine.length) list.append(h('div', { className: 'empty' }, 'Nothing blocked on this site yet.'));
    for (const e of mine.slice(0, 5)) {
      list.append(h('li', {},
        h('div', { className: 'row' },
          h('span', { className: 'pill kind' }, KIND_LABEL[e.kind] || e.kind),
          h('span', { className: 'grow u' }, S.hostOf(e.url) || e.url),
          h('span', { className: 'muted' }, (e.count > 1 ? `${e.count}× · ` : '') + timeAgo(e.last))
        )
      ));
    }
  }

  async function refresh() {
    const r = await chrome.storage.local.get(['settings', 'lists', 'log']);
    const cfg = S.withDefaults(r.settings, r.lists);
    render({ ...cfg, log: r.log || [] });
  }

  $('protect').onchange = async (e) => {
    await send({ type: 'listOp', list: 'paused', op: e.target.checked ? 'remove' : 'add', value: site });
    chrome.tabs.reload(tab.id);
  };
  $('outbound').onchange = (e) =>
    send({ type: 'listOp', list: 'allowOutbound', op: e.target.checked ? 'add' : 'remove', value: site });
  $('overlay').onchange = async (e) => {
    const on = e.target.checked;
    await send({ type: 'listOp', list: on ? 'overlayNever' : 'overlaySites', op: 'remove', value: site });
    await send({ type: 'listOp', list: on ? 'overlaySites' : 'overlayNever', op: 'add', value: site });
  };

  $('zap').onclick = async () => {
    $('zap').disabled = true;
    $('zapResult').textContent = 'Looking…';
    // The worker asks the page and every frame inside it (embedded players).
    const r = await send({ type: 'closeOverlays', tabId: tab.id }).catch(() => null);
    if (!r || !r.reached) {
      $('zapResult').textContent = 'Reload the page first, then try again.';
    } else if (!r.closed) {
      $('zapResult').textContent = 'Nothing covering this page.';
    } else {
      // You had to close them by hand: treat this site as heavy on popups.
      const stored = await chrome.storage.local.get(['settings', 'lists']);
      const { settings, lists } = S.withDefaults(stored.settings, stored.lists);
      const learn = settings.overlayMode === 'auto' && !lists.overlaySites.includes(site) && !lists.overlayNever.includes(site);
      if (learn) await send({ type: 'listOp', list: 'overlaySites', op: 'add', value: site });
      $('zapResult').textContent = `Closed ${r.closed === 1 ? '1 popup' : `${r.closed} popups`}.`
        + (learn ? ' They will close by themselves here from now on.' : '');
    }
    $('zap').disabled = false;
  };

  $('mode').onclick = (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (mode) send({ type: 'setSettings', patch: { navMode: mode } });
  };

  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') refresh(); });
  refresh();
})();
```


### 2.17 extension/pages/options.html

[Open file](extension/pages/options.html) · 196 lines


Settings, with four tabs selected by URL hash (`#protection`, `#lists`, `#history`, `#how`). Section ids are `sec-…` so the browser doesn't scroll to them.


```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Strict Shield settings</title>
  <link rel="stylesheet" href="common.css">
  <style>
    .wrap { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; }
    header.top { display: flex; align-items: center; gap: 12px; margin-bottom: 8px; }
    header.top img { width: 36px; height: 36px; }
    header.top h1 { font-size: 22px; }
    nav { display: flex; gap: 18px; flex-wrap: wrap; margin: 12px 0 24px; border-bottom: 1px solid var(--line); }
    nav a { text-decoration: none; color: var(--muted); padding: 8px 0; border-bottom: 2px solid transparent; }
    nav a.active { color: var(--text); border-bottom-color: var(--brand); }
    section { display: none; }
    section.active { display: block; }
    h2 { font-size: 16px; margin: 0 0 4px; }
    .lead { color: var(--muted); margin: 0 0 16px; }
    .card { padding: 4px 18px; margin-bottom: 18px; }
    .opt { display: flex; gap: 14px; align-items: flex-start; padding: 14px 0; }
    .opt + .opt { border-top: 1px solid var(--line); }
    .opt .grow { flex: 1; }
    .opt b { display: block; font-weight: 600; }
    .opt p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
    .radio { display: grid; gap: 10px; margin-top: 10px; }
    .radio label { display: flex; gap: 10px; align-items: flex-start; cursor: pointer; }
    .radio input { margin-top: 4px; accent-color: var(--brand); }
    .radio span { color: var(--muted); font-size: 13px; }
    .radio strong { color: var(--text); font-weight: 600; }

    .list { padding: 16px 18px; }
    .list h3 { font-size: 14px; }
    .list p { margin: 2px 0 10px; color: var(--muted); font-size: 13px; }
    .add { display: flex; gap: 8px; }
    .add input { flex: 1; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .chip { display: inline-flex; align-items: center; gap: 4px; background: var(--chip); border-radius: 999px;
      padding: 2px 4px 2px 10px; font-family: var(--mono); font-size: 12.5px; }
    .chip button { border: 0; background: none; padding: 0 6px; color: var(--muted); font-size: 15px; line-height: 1; }
    .chip button:hover { color: var(--brand); }
    .chips .none { color: var(--muted); font-size: 13px; }

    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    .toolbar input { flex: 1; min-width: 160px; }
    .summary { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; }
    .summary .card { margin: 0; padding: 10px 14px; flex: 1; min-width: 130px; }
    .summary b { display: block; font-size: 20px; font-variant-numeric: tabular-nums; }
    .summary span { color: var(--muted); font-size: 12px; }
    .table-wrap { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
    th { color: var(--muted); font-weight: 600; font-size: 12px; white-space: nowrap; }
    td.url { word-break: break-all; min-width: 220px; }
    td.url small { display: block; color: var(--muted); }
    td.n { text-align: right; font-variant-numeric: tabular-nums; }
    td.act { white-space: nowrap; }
    td.act button { padding: 3px 8px; font-size: 12px; }
    .empty { color: var(--muted); padding: 24px 10px; text-align: center; }
    .more { text-align: center; margin-top: 12px; }

    .how { padding: 18px; }
    .how ol { padding-left: 20px; margin: 8px 0 0; }
    .how li { margin-bottom: 10px; }
    .how li b { display: block; }
    .danger-zone { margin-top: 24px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="top">
      <img src="../icons/icon128.png" alt="">
      <div>
        <h1>Strict Shield</h1>
        <div class="muted">A page may only open its own site. Everything else asks first.</div>
      </div>
    </header>

    <nav>
      <a href="#protection">Protection</a>
      <a href="#lists">Allow &amp; block lists</a>
      <a href="#history">Blocked history</a>
      <a href="#how">How filtering works</a>
    </nav>

    <section id="sec-protection">
      <div class="card">
        <div class="opt">
          <div class="grow"><b>Block ads</b><p>Stops requests to ad servers, popup networks and native-ad widgets.</p></div>
          <span class="switch"><input type="checkbox" data-setting="blockAds"><span></span></span>
        </div>
        <div class="opt">
          <div class="grow"><b>Block trackers</b><p>Stops analytics, session recording, tracking pixels and cross-site pings.</p></div>
          <span class="switch"><input type="checkbox" data-setting="blockTrackers"><span></span></span>
        </div>
        <div class="opt">
          <div class="grow"><b>Hide ad boxes</b><p>Hides leftover ad containers on the page (cosmetic filtering).</p></div>
          <span class="switch"><input type="checkbox" data-setting="cosmetic"><span></span></span>
        </div>
        <div class="opt">
          <div class="grow"><b>Block popups to other sites</b><p>Closes new tabs and windows a page opens to a different site, including popunders.</p></div>
          <span class="switch"><input type="checkbox" data-setting="blockPopups"><span></span></span>
        </div>
        <div class="opt">
          <div class="grow">
            <b>On-screen popups</b>
            <p>Newsletter boxes, cookie walls, "turn off your ad blocker" messages, notification prompts and invisible click-trap layers. Strict Shield presses their own close or "No thanks" / "Reject all" button (never Accept, Allow or Subscribe), or hides them, then gives scrolling back. Popups you open yourself are left alone.</p>
            <div class="radio" id="overlayMode">
              <label><input type="radio" name="overlayMode" value="auto"><div><strong>Auto</strong> <span>(default) — close them on sites that keep showing popups (learned after 3) and on sites you add.</span></div></label>
              <label><input type="radio" name="overlayMode" value="everywhere"><div><strong>Every site</strong> <span>— close them everywhere except sites on your "never" list.</span></div></label>
              <label><input type="radio" name="overlayMode" value="off"><div><strong>Off</strong> <span>— never close them by themselves. The toolbar button still works.</span></div></label>
            </div>
          </div>
        </div>
        <div class="opt">
          <div class="grow">
            <b>Links and redirects to other sites</b>
            <div class="radio" id="navMode">
              <label><input type="radio" name="navMode" value="strict"><div><strong>Strict</strong> <span>(default) — every link, redirect or form that leaves the site is stopped and asks you first.</span></div></label>
              <label><input type="radio" name="navMode" value="balanced"><div><strong>Balanced</strong> <span>— links you click yourself open normally; automatic redirects and scripted navigation are still blocked.</span></div></label>
              <label><input type="radio" name="navMode" value="off"><div><strong>Off</strong> <span>— only popups are blocked.</span></div></label>
            </div>
          </div>
        </div>
        <div class="opt">
          <div class="grow"><b>Allow sign-in and payment providers</b><p>Lets "Sign in with Google/Microsoft/Apple", PayPal, Stripe, Razorpay, Paytm and similar open and send you back. Turn off to block them too.</p></div>
          <span class="switch"><input type="checkbox" data-setting="trustProviders"><span></span></span>
        </div>
        <div class="opt">
          <div class="grow"><b>Extra strict: block all third-party iframes</b><p>Removes every embedded frame from another site (videos, comment widgets, social embeds). Captcha and payment frames are kept. Expect some sites to break.</p></div>
          <span class="switch"><input type="checkbox" data-setting="blockThirdPartyFrames"><span></span></span>
        </div>
      </div>
      <div class="danger-zone row">
        <button class="danger" id="reset">Reset all settings and lists</button>
      </div>
    </section>

    <section id="sec-lists">
      <p class="lead">Entries are site names like <code>example.com</code>; subdomains are included.</p>
      <div id="listEditors"></div>
    </section>

    <section id="sec-history">
      <p class="lead">Every popup, redirect and link Strict Shield stopped is kept in this browser (extension storage) until you clear it. Nothing is sent anywhere.</p>
      <div class="summary" id="summary"></div>
      <div class="toolbar">
        <input type="search" id="q" placeholder="Filter by site or URL">
        <select id="kind">
          <option value="">All types</option>
          <option value="popup">Popups</option>
          <option value="navigation">Redirects</option>
          <option value="link">Links</option>
          <option value="blocklist">Blocklist</option>
          <option value="overlay">On-screen popups</option>
        </select>
        <button id="export">Export JSON</button>
        <button class="danger" id="clear">Clear history</button>
      </div>
      <div class="card table-wrap" style="padding:0">
        <table>
          <thead><tr><th>Last blocked</th><th>Type</th><th>Blocked URL</th><th>Times</th><th></th></tr></thead>
          <tbody id="rows"></tbody>
        </table>
      </div>
      <div class="more"><button id="more" hidden>Show more</button></div>
    </section>

    <section id="sec-how">
      <div class="card how">
        <h2>How Strict Shield filters a page</h2>
        <ol>
          <li><b>Network rules (before anything downloads).</b>
            Chrome checks every request against the extension's block lists (declarativeNetRequest). Requests to ad and tracker domains are cancelled inside the browser, so the ad never loads. The lists are in <code>filters/ads.txt</code> and <code>filters/trackers.txt</code> in the source.</li>
          <li><b>Popup guard (in the page).</b>
            Pages open popups with <code>window.open()</code>, links with <code>target="_blank"</code>, hidden link clicks and form submits. A script that runs before the page's own scripts wraps those calls and cancels any that would open a different site. Same-site popups still work.</li>
          <li><b>Popup backstop (in the browser).</b>
            If a new tab still appears, the extension compares its address with the site of the tab that opened it. A different site means the tab is closed before it can load.</li>
          <li><b>Navigation guard.</b>
            When a page tries to send its own tab to another site (a redirect, a script, an ad frame, a link), the navigation is stopped and you stay on the page, with a notice to open it once or allow the site. If a redirect slips through, the tab goes back to where you were. Addresses you type, bookmarks and the back button are never blocked.</li>
          <li><b>Cosmetic filtering.</b>
            A style sheet hides common ad containers so you don't see empty boxes.</li>
          <li><b>On-screen popups.</b>
            Every few seconds, and whenever the page changes, it checks what sits on top of the middle and edges of the screen. A fixed layer covering the page, a dimmed backdrop, a cookie or newsletter bar, or an invisible click trap counts as a popup, unless it appeared right after you clicked something. It presses the popup's own close / "No thanks" / "Reject all" button, then Escape, then hides it, and gives scrolling back. A site that shows 3 such popups is remembered and handled automatically from then on. The same check runs inside embedded frames: on top of a video or an embedded player, invisible click layers, ad frames and link layers to other sites are removed, and the video and its controls are left. A layer whose click tried to open a popup that was blocked is removed right away, on any site.</li>
          <li><b>Memory.</b>
            Every blocked popup, redirect and link is saved in the extension's local storage with how many times it happened. Your allow and block lists are saved there too.</li>
        </ol>
        <p class="muted">"Same site" means the same registered domain: <code>mail.google.com</code> and <code>www.google.com</code> are one site; <code>google.com</code> and <code>youtube.com</code> are two.</p>
      </div>
    </section>
  </div>
  <script src="../src/lib/site.js"></script>
  <script src="ui.js"></script>
  <script src="options.js"></script>
</body>
</html>
```


### 2.18 extension/pages/options.js

[Open file](extension/pages/options.js) · 162 lines


- **Protection**: each `data-setting` checkbox sends `setSettings`. The radio groups set `navMode`
  and `overlayMode`.
- **Lists**: six editors generated from `LISTS`, including the two on-screen popup lists. Add accepts several entries separated by spaces or
  commas. The worker normalises them (to sites, for `allowOutbound` and `paused`).
- **History**: summary cards from `stats`, a filter box, a type filter, 100 rows at a time,
  per-row **Always block** / **Allow site** (or **Never close here** for on-screen popups),
  **Export JSON** and **Clear history**.


```javascript
(() => {
  const S = self.StrictSite;
  const { h, send, timeAgo, KIND_LABEL } = UI;
  const $ = (id) => document.getElementById(id);

  const LISTS = [
    { key: 'allowOutbound', title: 'Sites allowed to open other sites',
      help: 'Their popups, redirects and outbound links are never blocked.', placeholder: 'news.example.com' },
    { key: 'trustedDestinations', title: 'Trusted destinations',
      help: 'Any site may open these. You can add a path, e.g. example.com/login.', placeholder: 'example.com' },
    { key: 'paused', title: 'Paused sites',
      help: 'All protection is off on these sites, including ad blocking.', placeholder: 'example.com' },
    { key: 'overlaySites', title: 'Auto-close on-screen popups on',
      help: 'Sites you added, and sites Strict Shield learned because they kept showing popups.', placeholder: 'popup-heavy.example' },
    { key: 'overlayNever', title: 'Never auto-close on-screen popups on',
      help: 'Popups on these sites are left alone, and these sites are never learned.', placeholder: 'example.com' },
    { key: 'customBlock', title: 'Always blocked',
      help: 'Every request to these domains is blocked, and visiting them shows the blocked page.', placeholder: 'annoying-ads.example' }
  ];

  let state = { settings: S.DEFAULT_SETTINGS, lists: S.DEFAULT_LISTS, log: [], stats: {} };
  let shown = 100;

  /* --------------------------------------------------------------- tabs */
  function showSection() {
    const id = (location.hash || '#protection').slice(1);
    for (const s of document.querySelectorAll('section')) s.classList.toggle('active', s.id === 'sec-' + id);
    for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === '#' + id);
  }
  window.addEventListener('hashchange', showSection);
  showSection();

  /* --------------------------------------------------------- protection */
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.addEventListener('change', () => send({ type: 'setSettings', patch: { [input.dataset.setting]: input.checked } }));
  }
  $('navMode').addEventListener('change', (e) => send({ type: 'setSettings', patch: { navMode: e.target.value } }));
  $('overlayMode').addEventListener('change', (e) => send({ type: 'setSettings', patch: { overlayMode: e.target.value } }));
  $('reset').onclick = async () => {
    if (confirm('Reset all settings and empty your allow and block lists? Your blocked history is kept.')) {
      await send({ type: 'resetAll' });
    }
  };

  function renderSettings() {
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!state.settings[input.dataset.setting];
    for (const r of document.querySelectorAll('input[name="navMode"]')) r.checked = r.value === state.settings.navMode;
    for (const r of document.querySelectorAll('input[name="overlayMode"]')) r.checked = r.value === state.settings.overlayMode;
  }

  /* -------------------------------------------------------------- lists */
  function renderLists() {
    const root = $('listEditors');
    const focused = document.activeElement?.dataset?.list;
    root.replaceChildren(...LISTS.map((def) => {
      const input = h('input', { type: 'text', placeholder: def.placeholder, dataset: { list: def.key } });
      input.setAttribute('aria-label', `Add to ${def.title}`);
      const add = () => {
        if (!input.value.trim()) return;
        send({ type: 'listOp', list: def.key, op: 'add', value: input.value.split(/[\s,]+/) });
        input.value = '';
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      const items = state.lists[def.key];
      return h('div', { className: 'card list' },
        h('h3', {}, def.title),
        h('p', {}, def.help),
        h('div', { className: 'add' }, input, h('button', { onclick: add }, 'Add')),
        h('div', { className: 'chips' },
          items.length ? items.map((v) => h('span', { className: 'chip' }, v,
            h('button', {
              title: `Remove ${v}`, ariaLabel: `Remove ${v}`,
              onclick: () => send({ type: 'listOp', list: def.key, op: 'remove', value: v })
            }, '×'))) : h('span', { className: 'none' }, 'Empty'))
      );
    }));
    if (focused) root.querySelector(`input[data-list="${focused}"]`)?.focus();
  }

  /* ------------------------------------------------------------ history */
  function filtered() {
    const q = $('q').value.trim().toLowerCase();
    const kind = $('kind').value;
    return state.log.filter((e) => (!kind || e.kind === kind)
      && (!q || e.url.toLowerCase().includes(q) || e.fromSite.includes(q)));
  }

  function renderHistory() {
    const stats = state.stats || {};
    const total = (k) => stats[k] || 0;
    $('summary').replaceChildren(
      ...[['popup', 'Popups'], ['navigation', 'Redirects'], ['link', 'Links'], ['overlay', 'On-screen popups'], ['blocklist', 'Blocklist hits']]
        .map(([k, label]) => h('div', { className: 'card' }, h('b', {}, total(k)), h('span', {}, label))),
      h('div', { className: 'card' }, h('b', {}, state.log.length), h('span', {},
        stats.since ? `unique entries since ${new Date(stats.since).toLocaleDateString()}` : 'unique entries'))
    );

    const rows = filtered();
    const body = $('rows');
    body.replaceChildren();
    if (!rows.length) {
      body.append(h('tr', {}, h('td', { colSpan: 5, className: 'empty' }, state.log.length ? 'No matches.' : 'Nothing blocked yet.')));
    }
    for (const e of rows.slice(0, shown)) {
      const host = S.hostOf(e.url);
      const blocked = state.lists.customBlock.some((d) => S.matchesEntry(e.url, d));
      const allowed = e.fromSite && state.lists.allowOutbound.includes(e.fromSite);
      const overlay = e.kind === 'overlay';
      const overlayNever = overlay && state.lists.overlayNever.includes(e.fromSite);
      body.append(h('tr', {},
        h('td', { title: new Date(e.last).toLocaleString() }, timeAgo(e.last)),
        h('td', {}, h('span', { className: 'pill kind' }, KIND_LABEL[e.kind] || e.kind)),
        h('td', { className: 'url' }, e.url, e.fromSite ? h('small', {}, `from ${e.fromSite}`) : null),
        h('td', { className: 'n' }, e.count),
        h('td', { className: 'act' },
          overlay && !overlayNever ? h('button', {
            title: `Leave on-screen popups alone on ${e.fromSite}`,
            onclick: async () => {
              await send({ type: 'listOp', list: 'overlaySites', op: 'remove', value: e.fromSite });
              await send({ type: 'listOp', list: 'overlayNever', op: 'add', value: e.fromSite });
            }
          }, 'Never close here') : null,
          host && !blocked && !overlay ? h('button', {
            title: `Block every request to ${S.siteOf(host)}`,
            onclick: () => send({ type: 'listOp', list: 'customBlock', op: 'add', value: S.siteOf(host) })
          }, 'Always block') : null,
          ' ',
          e.fromSite && !allowed && e.kind !== 'blocklist' && !overlay ? h('button', {
            title: `Let ${e.fromSite} open other sites`,
            onclick: () => send({ type: 'listOp', list: 'allowOutbound', op: 'add', value: e.fromSite })
          }, `Allow ${e.fromSite}`) : null)
      ));
    }
    $('more').hidden = rows.length <= shown;
  }

  $('q').addEventListener('input', () => { shown = 100; renderHistory(); });
  $('kind').addEventListener('change', () => { shown = 100; renderHistory(); });
  $('more').onclick = () => { shown += 200; renderHistory(); };
  $('clear').onclick = async () => {
    if (confirm('Delete the whole blocked history? This cannot be undone.')) await send({ type: 'clearLog' });
  };
  $('export').onclick = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), log: state.log, lists: state.lists }, null, 2)],
      { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `strict-shield-history-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  /* --------------------------------------------------------------- load */
  async function load() {
    const r = await chrome.storage.local.get(['settings', 'lists', 'log', 'stats']);
    const cfg = S.withDefaults(r.settings, r.lists);
    state = { ...cfg, log: r.log || [], stats: r.stats || {} };
    renderSettings();
    renderLists();
    renderHistory();
  }
  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') load(); });
  load();
})();
```


### 2.19 extension/pages/blocked.html

[Open file](extension/pages/blocked.html) · 35 lines


The last-resort blocked page: shown only when a page keeps redirecting each time it's sent back (normal windows only), or when you visit an always-blocked domain.


```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Blocked by Strict Shield</title>
  <link rel="stylesheet" href="common.css">
  <link rel="stylesheet" href="blocked.css">
</head>
<body>
  <main class="card box">
    <img src="../icons/icon128.png" alt="" class="logo">
    <h1 id="title">This page tried to send you to another site</h1>
    <p class="muted" id="explain"></p>

    <dl class="route">
      <div id="fromRow"><dt>From</dt><dd><span class="host" id="fromHost"></span><code id="fromUrl"></code></dd></div>
      <div><dt>To</dt><dd><span class="host" id="toHost"></span><code id="toUrl"></code></dd></div>
    </dl>
    <p class="seen" id="seen" hidden></p>

    <div class="actions">
      <button class="primary" id="back">Go back</button>
      <button id="continue">Continue once</button>
    </div>
    <div class="more" id="more">
      <button class="link" id="allowSource"></button>
      <button class="link" id="trustDest"></button>
    </div>
    <p class="note muted" id="note">If this happened after you submitted a form (like a login or payment), choose "Always allow" and submit it again.</p>
  </main>
  <script src="../src/lib/site.js"></script>
  <script src="blocked.js"></script>
</body>
</html>
```


### 2.20 extension/pages/blocked.css

[Open file](extension/pages/blocked.css) · 16 lines


Layout for the blocked page card.


```css
body { min-height: 100vh; display: grid; place-items: center; padding: 24px 16px; }
.box { width: 100%; max-width: 600px; padding: 32px; }
.logo { width: 48px; height: 48px; display: block; margin-bottom: 16px; }
h1 { font-size: 22px; margin-bottom: 8px; }
#explain { margin: 0 0 20px; }
.route { margin: 0 0 16px; display: grid; gap: 10px; }
.route > div { display: grid; grid-template-columns: 52px 1fr; gap: 10px; align-items: baseline; }
.route dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .05em; }
.route dd { margin: 0; min-width: 0; }
.route .host { display: block; font-weight: 600; font-size: 16px; word-break: break-all; }
.route code { display: block; color: var(--muted); word-break: break-all; max-height: 4.6em; overflow: hidden; }
.seen { background: var(--brand-soft); color: var(--brand); border-radius: 8px; padding: 8px 12px; font-size: 13px; }
.actions { display: flex; gap: 10px; flex-wrap: wrap; margin: 20px 0 14px; }
.actions button { padding: 9px 18px; }
.more { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; }
.note { font-size: 12.5px; margin: 20px 0 0; border-top: 1px solid var(--line); padding-top: 14px; }
```


### 2.21 extension/pages/blocked.js

[Open file](extension/pages/blocked.js) · 56 lines


- `kind=navigation` (from the navigation guard) reads `from` and `to` from the query string.
  `kind=blocklist` (from the DNR redirect) reads the URL from the hash, because a
  `regexSubstitution` can't URL-encode.
- It shows "Blocked N times so far" from the saved `log`. This is the "remember" requirement
  showing up in the UI.
- None of the buttons navigate the page directly. They ask the worker (`continue`, `goBack`), so
  the navigation has no web initiator and the guard lets it through.


```javascript
(async () => {
  const S = self.StrictSite;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || 'navigation';
  // Blocklist redirects carry the URL in the hash (it comes straight from a
  // declarativeNetRequest regexSubstitution and is not URL-encoded).
  const safeDecode = (v) => { try { return decodeURI(v); } catch { return v; } };
  const to = kind === 'blocklist' ? safeDecode(location.hash.slice(1)) : (params.get('to') || '');
  const from = params.get('from') || '';
  const toSite = S.siteOf(to);
  const fromSite = S.siteOf(from);

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({}));

  $('toHost').textContent = S.hostOf(to) || to;
  $('toUrl').textContent = to;
  if (from) {
    $('fromHost').textContent = S.hostOf(from);
    $('fromUrl').textContent = from;
  } else {
    $('fromRow').hidden = true;
  }

  if (kind === 'blocklist') {
    document.title = `${toSite} blocked`;
    $('title').textContent = `${toSite} is on your blocked list`;
    $('explain').textContent = 'You asked Strict Shield to block this site everywhere.';
    $('continue').textContent = 'Unblock and continue';
    $('more').hidden = true;
    $('note').hidden = true;
    send({ type: 'logBlocklistHit', url: to });
  } else {
    $('explain').textContent = `${fromSite} tried to send this tab to ${toSite}. Strict Shield only lets a site open pages on the same site.`;
    $('allowSource').textContent = `Always allow ${fromSite} to open other sites`;
    $('trustDest').textContent = `Always trust ${toSite} (any site may open it)`;
  }

  // "Remember which pages you blocked": show how often this one came up.
  const { log = [] } = await chrome.storage.local.get('log');
  const prior = log.find((e) => e.url === to && (kind === 'blocklist' || e.fromSite === fromSite));
  if (prior && prior.count > 1) {
    $('seen').hidden = false;
    $('seen').textContent = `Blocked ${prior.count} times so far (first on ${new Date(prior.first).toLocaleDateString()}).`;
  }

  $('back').onclick = () => {
    if (from) send({ type: 'goBack', from });
    else if (history.length > 1) history.back();
    else send({ type: 'goBack', from: '' });
  };
  $('continue').onclick = () => send({ type: 'continue', from, to, unblock: kind === 'blocklist' });
  $('allowSource').onclick = () => send({ type: 'continue', from, to, alsoAllowSource: true });
  $('trustDest').onclick = () => send({ type: 'continue', from, to, alsoTrustDestination: true });
  $('back').focus();
})();
```


## Build, package and icons


### 2.22 tools/package.sh

[Open file](tools/package.sh) · 13 lines


Rebuilds the rules and zips `extension/` into `dist/strict-shield-<version>.zip`. It leaves out `.DS_Store` and `_metadata/`, which Chrome writes when you load the folder unpacked and which the Web Store rejects.


```bash
#!/usr/bin/env bash
# Builds the zip you upload to the Chrome Web Store: dist/strict-shield-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

node tools/build-rules.mjs
version=$(node -p "require('./extension/manifest.json').version")
out="dist/strict-shield-${version}.zip"
mkdir -p dist
rm -f "$out"
# _metadata/ is written by Chrome when the folder is loaded unpacked; the store rejects it.
(cd extension && zip -qr -X "../$out" . -x '*.DS_Store' -x '__MACOSX/*' -x '_metadata/*')
echo "Created $out ($(du -h "$out" | cut -f1))"
```


### 2.23 tools/make-icons.py

[Open file](tools/make-icons.py) · 53 lines


Draws the red shield with a white bar at 1024 px and scales it down to 16/32/48/128 px with Pillow. It also writes `store/store-icon-128.png`.


```python
#!/usr/bin/env python3
"""Draws the Strict Shield icon (red shield, white bar) at every size Chrome needs.

    python3 tools/make-icons.py
Needs Pillow (pip install pillow).
"""
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
BIG = 1024


def shield(size):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = size / 100.0
    # Shield outline: flat top with rounded corners, sides curving to a point.
    pts = []
    import math
    top, left, right, bottom = 8 * s, 14 * s, 86 * s, 94 * s
    r = 10 * s
    # top-left corner arc
    for a in range(180, 271, 5):
        pts.append((left + r + r * math.cos(math.radians(a)), top + r + r * math.sin(math.radians(a))))
    for a in range(270, 361, 5):
        pts.append((right - r + r * math.cos(math.radians(a)), top + r + r * math.sin(math.radians(a))))
    # right side down to the point (quadratic curve)
    def quad(p0, p1, p2, n=30):
        return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
                 (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1])
                for t in (i / n for i in range(1, n + 1))]
    pts += quad((right, top + r), (right, 70 * s), (50 * s, bottom))
    pts += quad((50 * s, bottom), (left, 70 * s), (left, top + r))
    d.polygon(pts, fill=(198, 40, 40, 255))
    # Inner highlight on the left half for depth.
    inner = [(x, y) for (x, y) in pts if x <= 50 * s]
    hl = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ImageDraw.Draw(hl).polygon(inner + [(50 * s, top)], fill=(255, 255, 255, 28))
    img = Image.alpha_composite(img, hl)
    d = ImageDraw.Draw(img)
    # White "no entry" bar.
    d.rounded_rectangle((28 * s, 41 * s, 72 * s, 55 * s), radius=4 * s, fill=(255, 255, 255, 255))
    return img


big = shield(BIG)
OUT.mkdir(parents=True, exist_ok=True)
for n in (16, 32, 48, 128):
    big.resize((n, n), Image.LANCZOS).save(OUT / f"icon{n}.png")
# Store listing assets
big.resize((128, 128), Image.LANCZOS).save(OUT.parent.parent / "store" / "store-icon-128.png") if (OUT.parent.parent / "store").exists() else None
print("icons written to", OUT)
```


### 2.24 tools/build-notes.py

[Open file](tools/build-notes.py) · 541 lines


This file's generator. It reads every source file and writes `NOTES_WITH_CODE.md`.


````python
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
````


### 2.25 package.json

[Open file](package.json) · 18 lines


Only scripts and the `puppeteer` dev dependency for the tests. The extension itself has no dependencies.


```json
{
  "name": "strict-shield",
  "version": "1.0.0",
  "private": true,
  "description": "Strict ad, tracker and popup blocker for Chrome (Manifest V3).",
  "license": "MIT",
  "repository": { "type": "git", "url": "https://github.com/HarsimarSingh23/strict-shield.git" },
  "type": "module",
  "scripts": {
    "build:rules": "node tools/build-rules.mjs",
    "build:icons": "python3 tools/make-icons.py",
    "package": "bash tools/package.sh",
    "test": "node test/run.mjs"
  },
  "devDependencies": {
    "puppeteer": "^25.14.0"
  }
}
```


### 2.26 .gitignore

[Open file](.gitignore) · 4 lines


```
node_modules/
dist/
.DS_Store
extension/_metadata/
```


## Tests


### 2.27 test/server.mjs

[Open file](test/server.mjs) · 189 lines


One HTTP server that plays several sites. Chrome is started with `--host-resolver-rules`, so
`site-a.test`, `site-b.test`, `site-c.test`, `doubleclick.net` and `www.google-analytics.com` all
resolve to `127.0.0.1`, and the server routes on the `Host` header. `site-a.test/` has one button
or link for each popup trick. `OVERLAY_PAGES` (`/overlay`, `/overlay-plain`, `/user-modal`, `/trap`,
`/dialog`) imitate heavy-popup sites on any `*.test` host. `/embed-host` embeds `/player` (a video
with its own click layer and control bar, plus per-case layers on top) or `/wrapper` (a frame
whose player is one frame deeper) from another site. `static.site-c.test/widget.js` is a
third-party script blocked only by your custom list; its name avoids "ad" so a browser's own
blocker (e.g. Brave Shields) can't interfere.


```javascript
/*
 * One local HTTP server that pretends to be several sites. Chrome is started
 * with --host-resolver-rules so site-a.test, site-b.test, doubleclick.net ...
 * all resolve to 127.0.0.1, and this server routes on the Host header.
 */
import http from 'node:http';

const article = '<main id="content">' + ('<p>' + 'Real article text. '.repeat(40) + '</p>').repeat(30) + '</main>';

// On-screen popup and embedded-player test pages, served on every *.test host.
const OVERLAY_PAGES = {
  // Newsletter modal + dimmed backdrop + cookie bar, the way heavy-popup sites do it.
  '/overlay': () => `${article}<script>
    setTimeout(() => {
      document.body.style.overflow = 'hidden';
      const back = Object.assign(document.createElement('div'), { id: 'backdrop' });
      back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000';
      const modal = Object.assign(document.createElement('div'), { id: 'modal' });
      modal.style.cssText = 'position:fixed;top:20%;left:25%;width:50%;height:50%;background:#fff;z-index:1001;padding:20px';
      modal.innerHTML = '<h2>Subscribe to our newsletter!</h2><p>Get 20% off your first order.</p>'
        + '<input placeholder="email"> <button id="sub">Subscribe</button>'
        + '<button id="x" aria-label="Close" style="position:absolute;top:8px;right:8px">×</button>';
      modal.querySelector('#x').onclick = () => { window.__closedVia = 'button'; back.remove(); modal.remove(); document.body.style.overflow = ''; };
      modal.querySelector('#sub').onclick = () => { window.__subscribed = true; };
      const cookie = Object.assign(document.createElement('div'), { id: 'cookie' });
      cookie.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee;z-index:999';
      cookie.innerHTML = 'We use cookies to improve your experience. <button id="acc">Accept all</button> <button id="rej">Reject all</button>';
      cookie.querySelector('#acc').onclick = () => { window.__accepted = true; cookie.remove(); };
      cookie.querySelector('#rej').onclick = () => { window.__rejected = true; cookie.remove(); };
      document.body.append(back, modal, cookie);
    }, 300);
  </script>`,
  // Modal with no close button that locks scrolling and blurs the article.
  '/overlay-plain': () => `${article}<script>
    setTimeout(() => {
      document.documentElement.style.overflow = 'hidden';
      document.getElementById('content').style.filter = 'blur(4px)';
      const wall = Object.assign(document.createElement('div'), { id: 'wall' });
      wall.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.9);z-index:50;display:flex;align-items:center;justify-content:center';
      wall.innerHTML = '<div style="background:#fff;padding:40px;border:1px solid #ccc">Please turn off your ad blocker to keep reading.</div>';
      document.body.append(wall);
    }, 300);
  </script>`,
  // A login box you open yourself.
  '/user-modal': () => `${article}<button id="open" style="position:fixed;top:10px;left:10px">Log in</button><script>
    document.getElementById('open').onclick = () => setTimeout(() => {
      const m = Object.assign(document.createElement('div'), { id: 'login' });
      m.style.cssText = 'position:fixed;top:25%;left:30%;width:40%;height:40%;background:#fff;border:1px solid #999;z-index:10';
      m.innerHTML = 'Log in <input type="password"> <button aria-label="Close">×</button>';
      document.body.append(m);
    }, 100);
  </script>`,
  // Invisible full-page link that turns any click into an ad popup.
  '/trap': (port) => `${article}<script>
    setTimeout(() => {
      const a = Object.assign(document.createElement('a'), { id: 'trap', href: 'http://site-c.test:${port}/ad', target: '_blank' });
      a.style.cssText = 'position:fixed;inset:0;z-index:9999;opacity:0';
      document.body.append(a);
    }, 300);
  </script>`,
  // A page that embeds a video player from another site. ?top=trap also puts
  // an invisible click layer over the embedded frame, in the page itself.
  '/embed-host': (port, url, host) => {
    const other = host === 'site-a.test' ? 'site-b.test' : 'site-a.test';
    const kind = url.searchParams.get('case') || 'covers';
    const trap = url.searchParams.get('top') === 'trap'
      ? `<div id="toptrap" style="position:absolute;inset:0" onclick="window.open('http://site-c.test:${port}/x-top')"></div>` : '';
    return `<div id="wrap" style="position:relative;width:640px;height:360px">
        <iframe id="player" src="http://${other}:${port}/${url.searchParams.get('frame') || 'player'}?case=${kind}" width="640" height="360" style="border:0;display:block"></iframe>${trap}
      </div>${article}`;
  },
  // A wrapper frame: the real player is one frame deeper, on a third site,
  // and the wrapper lays an invisible click layer over it.
  '/wrapper': (port) => `<style>html,body{margin:0;height:100%}#w{position:relative;width:100%;height:100%}</style>
    <div id="w">
      <iframe id="inner" src="http://site-c.test:${port}/player?case=none" style="width:100%;height:100%;border:0;display:block"></iframe>
      <div id="wraptrap" style="position:absolute;inset:0" onclick="window.open('http://site-c.test:${port}/x-wrap')"></div>
    </div>`,
  // The player inside that frame: a video, its own click layer (#tap) and
  // control bar (#bar), plus whatever the case adds on top.
  '/player': (port, url) => {
    const C = `http://site-c.test:${port}`;
    const extra = {
      // What popup-heavy players lay over the video: an invisible click trap on
      // <body>, another frame, and a link layer to another site.
      covers: `setTimeout(() => {
        const trap = Object.assign(document.createElement('div'), { id: 'trap' });
        trap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647';
        trap.onclick = () => window.open('${C}/x-trap');
        document.body.append(trap);
        const frame = Object.assign(document.createElement('iframe'), { id: 'overframe', src: '${C}/x-frame' });
        frame.style.cssText = 'position:absolute;top:20%;left:25%;width:50%;height:50%;z-index:50;border:0';
        const link = Object.assign(document.createElement('a'), { id: 'overlink', href: '${C}/x-link', target: '_blank' });
        link.style.cssText = 'position:absolute;inset:0;z-index:40';
        link.innerHTML = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width:100%;height:100%">';
        document.getElementById('p').append(frame, link);
      }, 300);`,
      // An invisible layer inside the player that opens a popup on every click.
      soft: `const t = Object.assign(document.createElement('div'), { id: 'softtrap' });
        t.style.cssText = 'position:absolute;inset:0;z-index:5';
        t.onclick = () => window.open('${C}/x-soft');
        document.getElementById('p').append(t);`,
      // The real play button, which opens a popup on the first click only.
      dual: `const b = Object.assign(document.createElement('div'), { id: 'bigplay' });
        b.style.cssText = 'position:absolute;inset:0;z-index:5;background:#123';
        b.onclick = () => { if (!window.__popped) { window.__popped = 1; window.open('${C}/x-dual'); return; } window.__played = 1; b.remove(); };
        document.getElementById('p').append(b);`
    }[url.searchParams.get('case')] || '';
    return `<style>html,body{margin:0;height:100%;background:#000}#p{position:relative;width:100%;height:100%}video{width:100%;height:100%;display:block}</style>
      <div id="p">
        <video id="v" muted></video>
        <div id="tap" style="position:absolute;inset:0;z-index:1" onclick="window.__toggled=(window.__toggled||0)+1"></div>
        <div id="bar" style="position:absolute;left:0;right:0;bottom:0;height:40px;z-index:2;background:rgba(0,0,0,.6)"><button id="play">Play</button><input type="range"></div>
      </div>
      <script>${extra}</script>`;
  },
  // A modal <dialog> shown on load.
  '/dialog': () => `${article}<dialog id="dlg"><p>We noticed you are using an ad blocker. Please allowlist us.</p><button>OK</button></dialog><script>
    setTimeout(() => document.getElementById('dlg').showModal(), 300);
  </script>`
};

export function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const port = server.address().port;
    const url = new URL(req.url, `http://${host}`);
    hits.push(`${host}${url.pathname}`);
    const B = `http://site-b.test:${port}`;
    const C = `http://site-c.test:${port}`;
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>${host}${url.pathname}</title></head><body>${body}</body></html>`);
    };

    if (host === 'doubleclick.net' || host === 'www.google-analytics.com' || host === 'popads.net') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.adLoaded = true;');
    }
    // A made-up third-party script, blocked only through the extension's own
    // custom block list. Its name avoids "ad" so a browser's built-in blocker
    // (e.g. Brave Shields, once its lists load) can't be what blocks it.
    if (host === 'static.site-c.test') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.customAdLoaded = true;');
    }

    if (host.endsWith('.test') && OVERLAY_PAGES[url.pathname]) return html(OVERLAY_PAGES[url.pathname](port, url, host));

    if (host === 'site-a.test') {
      switch (url.pathname) {
        case '/':
          return html(`
            <h1>Site A</h1>
            <script src="http://doubleclick.net:${port}/ad.js"></script>
            <script src="http://static.site-c.test:${port}/widget.js"></script>
            <img id="pixel" src="http://www.google-analytics.com:${port}/collect.gif">
            <ins class="adsbygoogle" id="adbox" style="display:block;width:300px;height:250px">AD</ins>
            <div id="content">Real content</div>
            <a id="sameLink" href="/page2">same-site link</a>
            <a id="crossLink" href="${B}/">cross-site link</a>
            <a id="crossBlank" href="${B}/blank" target="_blank">cross-site new tab</a>
            <a id="sameBlank" href="/page2" target="_blank">same-site new tab</a>
            <a id="redirectOut" href="/redirect-out">same-site link that 302s away</a>
            <button id="openCross" onclick="window.__w = window.open('${B}/popup')">open cross</button>
            <button id="openSame" onclick="window.__w = window.open('/page2?popup')">open same</button>
            <button id="popunder" onclick="const a=document.createElement('a');a.href='${C}/popunder';a.target='_blank';a.click()">popunder</button>
            <button id="blankThenNav" onclick="const w=window.open('');w.location='${C}/via-blank'">blank then nav</button>
            <button id="bounce" onclick="window.open('/bounce')">bounce</button>
            <button id="iframeOpen" onclick="const f=document.createElement('iframe');document.body.appendChild(f);f.contentWindow.open('${C}/via-iframe')">iframe open</button>
          `);
        case '/page2':
          return html('<h1>Site A page 2</h1>');
        case '/redirect-out':
          res.writeHead(302, { location: `${B}/landed` });
          return res.end();
        case '/js-redirect':
          return html(`<h1>JS redirect</h1><script>setTimeout(() => { location.href = '${B}/from-js'; }, 200);</script>`);
        case '/bounce':
          return html(`<h1>bounce</h1><script>setTimeout(() => { location.href = '${C}/after-bounce'; }, 100);</script>`);
      }
    }
    if (host === 'site-b.test' || host === 'site-c.test') return html(`<h1>${host}</h1>`);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}
```


### 2.28 test/run.mjs

[Open file](test/run.mjs) · 590 lines


Starts Chromium with the unpacked extension (`enableExtensions`), waits for the service worker to
finish installing, then runs 48 cases in groups: network and cosmetic, the same-site rule, popups,
memory, Balanced mode, lists, on-screen popups, embedded players. `deepText()` reads closed shadow
roots through the DevTools protocol to check the toast, and `clickInShadow()` presses its buttons. `setConfig()` writes storage from inside the worker, then waits for
`rulesChain` so the network rules are updated before the next page loads. A
240-second deadline kills the run if the browser hangs.


```javascript
/*
 * End-to-end tests: loads the unpacked extension into Chrome for Testing and
 * drives fake sites served by test/server.mjs.
 *
 *   npm install         (once; downloads puppeteer + Chrome for Testing)
 *   npm test            (HEADFUL=1 npm test to watch it)
 *   CHROME_PATH=/path/to/chromium npm test   to use another Chromium build
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startServer } from './server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { server, hits, port } = await startServer();
const A = `http://site-a.test:${port}`;
const B = `http://site-b.test:${port}`;
const C = `http://site-c.test:${port}`;

const browser = await puppeteer.launch({
  headless: !process.env.HEADFUL,
  executablePath: process.env.CHROME_PATH || undefined,
  pipe: true,
  enableExtensions: [EXT],
  args: ['--host-resolver-rules=MAP *.test 127.0.0.1, MAP doubleclick.net 127.0.0.1, MAP www.google-analytics.com 127.0.0.1, MAP popads.net 127.0.0.1']
});

// Never hang CI: give the whole run a hard deadline.
const deadline = setTimeout(() => { console.error('\nTimed out'); browser.process()?.kill('SIGKILL'); process.exit(2); }, 240000);

const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/src/background.js'), { timeout: 15000 });
const extId = new URL(swTarget.url()).host;
const BLOCKED = `chrome-extension://${extId}/pages/blocked.html`;
let sw = await swTarget.worker();
console.log(`Running in ${await browser.version()}`);

async function inWorker(fn, arg) {
  try {
    return await sw.evaluate(fn, arg);
  } catch {
    const t = await browser.waitForTarget((x) => x.type() === 'service_worker' && x.url().includes(extId));
    sw = await t.worker();
    return sw.evaluate(fn, arg);
  }
}

// Wait for onInstalled to finish writing defaults and enabling rules.
for (let i = 0; i < 50; i++) {
  const ok = await inWorker(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    const sets = await chrome.declarativeNetRequest.getEnabledRulesets();
    return !!settings && sets.includes('ads');
  });
  if (ok) break;
  await sleep(100);
}

async function setConfig(patch) {
  await inWorker(async (p) => {
    const cur = await chrome.storage.local.get(['settings', 'lists']);
    await chrome.storage.local.set({
      settings: Object.assign({}, cur.settings, p.settings || {}),
      lists: Object.assign({}, cur.lists, p.lists || {})
    });
  }, patch);
  await sleep(150);
  await inWorker(() => rulesChain); // network rules updated
  await sleep(300);                 // content scripts picked it up
}

const results = [];
async function test(name, fn) {
  let page;
  try {
    page = await browser.newPage();
    await fn(page);
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  } finally {
    for (const p of await browser.pages()) if (p !== page && !p.url().startsWith('about:blank')) await p.close().catch(() => {});
    await page?.close().catch(() => {});
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

async function openUrls() { return (await browser.pages()).map((p) => p.url()); }
async function load(page, url) { await page.goto(url, { waitUntil: 'load' }); await sleep(300); }
async function noTabWith(fragment, ms = 1500) {
  await sleep(ms);
  const urls = await openUrls();
  assert(!urls.some((u) => u.includes(fragment)), `a tab with ${fragment} is still open: ${urls.join(', ')}`);
}
async function waitForUrl(page, prefix, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (page.url().startsWith(prefix)) return;
    await sleep(50);
  }
  throw new Error(`expected ${prefix}…, got ${page.url()}`);
}
// Text of the page including closed shadow roots (the toast lives in one).
// Click a button inside the toast's closed shadow root, like a real user.
async function clickInShadow(page, label) {
  const cdp = await page.createCDPSession();
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  let target = null;
  (function walk(n) {
    if (target) return;
    if (n.nodeName === 'BUTTON' && (n.children || []).some((c) => c.nodeType === 3 && c.nodeValue === label)) target = n;
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  })(doc);
  if (!target) { await cdp.detach(); throw new Error(`no "${label}" button`); }
  const { model } = await cdp.send('DOM.getBoxModel', { nodeId: target.nodeId });
  await cdp.detach();
  const [x1, y1, , , x3, y3] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

async function deepText(page) {
  const cdp = await page.createCDPSession();
  const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const out = [];
  (function walk(n) {
    if (n.nodeType === 3) out.push(n.nodeValue);
    for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
  })(doc);
  await cdp.detach();
  return out.join(' ');
}

console.log(`Extension ${extId}\n`);
console.log('Network & cosmetic filtering');

await test('ad script from doubleclick.net is blocked', async (page) => {
  await load(page, A + '/');
  assert(await page.evaluate(() => window.adLoaded) === undefined, 'ad script ran');
  assert(!hits.includes('doubleclick.net/ad.js'), 'request reached the ad server');
});

await test('the extension\'s own rules match ad, tracker and ping requests', async () => {
  const outcome = await inWorker(async (cases) => {
    const out = {};
    for (const [url, type] of cases) {
      const r = await chrome.declarativeNetRequest.testMatchOutcome({ url, type, initiator: 'https://news.example' });
      out[url] = r.matchedRules.map((m) => m.rulesetId).join(',');
    }
    return out;
  }, [
    ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script'],
    ['https://www.googletagmanager.com/gtag/js?id=G-1', 'script'],
    ['https://cdn.example.com/js/prebid.min.js', 'script'],
    ['https://www.facebook.com/tr?id=1&ev=PageView', 'image'],
    ['https://tracker.example/beacon', 'ping'],
    ['https://news.example/article.js', 'script']
  ]);
  const expect = {
    'https://securepubads.g.doubleclick.net/tag/js/gpt.js': 'ads',
    'https://www.googletagmanager.com/gtag/js?id=G-1': 'trackers',
    'https://cdn.example.com/js/prebid.min.js': 'ads',
    'https://www.facebook.com/tr?id=1&ev=PageView': 'trackers',
    'https://tracker.example/beacon': 'trackers',
    'https://news.example/article.js': ''
  };
  for (const [url, want] of Object.entries(expect)) assert(outcome[url] === want, `${url}: matched "${outcome[url]}", expected "${want}"`);
});

await test('tracking pixel is blocked', async () => {
  assert(!hits.includes('www.google-analytics.com/collect.gif'), 'pixel request reached the server');
});

await test('ad container is hidden, real content is not', async (page) => {
  await load(page, A + '/');
  const [ad, content] = await page.evaluate(() => [
    getComputedStyle(document.getElementById('adbox')).display,
    getComputedStyle(document.getElementById('content')).display
  ]);
  assert(ad === 'none', `ad box display=${ad}`);
  assert(content !== 'none', 'content was hidden');
});

console.log('\nSame-site rule (strict mode)');

await test('typed URL to another site is allowed', async (page) => {
  await load(page, A + '/');
  await load(page, B + '/');
  assert(page.url().startsWith(B), page.url());
});

await test('same-site link opens', async (page) => {
  await load(page, A + '/');
  await Promise.all([page.waitForNavigation(), page.click('#sameLink')]);
  assert(page.url() === A + '/page2', page.url());
});

await test('cross-site link is stopped and a toast is shown', async (page) => {
  await load(page, A + '/');
  await page.click('#crossLink');
  await sleep(800);
  assert(page.url() === A + '/', `navigated to ${page.url()}`);
  const text = await deepText(page);
  assert(text.includes('Link to another site blocked'), 'no toast');
});

await test('same-site link that server-redirects away: you stay on the page with a notice', async (page) => {
  await load(page, A + '/');
  await page.click('#redirectOut');
  await sleep(1500);
  assert(page.url() === A + '/', `left the page: ${page.url()}`);
  assert((await deepText(page)).includes('Redirect to another site blocked'), 'no notice');
});

await test('JavaScript redirect to another site is stopped; the page stays', async (page) => {
  await load(page, A + '/js-redirect');
  await sleep(1500);
  assert(page.url() === A + '/js-redirect', `left the page: ${page.url()}`);
  assert((await deepText(page)).includes('Redirect to another site blocked'), 'no notice');
});

await test('"Open once" in the notice opens the destination', async (page) => {
  await load(page, A + '/js-redirect');
  await sleep(1200);
  await clickInShadow(page, 'Open once');
  await waitForUrl(page, B + '/from-js');
});

await test('a blocked page that loads anyway is undone by going back', async (page) => {
  await load(page, A + '/');
  await load(page, B + '/landed'); // typed, so allowed; history is now [A, B]
  await inWorker(async ({ a, b }) => {
    const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(b));
    await recover(tab.id, { site: 'site-b.test', allow: false, from: a, to: b });
  }, { a: A + '/', b: B + '/landed' });
  await waitForUrl(page, A + '/');
  await sleep(800);
  assert((await deepText(page)).includes('Redirect to another site blocked'), 'no notice after going back');
});

const fallbackPage = `${BLOCKED}?${new URLSearchParams({ kind: 'navigation', from: A + '/', to: B + '/landed' })}`;
await test('last-resort blocked page: "Go back" returns to the source', async (page) => {
  await page.goto(fallbackPage);
  await sleep(300);
  await page.click('#back');
  await waitForUrl(page, A + '/');
});

await test('last-resort blocked page: "Continue once" opens the destination', async (page) => {
  await page.goto(fallbackPage);
  await sleep(300);
  await page.click('#continue');
  await waitForUrl(page, B + '/landed');
});

console.log('\nPopups');

await test('window.open() to another site is blocked', async (page) => {
  await load(page, A + '/');
  await page.click('#openCross');
  await noTabWith('/popup');
  assert(await page.evaluate(() => window.__w) === null, 'window.open did not return null');
  assert((await deepText(page)).includes('Popup blocked'), 'no toast');
});

await test('window.open() to the same site works', async (page) => {
  await load(page, A + '/');
  await page.click('#openSame');
  await browser.waitForTarget((t) => t.url() === A + '/page2?popup', { timeout: 4000 });
});

await test('target=_blank link to another site is blocked', async (page) => {
  await load(page, A + '/');
  await page.click('#crossBlank');
  await noTabWith('/blank');
});

await test('target=_blank link to the same site works', async (page) => {
  await load(page, A + '/');
  await page.click('#sameBlank');
  await browser.waitForTarget((t) => t.url() === A + '/page2', { timeout: 4000 });
});

await test('popunder via detached <a>.click() is blocked', async (page) => {
  await load(page, A + '/');
  await page.click('#popunder');
  await noTabWith('/popunder');
});

await test('window.open("") then navigating it to another site is closed', async (page) => {
  await load(page, A + '/');
  await page.click('#blankThenNav');
  await noTabWith('/via-blank', 2000);
});

await test('window.open() through a fresh iframe is blocked', async (page) => {
  await load(page, A + '/');
  await page.click('#iframeOpen');
  await noTabWith('/via-iframe');
});

await test('same-site "bounce" popup that redirects away is closed', async (page) => {
  await load(page, A + '/');
  await page.click('#bounce');
  await noTabWith('/after-bounce', 2500);
  await noTabWith('/bounce', 0);
});

console.log('\nMemory (blocked history)');

await test('blocked pages are saved in extension storage', async (page) => {
  await load(page, A + '/');
  await page.click('#openCross');
  await sleep(500);
  const { log, stats } = await inWorker(() => chrome.storage.local.get(['log', 'stats']));
  const kinds = new Set(log.map((e) => e.kind));
  for (const k of ['popup', 'navigation', 'link']) assert(kinds.has(k), `no ${k} entries: ${[...kinds]}`);
  const popup = log.find((e) => e.kind === 'popup' && e.url === B + '/popup');
  assert(popup && popup.count >= 2 && popup.fromSite === 'site-a.test', `repeat popup not counted: ${JSON.stringify(popup)}`);
  assert(stats.popup >= 2, 'stats not updated');
});

console.log('\nBalanced mode');
await setConfig({ settings: { navMode: 'balanced' } });

await test('a link you click opens another site', async (page) => {
  await load(page, A + '/');
  await Promise.all([page.waitForNavigation(), page.click('#crossLink')]);
  assert(page.url() === B + '/', page.url());
});

await test('automatic redirects are still blocked', async (page) => {
  await load(page, A + '/js-redirect');
  await sleep(1500);
  assert(page.url() === A + '/js-redirect', `left the page: ${page.url()}`);
});

await test('cross-site popups are still blocked', async (page) => {
  await load(page, A + '/');
  await page.click('#openCross');
  await noTabWith('/popup');
});

console.log('\nLists');
await setConfig({ settings: { navMode: 'strict' }, lists: { customBlock: ['static.site-c.test'] } });

await test('a domain on your block list is blocked', async (page) => {
  await load(page, A + '/');
  assert(await page.evaluate(() => window.customAdLoaded) === undefined, 'custom-blocked script ran');
});

await setConfig({ lists: { paused: ['site-a.test'] } });

await test('paused site: ads and popups are allowed', async (page) => {
  await load(page, A + '/');
  assert(await page.evaluate(() => window.customAdLoaded) === true, 'ad still blocked on a paused site');
  await page.click('#openCross');
  await browser.waitForTarget((t) => t.url() === B + '/popup', { timeout: 4000 });
});

await setConfig({ lists: { paused: [], customBlock: [], allowOutbound: ['site-a.test'] } });
await test('"allow this site to open other sites" lets its popups through', async (page) => {
  await load(page, A + '/');
  await page.click('#openCross');
  await browser.waitForTarget((t) => t.url() === B + '/popup', { timeout: 4000 });
});

await setConfig({ lists: { allowOutbound: [], customBlock: ['site-c.test'] } });
await test('always-blocked domain shows the blocked page', async (page) => {
  await page.goto(C + '/anything?x=1').catch(() => {});
  await waitForUrl(page, BLOCKED + '?kind=blocklist');
  assert(decodeURI(new URL(page.url()).hash.slice(1)) === C + '/anything?x=1', page.url());
});
await setConfig({ lists: { customBlock: [] } });

console.log('\nOn-screen popups');
const shownIn = (page, id) => page.evaluate((i) => {
  const e = document.getElementById(i);
  return !!e && e.isConnected && getComputedStyle(e).display !== 'none';
}, id);
const overlayState = () => inWorker(() => chrome.storage.local.get(['lists', 'overlayCounts', 'log']));
await setConfig({ settings: { overlayMode: 'auto' }, lists: { overlaySites: [], overlayNever: [] } });
await inWorker(() => chrome.storage.local.remove('overlayCounts'));

await test('auto mode: popups on a site it doesn\'t know yet are only counted', async (page) => {
  await load(page, A + '/overlay');
  await sleep(1500);
  assert(await shownIn(page, 'modal'), 'modal was closed on an unknown site');
  const { overlayCounts = {} } = await overlayState();
  assert(overlayCounts['site-a.test'] >= 1, `not counted: ${JSON.stringify(overlayCounts)}`);
});

await test('a site that keeps showing popups is learned and its popups closed', async (page) => {
  await load(page, A + '/overlay');
  await page.waitForFunction(() => !document.getElementById('modal'), { timeout: 5000 });
  const { lists } = await overlayState();
  assert(lists.overlaySites.includes('site-a.test'), `not learned: ${lists.overlaySites}`);
});

await test('uses the close button and "Reject all", never Accept or Subscribe', async (page) => {
  await load(page, A + '/overlay');
  await page.waitForFunction(() => !document.getElementById('modal') && !document.getElementById('cookie'), { timeout: 5000 });
  const r = await page.evaluate(() => ({
    via: window.__closedVia, rejected: window.__rejected, accepted: window.__accepted,
    subscribed: window.__subscribed, overflow: getComputedStyle(document.body).overflowY
  }));
  assert(r.via === 'button', `closed via ${r.via}`);
  assert(r.rejected === true && !r.accepted && !r.subscribed, JSON.stringify(r));
  assert(r.overflow !== 'hidden', 'page still cannot scroll');
});

await test('popup without a close button is hidden; scrolling and blur are restored', async (page) => {
  await load(page, A + '/overlay-plain');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('wall')).display === 'none', { timeout: 5000 });
  const r = await page.evaluate(() => ({
    overflow: getComputedStyle(document.documentElement).overflowY,
    filter: getComputedStyle(document.getElementById('content')).filter
  }));
  assert(r.overflow !== 'hidden', 'scrolling still locked');
  assert(!r.filter.includes('blur'), `content still blurred: ${r.filter}`);
});

await test('a popup you open yourself stays open', async (page) => {
  await load(page, A + '/user-modal');
  await page.click('#open');
  await sleep(2000);
  assert(await shownIn(page, 'login'), 'your login box was closed');
});

await test('invisible click-trap layer is removed', async (page) => {
  await load(page, A + '/trap');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('trap')).display === 'none', { timeout: 5000 });
});

await test('modal <dialog> is closed', async (page) => {
  await load(page, A + '/dialog');
  await page.waitForFunction(() => !document.getElementById('dlg').open, { timeout: 5000 });
});

await test('closed popups are saved in the history', async () => {
  const { log } = await overlayState();
  const pages = log.filter((x) => x.kind === 'overlay' && x.fromSite === 'site-a.test').map((x) => new URL(x.url).pathname);
  for (const p of ['/overlay', '/overlay-plain', '/trap', '/dialog']) assert(pages.includes(p), `no entry for ${p}: ${pages}`);
});

await setConfig({ lists: { overlayNever: ['site-a.test'], overlaySites: [] } });
await test('"never on this site" leaves its popups alone', async (page) => {
  await load(page, A + '/overlay');
  await sleep(2000);
  assert(await shownIn(page, 'modal'), 'modal was closed on a "never" site');
});

await setConfig({ settings: { overlayMode: 'off' }, lists: { overlayNever: [] } });
await test('"Close popups on this page now" works even with auto-close off', async (page) => {
  await load(page, A + '/overlay');
  await sleep(1200);
  assert(await shownIn(page, 'modal'), 'closed while off');
  const res = await inWorker(async (prefix) => {
    const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(prefix));
    return chrome.tabs.sendMessage(tab.id, { type: 'closeOverlaysNow' }, { frameId: 0 });
  }, A + '/overlay');
  assert(res && res.closed >= 1, JSON.stringify(res));
  assert(!(await shownIn(page, 'modal')), 'modal still there');
});

await setConfig({ settings: { overlayMode: 'everywhere' } });
await test('"every site" mode closes popups on any site', async (page) => {
  await load(page, B + '/overlay');
  await page.waitForFunction(() => !document.getElementById('modal'), { timeout: 5000 });
  const { lists } = await overlayState();
  assert(!lists.overlaySites.includes('site-b.test'), 'every-site mode should not need the list');
});
await setConfig({ settings: { overlayMode: 'auto' }, lists: { overlaySites: [], overlayNever: [] } });

console.log('\nEmbedded players (frames)');
await inWorker(() => chrome.storage.local.remove('overlayCounts'));
const frameOf = async (page, part) => {
  for (let i = 0; i < 50; i++) {
    const f = page.frames().find((x) => x.url().includes(part));
    if (f) return f;
    await sleep(100);
  }
  throw new Error(`no frame with ${part}`);
};
const shownInFrame = (frame, id) => frame.evaluate((i) => {
  const e = document.getElementById(i);
  return !!e && e.isConnected && getComputedStyle(e).display !== 'none';
}, id);
const waitShownInFrame = async (frame, id, want, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await shownInFrame(frame, id) === want) return;
    await sleep(100);
  }
  throw new Error(`#${id} is still ${want ? 'hidden' : 'shown'} in the frame`);
};
const COVERS = ['trap', 'overframe', 'overlink'];

await test('popups over a video inside a frame count for the page\'s site and are removed once it is learned', async (page) => {
  await load(page, A + '/embed-host?case=covers');
  const frame = await frameOf(page, '/player');
  for (const id of COVERS) await waitShownInFrame(frame, id, false);
  const { lists, log } = await overlayState();
  assert(lists.overlaySites.includes('site-a.test'), `not learned: ${lists.overlaySites}`);
  const e = log.find((x) => x.kind === 'overlay' && x.url.includes('/player') && x.fromSite === 'site-a.test');
  assert(e, 'frame closure not in the history');
});

await test('the video, its controls and its own click layer stay and work', async (page) => {
  await load(page, A + '/embed-host?case=covers');
  const frame = await frameOf(page, '/player');
  for (const id of COVERS) await waitShownInFrame(frame, id, false);
  for (const id of ['v', 'bar', 'tap']) assert(await shownInFrame(frame, id), `#${id} was hidden`);
  await frame.click('#tap');
  assert(await frame.evaluate(() => window.__toggled) === 1, 'click did not reach the player');
});

await test('the page shows the notice for a frame, and Undo puts the layers back', async (page) => {
  await load(page, A + '/embed-host?case=covers');
  const frame = await frameOf(page, '/player');
  await waitShownInFrame(frame, 'trap', false);
  await sleep(400);
  assert((await deepText(page)).includes('Popup closed'), 'no notice in the page');
  await clickInShadow(page, 'Undo');
  await waitShownInFrame(frame, 'trap', true);
});

await test('invisible layer over an embedded frame, in the page itself, is removed', async (page) => {
  await load(page, A + '/embed-host?case=none&top=trap');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('toptrap')).display === 'none', { timeout: 6000 });
  assert(await page.evaluate(() => getComputedStyle(document.getElementById('player')).display) !== 'none', 'the player frame was hidden');
});

await test('wrapper frame: invisible layer over the inner player frame is removed, the inner player stays', async (page) => {
  await load(page, A + '/embed-host?frame=wrapper');
  const wrapper = await frameOf(page, '/wrapper');
  await waitShownInFrame(wrapper, 'wraptrap', false);
  assert(await shownInFrame(wrapper, 'inner'), 'the inner player frame was hidden');
  const inner = await frameOf(page, '/player');
  for (const id of ['v', 'bar', 'tap']) assert(await shownInFrame(inner, id), `#${id} was hidden`);
});

await test('a layer whose click opened a blocked popup is removed, even on a site not learned', async (page) => {
  await load(page, B + '/embed-host?case=soft');
  const frame = await frameOf(page, '/player');
  await sleep(1200);
  assert(await shownInFrame(frame, 'softtrap'), 'removed before it proved to be a trap');
  await frame.click('#softtrap');
  await noTabWith('/x-soft', 800);
  await waitShownInFrame(frame, 'softtrap', false);
  await frame.click('#tap');
  assert(await frame.evaluate(() => window.__toggled) === 1, 'next click did not reach the player');
});

await test('a visible play button that opens a popup on the first click only is kept', async (page) => {
  await load(page, B + '/embed-host?case=dual');
  const frame = await frameOf(page, '/player');
  await frame.click('#bigplay');
  await noTabWith('/x-dual', 800);
  assert(await shownInFrame(frame, 'bigplay'), 'play button removed after one click');
  await frame.click('#bigplay');
  assert(await frame.evaluate(() => window.__played) === 1, 'second click did not play');
});

await setConfig({ settings: { overlayMode: 'off' } });
await test('"Close popups on this page now" also reaches embedded players', async (page) => {
  await load(page, A + '/embed-host?case=covers');
  const frame = await frameOf(page, '/player');
  await sleep(1500);
  assert(await shownInFrame(frame, 'trap'), 'closed while auto-close is off');
  const res = await inWorker(async (prefix) => {
    const tab = (await chrome.tabs.query({})).find((t) => (t.url || '').startsWith(prefix));
    return closeOverlaysInTab(tab.id);
  }, A + '/embed-host');
  assert(res.reached && res.closed >= 3, JSON.stringify(res));
  for (const id of COVERS) assert(!(await shownInFrame(frame, id)), `#${id} is still there`);
});
await setConfig({ settings: { overlayMode: 'auto' }, lists: { overlaySites: [], overlayNever: [] } });

clearTimeout(deadline);
await Promise.race([browser.close(), sleep(5000)]);
browser.process()?.kill('SIGKILL');
server.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
```


### 2.29 test/screenshots.mjs

[Open file](test/screenshots.mjs) · 71 lines


Generates the 1280×800 store screenshots and the popup image in `store/`. Use `THEME=dark` for dark ones.


```javascript
/*
 * Renders 1280x800 screenshots for the Chrome Web Store listing into store/.
 *   node test/screenshots.mjs            (CHROME_PATH=... to pick a browser)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { startServer } from './server.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'store');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => process.exit(2), 90000);

const { server, port } = await startServer();
const A = `http://site-a.test:${port}`;
const browser = await puppeteer.launch({
  headless: true, pipe: true, executablePath: process.env.CHROME_PATH || undefined,
  enableExtensions: [path.join(root, 'extension')],
  args: ['--host-resolver-rules=MAP *.test 127.0.0.1, MAP doubleclick.net 127.0.0.1, MAP www.google-analytics.com 127.0.0.1']
});
const swt = await browser.waitForTarget((t) => t.type() === 'service_worker');
const id = new URL(swt.url()).host;
const sw = await swt.worker();
await sleep(800);

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME || 'light' }]);
await page.goto(A + '/');
await sleep(400);
for (const sel of ['#openCross', '#openCross', '#crossBlank', '#popunder', '#crossLink']) { await page.click(sel); await sleep(300); }
await page.goto(A + '/js-redirect');
await sleep(1500);
await page.screenshot({ path: `${out}/screenshot-1-blocked-page.png` });

for (const [n, hash] of [[2, 'protection'], [3, 'history'], [4, 'how']]) {
  await page.goto(`chrome-extension://${id}/pages/options.html#${hash}`);
  await sleep(500);
  await page.screenshot({ path: `${out}/screenshot-${n}-${hash}.png` });
}

// A heavy-popup page after Strict Shield closed its popups.
await sw.evaluate(async () => {
  const { lists } = await chrome.storage.local.get('lists');
  await chrome.storage.local.set({ lists: { ...lists, overlaySites: ['site-a.test'] } });
});
await sleep(400);
await page.goto(A + '/overlay');
await sleep(2500);
await page.screenshot({ path: `${out}/screenshot-5-overlay-closed.png` });

// The toolbar popup, opened for a normal page.
await page.goto(A + '/');
await sleep(300);
try {
  await sw.evaluate(() => chrome.action.openPopup());
  const pt = await browser.waitForTarget((t) => t.url().endsWith('popup.html'), { timeout: 5000 });
  const pp = await pt.asPage();
  await pp.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME || 'light' }]);
  await sleep(800);
  await pp.screenshot({ path: `${out}/popup.png` });
  console.log('popup network count:', await pp.$eval('#netCount', (e) => e.textContent));
} catch (e) {
  console.log('popup screenshot skipped:', e.message);
}
console.log(`screenshots written to ${out}`);
await Promise.race([browser.close(), sleep(3000)]);
browser.process()?.kill('SIGKILL');
server.close();
process.exit(0);
```


# Part 3: Publishing checklist

1. `bash tools/package.sh` → `dist/strict-shield-<version>.zip`
2. Host `PRIVACY.md` publicly and fill in your support email.
3. Developer Dashboard → New item → upload the zip.
4. Paste the listing, single purpose, permission justifications and data-usage answers from
   `store/STORE_LISTING.md`. Upload the icon and the screenshots from `store/`.
5. Submit. Expect an in-depth review because of `<all_urls>`.
6. For each update: bump `version` in `manifest.json`, re-package, upload.

Known limits are listed at the end of [README.md](README.md#known-limits).
