# Chrome Web Store listing — copy and paste

Everything the Developer Dashboard asks for, in the order it asks.

## Store listing tab

**Name** (from manifest): Strict Shield: Ad & Popup Blocker

**Summary** (from manifest, max 132 chars):
Strict ad, tracker and popup blocker. Pages can only open their own site; cross-site popups and redirects are blocked.

**Category:** Privacy & Security

**Language:** English

**Description:**

```
Strict Shield is an ad blocker built around one simple rule: a page may only open its own site.

Popups, pop-unders, surprise new tabs and redirects to other sites are blocked automatically. Ads and trackers are stopped before they download.

WHAT IT BLOCKS
• Ads — ad servers, ad exchanges, popup networks and native "around the web" widgets
• Trackers — analytics, session recording, tracking pixels and cross-site pings
• Popups — any new tab or window a page opens to a different site, including pop-unders and hidden-link tricks
• Redirects — a page trying to send your tab to another site is stopped. You stay on the page you were reading, with Open once and Always allow buttons
• Leftover ad boxes — hidden so pages look clean
• On-screen popups — newsletter boxes, cookie walls, "turn off your ad blocker" messages, notification prompts and invisible click traps are closed automatically on sites that keep showing them. It presses their own close or "No thanks" / "Reject all" button (never Accept or Subscribe), or hides them, and gives you scrolling back. One click closes them on any page

YOU STAY IN CONTROL
• Addresses you type, bookmarks and the back button are never blocked
• "Open once" and "Always allow" buttons on every block
• Strict mode (default) asks before any link leaves a site; Balanced mode lets links you click through and still blocks automatic redirects and popups
• Pause protection on any site with one click
• Sign-in and payment popups (Google, Microsoft, Apple, PayPal, Stripe, Razorpay, Paytm and more) keep working. You can turn that off too
• Extra-strict option to remove all third-party iframes

IT REMEMBERS
Every popup, redirect, link and on-screen popup it blocked is kept in a searchable history on your device, with how many times each one happened. It also remembers which sites are heavy on popups and handles them automatically from then on. You can export or clear it at any time.

PRIVATE BY DESIGN
No account, no server, no analytics. Nothing you browse ever leaves your computer.
```

**Graphics:**
- Store icon 128×128: `store/store-icon-128.png`
- Screenshots (1280×800): `store/screenshot-1-blocked-page.png` … `screenshot-5-overlay-closed.png`. Regenerate with `node test/screenshots.mjs` (add `THEME=dark` for dark ones). At least one is required; real-site screenshots sell better than test pages.
- Small promo tile 440×280: optional. Make one from the icon if you want a featured spot.

## Privacy practices tab

**Single purpose:**
Blocks ads, trackers, popups and cross-site redirects so that a web page can only open pages on its own site.

**Permission justifications:**

| Field | Justification |
|---|---|
| declarativeNetRequest | Blocks network requests to ad and tracker domains using Chrome's built-in rule engine. This is the extension's core ad-blocking function. |
| declarativeNetRequestFeedback | Reads how many of the extension's rules matched on the current tab, to show the "requests blocked on this tab" number in the toolbar popup. |
| webNavigation | Detects when a page opens a new tab or window (onCreatedNavigationTarget) and what each tab shows (onCommitted), so cross-site popups can be closed and cross-site redirects stopped. |
| webRequest | Observes (non-blocking) top-level page requests and their initiator to tell whether a navigation was started by the page or by the user, so only page-initiated cross-site navigations are stopped. Request content is never read or modified. |
| storage | Saves the user's settings, allow/block lists and the history of blocked popups and redirects locally. |
| Host permission (<all_urls>) | Ads, popups and redirects can appear on any website, so the content script that stops window.open() popups and hides ad containers must run on every page, and the extension needs to see tab URLs to compare sites. |
| Remote code | No, I am not using remote code. All code is in the package. |

**Data usage — what to tick:**
- ☑ **Web history** — the extension stores the addresses of popups/redirects it blocked, locally, so the user can review them.
- Leave everything else unticked.

**Certify all three statements:**
- ☑ I do not sell or transfer user data to third parties, outside of the approved use cases
- ☑ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ☑ I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://harsimarsingh23.github.io/strict-shield/PRIVACY.html

**Homepage / support URL** (Store listing tab): https://github.com/HarsimarSingh23/strict-shield

## Distribution tab
- Visibility: Public (or Unlisted to test with a few people first)
- Regions: All regions
- Pricing: Free
