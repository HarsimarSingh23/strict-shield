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
