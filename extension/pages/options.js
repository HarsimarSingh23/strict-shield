(() => {
  const S = self.StrictSite;
  const { h, send, timeAgo, KIND_LABEL } = UI;
  const $ = (id) => document.getElementById(id);

  const LISTS = [
    { key: 'allowOutbound', title: 'Sites allowed to open other sites',
      help: 'Their popups, redirects and outbound links are never blocked.', placeholder: 'news.example.com' },
    { key: 'trustedDestinations', title: 'Trusted destinations',
      help: 'Any site may open these. You can add a path, e.g. example.com/login.', placeholder: 'example.com' },
    { key: 'paused', title: 'Paused sites',
      help: 'All protection is off on these sites, including ad blocking.', placeholder: 'example.com' },
    { key: 'overlaySites', title: 'Auto-close on-screen popups on',
      help: 'Sites you added, and sites Strict Shield learned because they kept showing popups.', placeholder: 'popup-heavy.example' },
    { key: 'overlayNever', title: 'Never auto-close on-screen popups on',
      help: 'Popups on these sites are left alone, and these sites are never learned.', placeholder: 'example.com' },
    { key: 'customBlock', title: 'Always blocked',
      help: 'Every request to these domains is blocked, and visiting them shows the blocked page.', placeholder: 'annoying-ads.example' }
  ];

  let state = { settings: S.DEFAULT_SETTINGS, lists: S.DEFAULT_LISTS, log: [], stats: {} };
  let shown = 100;

  /* --------------------------------------------------------------- tabs */
  function showSection() {
    const id = (location.hash || '#protection').slice(1);
    for (const s of document.querySelectorAll('section')) s.classList.toggle('active', s.id === 'sec-' + id);
    for (const a of document.querySelectorAll('nav a')) a.classList.toggle('active', a.getAttribute('href') === '#' + id);
  }
  window.addEventListener('hashchange', showSection);
  showSection();

  /* --------------------------------------------------------- protection */
  for (const input of document.querySelectorAll('[data-setting]')) {
    input.addEventListener('change', () => send({ type: 'setSettings', patch: { [input.dataset.setting]: input.checked } }));
  }
  $('navMode').addEventListener('change', (e) => send({ type: 'setSettings', patch: { navMode: e.target.value } }));
  $('overlayMode').addEventListener('change', (e) => send({ type: 'setSettings', patch: { overlayMode: e.target.value } }));
  $('reset').onclick = async () => {
    if (confirm('Reset all settings and empty your allow and block lists? Your blocked history is kept.')) {
      await send({ type: 'resetAll' });
    }
  };

  function renderSettings() {
    for (const input of document.querySelectorAll('[data-setting]')) input.checked = !!state.settings[input.dataset.setting];
    for (const r of document.querySelectorAll('input[name="navMode"]')) r.checked = r.value === state.settings.navMode;
    for (const r of document.querySelectorAll('input[name="overlayMode"]')) r.checked = r.value === state.settings.overlayMode;
  }

  /* -------------------------------------------------------------- lists */
  function renderLists() {
    const root = $('listEditors');
    const focused = document.activeElement?.dataset?.list;
    root.replaceChildren(...LISTS.map((def) => {
      const input = h('input', { type: 'text', placeholder: def.placeholder, dataset: { list: def.key } });
      input.setAttribute('aria-label', `Add to ${def.title}`);
      const add = () => {
        if (!input.value.trim()) return;
        send({ type: 'listOp', list: def.key, op: 'add', value: input.value.split(/[\s,]+/) });
        input.value = '';
      };
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
      const items = state.lists[def.key];
      return h('div', { className: 'card list' },
        h('h3', {}, def.title),
        h('p', {}, def.help),
        h('div', { className: 'add' }, input, h('button', { onclick: add }, 'Add')),
        h('div', { className: 'chips' },
          items.length ? items.map((v) => h('span', { className: 'chip' }, v,
            h('button', {
              title: `Remove ${v}`, ariaLabel: `Remove ${v}`,
              onclick: () => send({ type: 'listOp', list: def.key, op: 'remove', value: v })
            }, '×'))) : h('span', { className: 'none' }, 'Empty'))
      );
    }));
    if (focused) root.querySelector(`input[data-list="${focused}"]`)?.focus();
  }

  /* ------------------------------------------------------------ history */
  function filtered() {
    const q = $('q').value.trim().toLowerCase();
    const kind = $('kind').value;
    return state.log.filter((e) => (!kind || e.kind === kind)
      && (!q || e.url.toLowerCase().includes(q) || e.fromSite.includes(q)));
  }

  function renderHistory() {
    const stats = state.stats || {};
    const total = (k) => stats[k] || 0;
    $('summary').replaceChildren(
      ...[['popup', 'Popups'], ['navigation', 'Redirects'], ['link', 'Links'], ['overlay', 'On-screen popups'], ['blocklist', 'Blocklist hits']]
        .map(([k, label]) => h('div', { className: 'card' }, h('b', {}, total(k)), h('span', {}, label))),
      h('div', { className: 'card' }, h('b', {}, state.log.length), h('span', {},
        stats.since ? `unique entries since ${new Date(stats.since).toLocaleDateString()}` : 'unique entries'))
    );

    const rows = filtered();
    const body = $('rows');
    body.replaceChildren();
    if (!rows.length) {
      body.append(h('tr', {}, h('td', { colSpan: 5, className: 'empty' }, state.log.length ? 'No matches.' : 'Nothing blocked yet.')));
    }
    for (const e of rows.slice(0, shown)) {
      const host = S.hostOf(e.url);
      const blocked = state.lists.customBlock.some((d) => S.matchesEntry(e.url, d));
      const allowed = e.fromSite && state.lists.allowOutbound.includes(e.fromSite);
      const overlay = e.kind === 'overlay';
      const overlayNever = overlay && state.lists.overlayNever.includes(e.fromSite);
      body.append(h('tr', {},
        h('td', { title: new Date(e.last).toLocaleString() }, timeAgo(e.last)),
        h('td', {}, h('span', { className: 'pill kind' }, KIND_LABEL[e.kind] || e.kind)),
        h('td', { className: 'url' }, e.url, e.fromSite ? h('small', {}, `from ${e.fromSite}`) : null),
        h('td', { className: 'n' }, e.count),
        h('td', { className: 'act' },
          overlay && !overlayNever ? h('button', {
            title: `Leave on-screen popups alone on ${e.fromSite}`,
            onclick: async () => {
              await send({ type: 'listOp', list: 'overlaySites', op: 'remove', value: e.fromSite });
              await send({ type: 'listOp', list: 'overlayNever', op: 'add', value: e.fromSite });
            }
          }, 'Never close here') : null,
          host && !blocked && !overlay ? h('button', {
            title: `Block every request to ${S.siteOf(host)}`,
            onclick: () => send({ type: 'listOp', list: 'customBlock', op: 'add', value: S.siteOf(host) })
          }, 'Always block') : null,
          ' ',
          e.fromSite && !allowed && e.kind !== 'blocklist' && !overlay ? h('button', {
            title: `Let ${e.fromSite} open other sites`,
            onclick: () => send({ type: 'listOp', list: 'allowOutbound', op: 'add', value: e.fromSite })
          }, `Allow ${e.fromSite}`) : null)
      ));
    }
    $('more').hidden = rows.length <= shown;
  }

  $('q').addEventListener('input', () => { shown = 100; renderHistory(); });
  $('kind').addEventListener('change', () => { shown = 100; renderHistory(); });
  $('more').onclick = () => { shown += 200; renderHistory(); };
  $('clear').onclick = async () => {
    if (confirm('Delete the whole blocked history? This cannot be undone.')) await send({ type: 'clearLog' });
  };
  $('export').onclick = () => {
    const blob = new Blob([JSON.stringify({ exported: new Date().toISOString(), log: state.log, lists: state.lists }, null, 2)],
      { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `strict-shield-history-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };

  /* --------------------------------------------------------------- load */
  async function load() {
    const r = await chrome.storage.local.get(['settings', 'lists', 'log', 'stats']);
    const cfg = S.withDefaults(r.settings, r.lists);
    state = { ...cfg, log: r.log || [], stats: r.stats || {} };
    renderSettings();
    renderLists();
    renderHistory();
  }
  chrome.storage.onChanged.addListener((_, area) => { if (area === 'local') load(); });
  load();
})();
