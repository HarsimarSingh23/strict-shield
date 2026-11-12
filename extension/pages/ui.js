/* Small helpers shared by the popup and options pages. */
const UI = {
  send(msg) {
    return chrome.runtime.sendMessage(msg).then((r) => {
      if (r && r.error) throw new Error(r.error);
      return r;
    });
  },

  // h('li', { className: 'x', onclick }, 'text', childNode)
  h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v !== undefined && v !== null) el[k] = v;
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  },

  timeAgo(ts) {
    const s = Math.round((Date.now() - ts) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  },

  KIND_LABEL: {
    popup: 'Popup',
    navigation: 'Redirect',
    link: 'Link',
    blocklist: 'Blocklist',
    overlay: 'On-screen'
  }
};
