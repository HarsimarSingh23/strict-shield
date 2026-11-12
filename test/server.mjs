/*
 * One local HTTP server that pretends to be several sites. Chrome is started
 * with --host-resolver-rules so site-a.test, site-b.test, doubleclick.net ...
 * all resolve to 127.0.0.1, and this server routes on the Host header.
 */
import http from 'node:http';

const article = '<main id="content">' + ('<p>' + 'Real article text. '.repeat(40) + '</p>').repeat(30) + '</main>';

// On-screen popup and embedded-player test pages, served on every *.test host.
const OVERLAY_PAGES = {
  // Newsletter modal + dimmed backdrop + cookie bar, the way heavy-popup sites do it.
  '/overlay': () => `${article}<script>
    setTimeout(() => {
      document.body.style.overflow = 'hidden';
      const back = Object.assign(document.createElement('div'), { id: 'backdrop' });
      back.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:1000';
      const modal = Object.assign(document.createElement('div'), { id: 'modal' });
      modal.style.cssText = 'position:fixed;top:20%;left:25%;width:50%;height:50%;background:#fff;z-index:1001;padding:20px';
      modal.innerHTML = '<h2>Subscribe to our newsletter!</h2><p>Get 20% off your first order.</p>'
        + '<input placeholder="email"> <button id="sub">Subscribe</button>'
        + '<button id="x" aria-label="Close" style="position:absolute;top:8px;right:8px">×</button>';
      modal.querySelector('#x').onclick = () => { window.__closedVia = 'button'; back.remove(); modal.remove(); document.body.style.overflow = ''; };
      modal.querySelector('#sub').onclick = () => { window.__subscribed = true; };
      const cookie = Object.assign(document.createElement('div'), { id: 'cookie' });
      cookie.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:120px;background:#eee;z-index:999';
      cookie.innerHTML = 'We use cookies to improve your experience. <button id="acc">Accept all</button> <button id="rej">Reject all</button>';
      cookie.querySelector('#acc').onclick = () => { window.__accepted = true; cookie.remove(); };
      cookie.querySelector('#rej').onclick = () => { window.__rejected = true; cookie.remove(); };
      document.body.append(back, modal, cookie);
    }, 300);
  </script>`,
  // Modal with no close button that locks scrolling and blurs the article.
  '/overlay-plain': () => `${article}<script>
    setTimeout(() => {
      document.documentElement.style.overflow = 'hidden';
      document.getElementById('content').style.filter = 'blur(4px)';
      const wall = Object.assign(document.createElement('div'), { id: 'wall' });
      wall.style.cssText = 'position:fixed;inset:0;background:rgba(255,255,255,.9);z-index:50;display:flex;align-items:center;justify-content:center';
      wall.innerHTML = '<div style="background:#fff;padding:40px;border:1px solid #ccc">Please turn off your ad blocker to keep reading.</div>';
      document.body.append(wall);
    }, 300);
  </script>`,
  // A login box you open yourself.
  '/user-modal': () => `${article}<button id="open" style="position:fixed;top:10px;left:10px">Log in</button><script>
    document.getElementById('open').onclick = () => setTimeout(() => {
      const m = Object.assign(document.createElement('div'), { id: 'login' });
      m.style.cssText = 'position:fixed;top:25%;left:30%;width:40%;height:40%;background:#fff;border:1px solid #999;z-index:10';
      m.innerHTML = 'Log in <input type="password"> <button aria-label="Close">×</button>';
      document.body.append(m);
    }, 100);
  </script>`,
  // Invisible full-page link that turns any click into an ad popup.
  '/trap': (port) => `${article}<script>
    setTimeout(() => {
      const a = Object.assign(document.createElement('a'), { id: 'trap', href: 'http://site-c.test:${port}/ad', target: '_blank' });
      a.style.cssText = 'position:fixed;inset:0;z-index:9999;opacity:0';
      document.body.append(a);
    }, 300);
  </script>`,
  // A page that embeds a video player from another site. ?top=trap also puts
  // an invisible click layer over the embedded frame, in the page itself.
  '/embed-host': (port, url, host) => {
    const other = host === 'site-a.test' ? 'site-b.test' : 'site-a.test';
    const kind = url.searchParams.get('case') || 'covers';
    const trap = url.searchParams.get('top') === 'trap'
      ? `<div id="toptrap" style="position:absolute;inset:0" onclick="window.open('http://site-c.test:${port}/x-top')"></div>` : '';
    return `<div id="wrap" style="position:relative;width:640px;height:360px">
        <iframe id="player" src="http://${other}:${port}/${url.searchParams.get('frame') || 'player'}?case=${kind}" width="640" height="360" style="border:0;display:block"></iframe>${trap}
      </div>${article}`;
  },
  // A wrapper frame: the real player is one frame deeper, on a third site,
  // and the wrapper lays an invisible click layer over it.
  '/wrapper': (port) => `<style>html,body{margin:0;height:100%}#w{position:relative;width:100%;height:100%}</style>
    <div id="w">
      <iframe id="inner" src="http://site-c.test:${port}/player?case=none" style="width:100%;height:100%;border:0;display:block"></iframe>
      <div id="wraptrap" style="position:absolute;inset:0" onclick="window.open('http://site-c.test:${port}/x-wrap')"></div>
    </div>`,
  // The player inside that frame: a video, its own click layer (#tap) and
  // control bar (#bar), plus whatever the case adds on top.
  '/player': (port, url) => {
    const C = `http://site-c.test:${port}`;
    const extra = {
      // What popup-heavy players lay over the video: an invisible click trap on
      // <body>, another frame, and a link layer to another site.
      covers: `setTimeout(() => {
        const trap = Object.assign(document.createElement('div'), { id: 'trap' });
        trap.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:2147483647';
        trap.onclick = () => window.open('${C}/x-trap');
        document.body.append(trap);
        const frame = Object.assign(document.createElement('iframe'), { id: 'overframe', src: '${C}/x-frame' });
        frame.style.cssText = 'position:absolute;top:20%;left:25%;width:50%;height:50%;z-index:50;border:0';
        const link = Object.assign(document.createElement('a'), { id: 'overlink', href: '${C}/x-link', target: '_blank' });
        link.style.cssText = 'position:absolute;inset:0;z-index:40';
        link.innerHTML = '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width:100%;height:100%">';
        document.getElementById('p').append(frame, link);
      }, 300);`,
      // An invisible layer inside the player that opens a popup on every click.
      soft: `const t = Object.assign(document.createElement('div'), { id: 'softtrap' });
        t.style.cssText = 'position:absolute;inset:0;z-index:5';
        t.onclick = () => window.open('${C}/x-soft');
        document.getElementById('p').append(t);`,
      // The real play button, which opens a popup on the first click only.
      dual: `const b = Object.assign(document.createElement('div'), { id: 'bigplay' });
        b.style.cssText = 'position:absolute;inset:0;z-index:5;background:#123';
        b.onclick = () => { if (!window.__popped) { window.__popped = 1; window.open('${C}/x-dual'); return; } window.__played = 1; b.remove(); };
        document.getElementById('p').append(b);`
    }[url.searchParams.get('case')] || '';
    return `<style>html,body{margin:0;height:100%;background:#000}#p{position:relative;width:100%;height:100%}video{width:100%;height:100%;display:block}</style>
      <div id="p">
        <video id="v" muted></video>
        <div id="tap" style="position:absolute;inset:0;z-index:1" onclick="window.__toggled=(window.__toggled||0)+1"></div>
        <div id="bar" style="position:absolute;left:0;right:0;bottom:0;height:40px;z-index:2;background:rgba(0,0,0,.6)"><button id="play">Play</button><input type="range"></div>
      </div>
      <script>${extra}</script>`;
  },
  // A modal <dialog> shown on load.
  '/dialog': () => `${article}<dialog id="dlg"><p>We noticed you are using an ad blocker. Please allowlist us.</p><button>OK</button></dialog><script>
    setTimeout(() => document.getElementById('dlg').showModal(), 300);
  </script>`
};

