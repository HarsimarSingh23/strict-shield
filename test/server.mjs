/*
 * One local HTTP server that pretends to be several sites. Chrome is started
 * with --host-resolver-rules so site-a.test, site-b.test, doubleclick.net ...
 * all resolve to 127.0.0.1, and this server routes on the Host header.
 */
import http from 'node:http';

const article = '<main id="content">' + ('<p>' + 'Real article text. '.repeat(40) + '</p>').repeat(30) + '</main>';

// On-screen popup test pages, served on every *.test host.
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

    if (host.endsWith('.test') && OVERLAY_PAGES[url.pathname]) return html(OVERLAY_PAGES[url.pathname](port));

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
