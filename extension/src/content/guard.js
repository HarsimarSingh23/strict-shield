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
