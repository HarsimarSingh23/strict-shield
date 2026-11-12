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