export function startServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    const port = server.address().port;
    const url = new URL(req.url, `http://${host}`);
    hits.push(`${host}${url.pathname}`);
    const B = `http://site-b.test:${port}`;
    const C = `http://site-c.test:${port}`;
    const html = (body) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>${host}${url.pathname}</title></head><body>${body}</body></html>`);
    };

    if (host === 'doubleclick.net' || host === 'www.google-analytics.com' || host === 'popads.net') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.adLoaded = true;');
    }
    // A made-up third-party script, blocked only through the extension's own
    // custom block list. Its name avoids "ad" so a browser's built-in blocker
    // (e.g. Brave Shields, once its lists load) can't be what blocks it.
    if (host === 'static.site-c.test') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end('window.customAdLoaded = true;');
    }

    if (host.endsWith('.test') && OVERLAY_PAGES[url.pathname]) return html(OVERLAY_PAGES[url.pathname](port, url, host));

    if (host === 'site-a.test') {
      switch (url.pathname) {
        case '/':
          return html(`
            <h1>Site A</h1>
            <script src="http://doubleclick.net:${port}/ad.js"></script>
            <script src="http://static.site-c.test:${port}/widget.js"></script>
            <img id="pixel" src="http://www.google-analytics.com:${port}/collect.gif">
            <ins class="adsbygoogle" id="adbox" style="display:block;width:300px;height:250px">AD</ins>
            <div id="content">Real content</div>
            <a id="sameLink" href="/page2">same-site link</a>
            <a id="crossLink" href="${B}/">cross-site link</a>
            <a id="crossBlank" href="${B}/blank" target="_blank">cross-site new tab</a>
            <a id="sameBlank" href="/page2" target="_blank">same-site new tab</a>
            <a id="redirectOut" href="/redirect-out">same-site link that 302s away</a>
            <button id="openCross" onclick="window.__w = window.open('${B}/popup')">open cross</button>
            <button id="openSame" onclick="window.__w = window.open('/page2?popup')">open same</button>
            <button id="popunder" onclick="const a=document.createElement('a');a.href='${C}/popunder';a.target='_blank';a.click()">popunder</button>
            <button id="blankThenNav" onclick="const w=window.open('');w.location='${C}/via-blank'">blank then nav</button>
            <button id="bounce" onclick="window.open('/bounce')">bounce</button>
            <button id="iframeOpen" onclick="const f=document.createElement('iframe');document.body.appendChild(f);f.contentWindow.open('${C}/via-iframe')">iframe open</button>
          `);
        case '/page2':
          return html('<h1>Site A page 2</h1>');
        case '/redirect-out':
          res.writeHead(302, { location: `${B}/landed` });
          return res.end();
        case '/js-redirect':
          return html(`<h1>JS redirect</h1><script>setTimeout(() => { location.href = '${B}/from-js'; }, 200);</script>`);
        case '/bounce':
          return html(`<h1>bounce</h1><script>setTimeout(() => { location.href = '${C}/after-bounce'; }, 100);</script>`);
      }
    }
    if (host === 'site-b.test' || host === 'site-c.test') return html(`<h1>${host}</h1>`);
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}
