import type { PrivacyStats } from '@shared/types'

const BASE_CSS = `
  :root {
    color-scheme: dark;
    --bg: #080a0d;
    --panel: #0f1319;
    --panel-2: #141a22;
    --line: #1e2631;
    --text: #dce6f2;
    --muted: #7b8a9d;
    --mint: #4fe3c1;
    --violet: #a78bfa;
    --amber: #f5b95b;
    --danger: #ff6b6b;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    background:
      radial-gradient(900px 460px at 12% -8%, rgba(79, 227, 193, 0.10), transparent 60%),
      radial-gradient(720px 420px at 88% 4%, rgba(167, 139, 250, 0.10), transparent 62%),
      var(--bg);
    color: var(--text);
    font: 14px/1.55 ui-sans-serif, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  a { color: var(--mint); text-decoration: none; }
  a:hover { text-decoration: underline; }
  code, .mono { font-family: "Cascadia Mono", "JetBrains Mono", Consolas, ui-monospace, monospace; }
`

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
    return map[char] ?? char
  })

export interface NewTabData {
  stats: PrivacyStats
  bookmarks: { url: string; title: string }[]
  version: string
  homepage: string
}

export function newTabHtml(data: NewTabData): string {
  const { stats } = data
  const blocked = stats.blockedTotal.toLocaleString()
  const top = stats.topHosts
    .slice(0, 6)
    .map(
      (entry) =>
        `<li><span class="mono">${escapeHtml(entry.host)}</span><span class="count">${entry.count}</span></li>`
    )
    .join('')

  const marks = data.bookmarks
    .slice(0, 12)
    .map((mark) => {
      let host = mark.url
      try {
        host = new URL(mark.url).hostname.replace(/^www\./, '')
      } catch {
        /* keep raw */
      }
      return `<a class="mark" href="${escapeHtml(mark.url)}">
          <span class="mark-host mono">${escapeHtml(host)}</span>
          <span class="mark-title">${escapeHtml(mark.title || host)}</span>
        </a>`
    })
    .join('')

  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:;" />
<title>WARDEN</title>
<style>
${BASE_CSS}
  .wrap { max-width: 980px; margin: 0 auto; padding: 64px 32px 48px; }
  .brand { display: flex; align-items: center; gap: 14px; }
  .sigil {
    width: 34px; height: 34px; border-radius: 9px;
    background: linear-gradient(150deg, var(--mint), #1f8f7c 55%, #0d5a4f);
    box-shadow: 0 0 0 1px rgba(79,227,193,.35), 0 10px 30px -12px rgba(79,227,193,.7);
    position: relative;
  }
  .sigil::after {
    content: ""; position: absolute; inset: 9px 10px;
    border: 2px solid rgba(5, 20, 17, .75); border-radius: 3px 3px 9px 9px;
    border-top-width: 3px;
  }
  h1 { font-size: 15px; letter-spacing: .32em; margin: 0; font-weight: 650; }
  .tag { color: var(--muted); font-size: 12px; letter-spacing: .16em; text-transform: uppercase; margin-top: 4px; }
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; margin-top: 38px; }
  .card { background: linear-gradient(180deg, rgba(20,26,34,.85), rgba(15,19,25,.85)); border: 1px solid var(--line); border-radius: 14px; padding: 18px 20px; }
  .card h2 { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--muted); margin: 0 0 14px; font-weight: 600; }
  .hero { font-size: 44px; line-height: 1; font-weight: 620; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }
  .hero small { font-size: 12px; color: var(--muted); letter-spacing: .12em; text-transform: uppercase; margin-left: 8px; }
  .sub { color: var(--muted); font-size: 12.5px; margin-top: 10px; }
  ul.hosts { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
  ul.hosts li { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; color: #a9b7c8; border-bottom: 1px dashed rgba(30,38,49,.9); padding-bottom: 6px; }
  ul.hosts .count { color: var(--violet); font-variant-numeric: tabular-nums; }
  .marks { margin-top: 22px; display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; }
  .mark { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border: 1px solid var(--line); border-radius: 11px; background: rgba(15,19,25,.7); color: var(--text); }
  .mark:hover { border-color: rgba(79,227,193,.45); text-decoration: none; }
  .mark-host { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--mint); }
  .mark-title { font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #c3cfdd; }
  .keys { margin-top: 30px; color: var(--muted); font-size: 11.5px; display: flex; flex-wrap: wrap; gap: 16px; }
  kbd { font: 11px/1 ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 5px; padding: 4px 6px; color: #b9c6d6; background: #0d1116; margin-right: 5px; }
  .empty { color: var(--muted); font-size: 12px; }
  .foot { margin-top: 28px; color: #566475; font-size: 11px; letter-spacing: .08em; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="brand">
      <div class="sigil"></div>
      <div>
        <h1>WARDEN</h1>
        <div class="tag">Read everything. Give nothing.</div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h2>Session</h2>
        <div class="hero">${blocked}<small>blocked</small></div>
        <div class="sub">${stats.requestsSeen.toLocaleString()} requests inspected · ${stats.cookiesStripped.toLocaleString()} cookies refused · ${stats.rulesLoaded.toLocaleString()} rules armed</div>
        <div class="sub">Every tab runs in memory. Nothing is written to disk when this window closes.</div>
      </div>
      <div class="card">
        <h2>Top blocked</h2>
        ${top ? `<ul class="hosts">${top}</ul>` : '<div class="empty">Clean so far. Load a page to see what Bastion refuses.</div>'}
      </div>
    </div>

    ${marks ? `<div class="marks">${marks}</div>` : ''}

    <div class="keys">
      <span><kbd>Ctrl</kbd><kbd>K</kbd> command palette</span>
      <span><kbd>Ctrl</kbd><kbd>L</kbd> address</span>
      <span><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>S</kbd> Scry page</span>
      <span><kbd>Ctrl</kbd><kbd>J</kbd> video dock</span>
      <span><kbd>Ctrl</kbd><kbd>\`</kbd> Trench</span>
    </div>
    <div class="foot mono">WARDEN ${escapeHtml(data.version)} · hard-block cookie policy · memory-only profile</div>
  </div>
</body></html>`
}

export function errorHtml(code: string, description: string, url: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';" />
<title>Blocked</title>
<style>${BASE_CSS}
  .wrap { max-width: 640px; margin: 0 auto; padding: 96px 32px; }
  .code { color: var(--danger); font-size: 12px; letter-spacing: .22em; text-transform: uppercase; }
  h1 { font-size: 30px; letter-spacing: -.02em; margin: 14px 0 10px; }
  p { color: var(--muted); font-size: 13.5px; }
  .url { background: var(--panel); border: 1px solid var(--line); border-radius: 9px; padding: 12px 14px; font-size: 12px; color: #b9c6d6; word-break: break-all; }
</style></head>
<body><div class="wrap">
  <div class="code">Navigation stopped · ${escapeHtml(code)}</div>
  <h1>${escapeHtml(description || 'This request did not complete')}</h1>
  <p>WARDEN did not retry over an insecure connection and did not send credentials.</p>
  <div class="url mono">${escapeHtml(url)}</div>
</div></body></html>`
}

export function viewerHtml(src: string, title: string, kind: string, startAt = 0): string {
  const isHls = kind === 'hls'
  return `<!doctype html>
<html><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; media-src http: https: blob:; img-src data:;" />
<title>${escapeHtml(title || 'Splay')}</title>
<style>${BASE_CSS}
  html, body { background: #05070a; overflow: hidden; }
  .stage { position: fixed; inset: 0; display: grid; place-items: center; }
  video { width: 100%; height: 100%; object-fit: contain; background: #05070a; outline: none; }
  .hud {
    position: fixed; left: 0; right: 0; bottom: 0; padding: 10px 12px 12px;
    display: flex; flex-direction: column; gap: 7px;
    background: linear-gradient(180deg, transparent, rgba(4,6,9,.92) 45%);
    opacity: .0; transition: opacity .18s ease;
  }
  body:hover .hud { opacity: 1; }
  .row { display: flex; align-items: center; gap: 8px; }
  button {
    all: unset; cursor: pointer; color: #cfe0ee; font-size: 11px; letter-spacing: .1em;
    text-transform: uppercase; padding: 4px 8px; border-radius: 6px; border: 1px solid #1e2631;
    background: rgba(15,19,25,.85);
  }
  button:hover { border-color: rgba(79,227,193,.5); color: var(--mint); }
  .title { font-size: 11.5px; color: #93a4b7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
  input[type=range] { width: 100%; accent-color: var(--mint); }
  .fallback { color: #93a4b7; text-align: center; padding: 24px; font-size: 12.5px; line-height: 1.7; }
  .fallback b { color: var(--text); display: block; margin-bottom: 6px; font-size: 14px; }
</style></head>
<body>
<div class="stage" id="stage"></div>
<script>
(function () {
  var src = ${JSON.stringify(src)};
  var kind = ${JSON.stringify(isHls ? 'hls' : 'video')};
  var stage = document.getElementById('stage');

  if (kind === 'hls') {
    stage.innerHTML = '<div class="fallback"><b>HLS stream</b>Chromium cannot play this transport stream natively.<br>Open it in a media player, or use the page&rsquo;s own player.</div>';
    return;
  }

  var video = document.createElement('video');
  video.src = src;
  video.autoplay = true;
  video.muted = true;
  video.loop = false;
  video.playsInline = true;
  video.controls = false;
  video.preload = 'auto';
  video.addEventListener('error', function () {
    stage.innerHTML = '<div class="fallback"><b>Media refused</b>The source did not send a playable stream to WARDEN.</div>';
  });
  stage.appendChild(video);

  var hud = document.createElement('div');
  hud.className = 'hud';
  hud.innerHTML =
    '<div class="row"><span class="title"></span><button data-act="back">&minus;10s</button><button data-act="fwd">+10s</button><button data-act="pause">Pause</button><button data-act="mute">Unmute</button></div>' +
    '<input type="range" min="0" max="100" value="0" id="seek" />' +
    '<div class="row"><button data-act="slow">0.75&times;</button><button data-act="norm">1&times;</button><button data-act="fast">1.5&times;</button></div>';
  document.body.appendChild(hud);
  hud.querySelector('.title').textContent = ${JSON.stringify(title || '')};

  var seek = hud.querySelector('#seek');
  var pauseBtn = hud.querySelector('[data-act=pause]');
  var muteBtn = hud.querySelector('[data-act=mute]');

  hud.addEventListener('click', function (event) {
    var act = event.target && event.target.getAttribute && event.target.getAttribute('data-act');
    if (!act) return;
    if (act === 'pause') { if (video.paused) video.play(); else video.pause(); }
    if (act === 'mute') { video.muted = !video.muted; }
    if (act === 'back') video.currentTime = Math.max(0, video.currentTime - 10);
    if (act === 'fwd') video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 10);
    if (act === 'slow') video.playbackRate = 0.75;
    if (act === 'norm') video.playbackRate = 1;
    if (act === 'fast') video.playbackRate = 1.5;
    pauseBtn.textContent = video.paused ? 'Play' : 'Pause';
    muteBtn.textContent = video.muted ? 'Unmute' : 'Mute';
  });

  seek.addEventListener('input', function () {
    if (video.duration && isFinite(video.duration)) {
      video.currentTime = (Number(seek.value) / 100) * video.duration;
    }
  });
  video.addEventListener('timeupdate', function () {
    if (video.duration && isFinite(video.duration)) {
      seek.value = String((video.currentTime / video.duration) * 100);
    }
  });
  video.addEventListener('play', function () { pauseBtn.textContent = 'Pause'; });
  video.addEventListener('pause', function () { pauseBtn.textContent = 'Play'; });

  window.__wardenPlayer = video;
  var startAt = ${Number.isFinite(startAt) ? Math.max(0, Number(startAt)) : 0};
  if (startAt > 0) {
    video.addEventListener('loadedmetadata', function () {
      try { video.currentTime = startAt; } catch (e) {}
    }, { once: true });
  }
  video.play().catch(function () {});
})();
</script>
</body></html>`
}
