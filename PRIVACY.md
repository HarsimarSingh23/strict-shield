# Strict Shield — Privacy Policy

_Last updated: 23 October 2026_

Strict Shield is a Chrome extension that blocks ads, trackers, popups and cross-site redirects. Source code: <https://github.com/HarsimarSingh23/strict-shield>.

## What the extension stores

To work, and to show you what it blocked, Strict Shield keeps this **on your device only**, in Chrome's extension storage (`chrome.storage.local` and `chrome.storage.session`):

- **Blocked history:** the address of each popup, redirect or link it blocked, the site that tried to open it, the time, and how many times it happened. It keeps up to 2,000 entries.
- **Your settings and lists:** sites you allowed, paused, trusted or blocked.
- **On-screen popup counts:** for each site, how many unsolicited on-screen popups (newsletter boxes, cookie walls and similar) it has shown, so sites that keep showing them can be handled automatically. Only the site name and a number are stored.
- **Per-tab state (until you close the browser):** the site each open tab is showing, so it can tell whether a new navigation goes to the same site.

## What the extension does not do

- It does not send any of this data anywhere. Strict Shield has no server, no analytics, and makes no network requests of its own.
- It does not sell, share or transfer your data to anyone.
- It does not read page content, form fields, passwords or cookies.
- It does not use your data for advertising, credit or lending decisions, or anything other than blocking and showing you what it blocked.

## Your control

- Settings → **Blocked history** → **Clear history** deletes the history immediately.
- **Export JSON** gives you a copy of it.
- Uninstalling the extension deletes everything it stored.

## Permissions

| Permission | Why |
|---|---|
| `declarativeNetRequest` | Block requests to ad and tracker servers inside the browser. |
| `declarativeNetRequestFeedback` | Show how many requests were blocked on the current tab. |
| `webNavigation`, `webRequest` | See when a page opens a new tab or sends its tab to another site, so the extension can stop it. These are read-only; no request content is read or changed. |
| `storage` | Save your settings, lists and blocked history on your device. |
| Access to all sites | Ads and popups can come from any site, so blocking has to work on every site. |

## Contact

Questions or problems: open an issue at <https://github.com/HarsimarSingh23/strict-shield/issues>.
