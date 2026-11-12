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
