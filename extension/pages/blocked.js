(async () => {
  const S = self.StrictSite;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const kind = params.get('kind') || 'navigation';
  // Blocklist redirects carry the URL in the hash (it comes straight from a
  // declarativeNetRequest regexSubstitution and is not URL-encoded).
  const safeDecode = (v) => { try { return decodeURI(v); } catch { return v; } };
  const to = kind === 'blocklist' ? safeDecode(location.hash.slice(1)) : (params.get('to') || '');
  const from = params.get('from') || '';
  const toSite = S.siteOf(to);
  const fromSite = S.siteOf(from);

  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => ({}));

  $('toHost').textContent = S.hostOf(to) || to;
  $('toUrl').textContent = to;
  if (from) {
    $('fromHost').textContent = S.hostOf(from);
    $('fromUrl').textContent = from;
  } else {
    $('fromRow').hidden = true;
  }

  if (kind === 'blocklist') {
    document.title = `${toSite} blocked`;
    $('title').textContent = `${toSite} is on your blocked list`;
    $('explain').textContent = 'You asked Strict Shield to block this site everywhere.';
    $('continue').textContent = 'Unblock and continue';
    $('more').hidden = true;
    $('note').hidden = true;
    send({ type: 'logBlocklistHit', url: to });
  } else {
    $('explain').textContent = `${fromSite} tried to send this tab to ${toSite}. Strict Shield only lets a site open pages on the same site.`;
    $('allowSource').textContent = `Always allow ${fromSite} to open other sites`;
    $('trustDest').textContent = `Always trust ${toSite} (any site may open it)`;
  }

  // "Remember which pages you blocked": show how often this one came up.
  const { log = [] } = await chrome.storage.local.get('log');
  const prior = log.find((e) => e.url === to && (kind === 'blocklist' || e.fromSite === fromSite));
  if (prior && prior.count > 1) {
    $('seen').hidden = false;
    $('seen').textContent = `Blocked ${prior.count} times so far (first on ${new Date(prior.first).toLocaleDateString()}).`;
  }

  $('back').onclick = () => {
    if (from) send({ type: 'goBack', from });
    else if (history.length > 1) history.back();
    else send({ type: 'goBack', from: '' });
  };
  $('continue').onclick = () => send({ type: 'continue', from, to, unblock: kind === 'blocklist' });
  $('allowSource').onclick = () => send({ type: 'continue', from, to, alsoAllowSource: true });
  $('trustDest').onclick = () => send({ type: 'continue', from, to, alsoTrustDestination: true });
  $('back').focus();
})();
