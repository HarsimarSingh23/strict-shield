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
