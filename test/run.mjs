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
