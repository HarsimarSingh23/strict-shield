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
