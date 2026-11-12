(async () => {
  const S = self.StrictSite;
  const { h, send, timeAgo, KIND_LABEL } = UI;
  const $ = (id) => document.getElementById(id);

  $('version').textContent = 'v' + chrome.runtime.getManifest().version;
  $('openOptions').onclick = () => chrome.runtime.openOptionsPage();
  $('openHistory').onclick = () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('pages/options.html#history') });
    window.close();
  };

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !S.isWeb(tab.url)) {
    $('unsupported').hidden = false;
    return;
  }
  const site = S.siteOf(tab.url);
  $('main').hidden = false;
  $('site').textContent = site;

  // Network requests blocked on this tab.
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    $('netCount').textContent = rulesMatchedInfo.length;
  } catch {
    $('netCount').textContent = '–';
  }

  function render({ settings, lists, log }) {
    const paused = lists.paused.includes(site);
    $('status').textContent = paused ? 'Paused' : 'Protected';
    $('status').className = 'pill ' + (paused ? 'off' : 'ok');
    $('protect').checked = !paused;
    $('outbound').checked = lists.allowOutbound.includes(site);
    $('outbound').disabled = paused;

    for (const b of $('mode').querySelectorAll('button')) {
      b.setAttribute('aria-pressed', String(b.dataset.mode === settings.navMode));
    }
    const om = settings.overlayMode;
    const never = lists.overlayNever.includes(site);
    const overlayOn = !paused && om !== 'off' && !never && (om === 'everywhere' || lists.overlaySites.includes(site));
    $('overlay').checked = overlayOn;
    $('overlay').disabled = paused || om === 'off';
    $('overlayHint').textContent = paused ? 'Protection is paused here'
      : om === 'off' ? 'Turned off in Settings'
      : overlayOn ? 'Closes newsletter boxes, cookie walls and overlays'
      : never ? 'Never on this site'
      : 'Turns on by itself if this site keeps showing popups';

    $('modeHint').textContent = {
      strict: 'Every link to another site asks first',
      balanced: 'Links you click open; redirects and popups are blocked',
      off: 'Only popups are blocked'
    }[settings.navMode] || '';

    const mine = log.filter((e) => e.fromSite === site);
    $('pageCount').textContent = mine.reduce((n, e) => n + e.count, 0);
    const list = $('recent');
    list.replaceChildren();
    if (!mine.length) list.append(h('div', { className: 'empty' }, 'Nothing blocked on this site yet.'));
    for (const e of mine.slice(0, 5)) {
      list.append(h('li', {},
        h('div', { className: 'row' },
          h('span', { className: 'pill kind' }, KIND_LABEL[e.kind] || e.kind),
          h('span', { className: 'grow u' }, S.hostOf(e.url) || e.url),
          h('span', { className: 'muted' }, (e.count > 1 ? `${e.count}× · ` : '') + timeAgo(e.last))
        )
      ));
    }
  }

  async function refresh() {
    const r = await chrome.storage.local.get(['settings', 'lists', 'log']);
    const cfg = S.withDefaults(r.settings, r.lists);
    render({ ...cfg, log: r.log || [] });
  }

  $('protect').onchange = async (e) => {
    await send({ type: 'listOp', list: 'paused', op: e.target.checked ? 'remove' : 'add', value: site });
    chrome.tabs.reload(tab.id);
  };
  $('outbound').onchange = (e) =>
    send({ type: 'listOp', list: 'allowOutbound', op: e.target.checked ? 'add' : 'remove', value: site });
  $('overlay').onchange = async (e) => {
    const on = e.target.checked;
    await send({ type: 'listOp', list: on ? 'overlayNever' : 'overlaySites', op: 'remove', value: site });
    await send({ type: 'listOp', list: on ? 'overlaySites' : 'overlayNever', op: 'add', value: site });
  };

  $('zap').onclick = async () => {
    $('zap').disabled = true;
    $('zapResult').textContent = 'Looking…';
    // The worker asks the page and every frame inside it (embedded players).
    const r = await send({ type: 'closeOverlays', tabId: tab.id }).catch(() => null);
    if (!r || !r.reached) {
      $('zapResult').textContent = 'Reload the page first, then try again.';
    } else if (!r.closed) {
      $('zapResult').textContent = 'Nothing covering this page.';
    } else {
      // You had to close them by hand: treat this site as heavy on popups.
      const stored = await chrome.storage.local.get(['settings', 'lists']);
      const { settings, lists } = S.withDefaults(stored.settings, stored.lists);
      const learn = settings.overlayMode === 'auto' && !lists.overlaySites.includes(site) && !lists.overlayNever.includes(site);
      if (learn) await send({ type: 'listOp', list: 'overlaySites', op: 'add', value: site });
      $('zapResult').textContent = `Closed ${r.closed === 1 ? '1 popup' : `${r.closed} popups`}.`
        + (learn ? ' They will close by themselves here from now on.' : '');
    }
    $('zap').disabled = false;
  };

  $('mode').onclick = (e) => {
    const mode = e.target.closest('button')?.dataset.mode;
    if (mode) send({ type: 'setSettings', patch: { navMode: mode } });
  };

  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') refresh(); });
  refresh();
})();
