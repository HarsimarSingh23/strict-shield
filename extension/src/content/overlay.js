/*
 * On-screen popup closer (top frame only, isolated world, after guard.js).
 *
 * Finds things a page puts over its own content without being asked:
 * newsletter / "subscribe" modals, cookie walls, "turn off your ad blocker"
 * boxes, notification prompts, interstitial ads and invisible click-trap
 * layers. For each one it tries, in order:
 *   1. the popup's own close / "No thanks" / "Reject all" button
 *   2. the Escape key
 *   3. hiding it
 * and then gives scrolling back and removes the blur the page put behind it.
 * It never presses Accept, Subscribe, Allow or Sign up.
 *
 * Where it acts (settings.overlayMode):
 *   'auto'       sites in lists.overlaySites: ones you added, plus sites it
 *                learned because they showed 3 popups; elsewhere it only counts
 *   'everywhere' every site
 *   'off'        nowhere (the toolbar "Close popups now" button still works)
 * Popups that appear right after you click a button or link are yours
 * (a login box, a menu) and are left alone.
 */
(() => {
  'use strict';
  if (window.top !== window) return;
  const S = self.StrictSite;
  const C = self.StrictShieldContent;
  if (!S || !C) return;

  // Where to look: the middle of the screen for modals, the edges for banners.
  const CENTER_PROBES = [[0.5, 0.5], [0.3, 0.35], [0.7, 0.35], [0.3, 0.65], [0.7, 0.65]];
  const EDGE_PROBES = [[0.5, 0.97], [0.15, 0.97], [0.85, 0.97], [0.5, 0.03], [0.85, 0.85]];
  // A bar at the edge only counts as a popup if it talks like one.
  const BANNER_WORDS = /cookie|consent|gdpr|newsletter|notification|ad ?block|allowlist|whitelist|get the app|open in (the )?app|download (the |our )?app|\d+ ?% off|discount|sign up for|subscribe to|don'?t miss/i;
  // Button text that closes without agreeing to anything.
  const CLOSE_TEXT = /^(×|✕|✖|✗|╳|x|close|close this|close ad|dismiss|no,? thanks?\b.*|no thank you.*|not now|maybe later|later|skip|skip ad|cancel|continue (reading|to (the )?site|without .*)|i'?ll pass|not interested|reject|reject all|decline( all)?|deny|necessary (cookies )?only|only necessary.*)$/i;
  const CLOSE_HINT = /close|dismiss|no.?thanks|not.?now|maybe.?later|skip|cancel|reject|decline/i;
  const NOT_CLOSE = /accept|agree|allow|subscribe|sign.?up|log.?in|sign.?in|register|continue with|yes|^ok$|got it|enable|install|download|buy|shop|claim|get |join/i;
  // Never touch captcha, payment or sign-in frames.
  const SAFE_FRAME = /recaptcha|hcaptcha|challenges\.cloudflare|turnstile|stripe|razorpay|paypal|checkout|payments?\b|accounts\.google|appleid|login\.(microsoft|live)/i;
  const INTERACTIVE = 'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=menuitem],[role=tab],[onclick],[contenteditable]';
  const RESCAN_AFTER_MS = [800, 2000, 4000, 8000, 15000, 30000, 60000];

  let lastGesture = { t: -Infinity, interactive: false };
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
    const t = e.composedPath ? e.composedPath()[0] : e.target;
    const interactive = e.type === 'keydown' || !!(t && t.closest && t.closest(INTERACTIVE));
    lastGesture = { t: performance.now(), interactive };
  }

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

  /* ------------------------------------------------------------ detection */

  const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

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

  function coverage(el) {
    const r = el.getBoundingClientRect();
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return { rect: r, cover: (w * h) / (innerWidth * innerHeight) };
  }

  function shown(el) {
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
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

  function findPopups() {
    const found = new Map();
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

  // Returns true if the popup is gone afterwards.
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

  function report(n) {
    C.toast({
      kind: 'overlay',
      title: 'Popup closed',
      text: learnedNow
        ? `Strict Shield now closes popups on ${C.topSite} automatically.`
        : `Closed ${n === 1 ? 'a popup' : `${n} popups`} covering this page.`,
      actions: [
        { label: 'Undo', run: undo },
        { label: `Never on ${C.topSite}`, run: () => { undo(); C.send({ type: 'overlayPref', pref: 'never' }); } }
      ]
    });
    learnedNow = false;
  }

  /* -------------------------------------------------------------- scanning */

  async function scan(force = false) {
    if (busy || !document.body || (stopped && !force)) return 0;
    const m = force ? 'close' : mode();
    if (m === 'off') return 0;
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
      if (closed) {
        restorePage();
        report(closed);
      }
    } finally {
      busy = false;
      prevScan = lastScanEnd = performance.now();
    }
    return closed;
  }

  function schedule(delay) {
    if (timer) return;
    const wait = Math.max(delay, 600 - (performance.now() - lastScanEnd));
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
  document.documentElement.addEventListener('mouseleave', () => schedule(300));

  // Toolbar popup: "Close popups on this page now".
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
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
