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
  /** Short privacy facts for the splash chips, already phrased for display. */
  facts: string[]
  bookmarks: { url: string; title: string }[]
  version: string
  homepage: string
}

export function newTabHtml(data: NewTabData): string {
  const { stats, facts } = data
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
  .wrap { max-width: 1000px; margin: 0 auto; padding: 0 32px 48px; }
  .splash {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    padding: 74px 0 44px;
    margin: 0 -32px 8px;
    border-bottom: 1px solid rgba(30, 38, 49, .65);
    background:
      radial-gradient(760px 340px at 50% -10%, rgba(79, 227, 193, .12), transparent 68%),
      radial-gradient(520px 260px at 82% 10%, rgba(167, 139, 250, .09), transparent 70%);
  }
  .splash::after {
    content: "";
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(79, 227, 193, .05) 1px, transparent 1px),
      linear-gradient(90deg, rgba(79, 227, 193, .05) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(circle at 50% 20%, #000 5%, transparent 68%);
    pointer-events: none;
  }
  .mark { position: relative; width: 132px; height: 150px; display: grid; place-items: center; }
  .mark svg.shield {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    color: rgba(79, 227, 193, .55);
    filter: drop-shadow(0 18px 44px rgba(79, 227, 193, .18));
  }
  .mark .w {
    position: relative;
    font: 700 74px/1 "Segoe UI", system-ui, sans-serif;
    letter-spacing: -.04em;
    background: linear-gradient(170deg, #b9fff0 4%, #4fe3c1 46%, #1f8f7c 100%);
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    transform: translateY(-4px);
  }
  .splash h1 {
    position: relative;
    margin: 18px 0 0;
    font-size: 30px;
    font-weight: 620;
    letter-spacing: -.01em;
    color: #eaf4ff;
  }
  .splash .lede {
    position: relative;
    margin: 9px 0 0;
    color: var(--muted);
    font-size: 13px;
    letter-spacing: .14em;
    text-transform: uppercase;
  }
  .chips { position: relative; display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; margin-top: 22px; }
  .chip {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 11px;
    border: 1px solid rgba(79, 227, 193, .2);
    border-radius: 999px;
    background: rgba(11, 26, 23, .55);
    color: #a9c9c1;
    font: 10.5px/1 "Cascadia Mono", Consolas, monospace;
    letter-spacing: .06em;
  }
  .chip i { width: 5px; height: 5px; border-radius: 999px; background: var(--mint); box-shadow: 0 0 8px rgba(79,227,193,.9); }
  .grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 18px; margin-top: 28px; }
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
    <header class="splash">
      <div class="mark">
        <svg class="shield" viewBox="0 0 120 136" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round">
          <path d="M60 4l52 20v52c0 30-22 48-52 56C30 124 8 106 8 76V24L60 4z" />
          <path d="M60 12l44 17v47c0 26-19 42-44 49-25-7-44-23-44-49V29L60 12z" stroke-opacity=".35" />
        </svg>
        <span class="w">W</span>
      </div>
      <h1>Welcome to WARDEN</h1>
      <p class="lede">Read everything. Give nothing.</p>
      <div class="chips">${facts.map((fact) => `<span class="chip"><i></i>${escapeHtml(fact)}</span>`).join('')}</div>
    </header>

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

/**
 * Lock screen. Its own document because it is the only thing that may be
 * visible while WARDEN is locked: the chrome, tabs and side panes are covered
 * by this window, not merely disabled.
 */
export function lockPageHtml(): string {
  return `<!doctype html><html><head><meta charset="utf-8" />
<title>WARDEN locked</title>
<style>
  ${BASE_CSS}
  html, body { height: 100%; overflow: hidden; }
  body {
    display: grid;
    place-items: center;
    background: #05070a;
  }
  .backdrop {
    position: fixed;
    inset: -60px;
    background-position: center;
    background-size: cover;
    filter: blur(34px) saturate(0.5) brightness(0.35);
    transform: scale(1.06);
  }
  .mesh {
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(79, 227, 193, 0.055) 1px, transparent 1px),
      linear-gradient(90deg, rgba(79, 227, 193, 0.055) 1px, transparent 1px);
    background-size: 34px 34px;
    mask-image: radial-gradient(circle at 50% 45%, transparent 10%, #000 78%);
  }
  .vignette {
    position: fixed;
    inset: 0;
    background: radial-gradient(680px 520px at 50% 42%, rgba(8, 12, 18, 0.55), rgba(4, 6, 9, 0.94) 70%);
  }
  .card {
    position: relative;
    width: min(440px, 84vw);
    padding: 34px 34px 28px;
    border-radius: 18px;
    border: 1px solid rgba(79, 227, 193, 0.18);
    background: linear-gradient(165deg, rgba(17, 23, 31, 0.94), rgba(9, 12, 17, 0.97));
    box-shadow: 0 30px 90px rgba(0, 0, 0, 0.68), inset 0 1px 0 rgba(255, 255, 255, 0.05);
    text-align: center;
    animation: rise 240ms cubic-bezier(0.2, 0.9, 0.2, 1);
  }
  @keyframes rise { from { opacity: 0; transform: translateY(10px) scale(0.985); } }
  .crest {
    width: 52px; height: 52px; margin: 0 auto 16px;
    border-radius: 15px;
    border: 1px solid rgba(79, 227, 193, 0.36);
    background: radial-gradient(circle at 30% 20%, rgba(79, 227, 193, 0.28), rgba(79, 227, 193, 0.04));
    display: grid; place-items: center;
    color: var(--mint);
  }
  .crest svg { width: 26px; height: 26px; }
  .eyebrow {
    font: 600 10px/1 "Cascadia Mono", Consolas, monospace;
    letter-spacing: 0.32em;
    color: var(--mint);
    text-transform: uppercase;
  }
  h1 { margin: 10px 0 6px; font-size: 21px; letter-spacing: 0.02em; }
  .user { color: var(--muted); font-size: 12.5px; }
  .user strong { color: var(--text); font-weight: 600; }
  form { margin-top: 22px; display: grid; gap: 10px; }
  .field {
    display: flex; align-items: center; gap: 8px;
    padding: 0 12px;
    border-radius: 11px;
    border: 1px solid var(--line);
    background: rgba(6, 9, 13, 0.9);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }
  .field:focus-within {
    border-color: rgba(79, 227, 193, 0.55);
    box-shadow: 0 0 0 3px rgba(79, 227, 193, 0.1);
  }
  input {
    flex: 1;
    background: none;
    border: 0;
    outline: 0;
    color: var(--text);
    font: 14px/1 "Segoe UI", system-ui, sans-serif;
    padding: 13px 0;
    letter-spacing: 0.14em;
  }
  input::placeholder { letter-spacing: 0; color: #5d6b7c; }
  button {
    border: 0;
    border-radius: 10px;
    padding: 11px 16px;
    font: 600 12.5px/1 "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.04em;
    color: #04120f;
    background: linear-gradient(180deg, #5df0cf, #35c9ab);
    cursor: pointer;
    transition: filter 140ms ease, transform 140ms ease;
  }
  button:hover { filter: brightness(1.06); }
  button:active { transform: translateY(1px); }
  button[disabled] { opacity: 0.55; cursor: default; }
  /* Windows Hello first: it is the credential people actually use to sign in,
     and the PIN never enters this document — Windows verifies it. */
  .hello {
    margin-top: 22px;
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 9px;
    padding: 12px 16px;
    border: 0;
    border-radius: 10px;
    font: 600 12.5px/1 "Segoe UI", system-ui, sans-serif;
    letter-spacing: 0.03em;
    color: #04120f;
    background: linear-gradient(180deg, #5df0cf, #35c9ab);
    cursor: pointer;
    transition: filter 140ms ease, transform 140ms ease;
  }
  .hello svg { width: 18px; height: 18px; }
  .hello:hover { filter: brightness(1.06); }
  .hello:active { transform: translateY(1px); }
  .hello[disabled] { opacity: 0.55; cursor: default; }
  .hello-note {
    margin-top: 9px;
    color: var(--amber);
    font-size: 11px;
    line-height: 1.55;
  }
  .hello-note:empty { display: none; }
  .hello[disabled] { opacity: 0.5; }
  .or {
    margin: 12px 0 0;
    color: var(--muted);
    font-size: 11px;
    letter-spacing: 0.02em;
  }
  .error {
    min-height: 16px;
    margin-top: 12px;
    color: var(--danger);
    font-size: 12px;
    text-align: left;
  }
  .hint {
    margin-top: 18px;
    color: var(--muted);
    font-size: 11.5px;
    display: flex;
    justify-content: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  kbd {
    border: 1px solid var(--line);
    border-bottom-width: 2px;
    border-radius: 5px;
    padding: 1px 5px;
    font: 600 10.5px/1.4 "Cascadia Mono", monospace;
    color: var(--text);
    background: var(--panel-2);
  }
  .clock {
    position: fixed;
    top: 22px; right: 26px;
    font: 600 12px/1 "Cascadia Mono", Consolas, monospace;
    color: #6f8096;
    letter-spacing: 0.16em;
  }
</style></head>
<body>
  <div class="backdrop" id="backdrop"></div>
  <div class="mesh"></div>
  <div class="vignette"></div>
  <div class="clock" id="clock"></div>
  <div class="card">
    <div class="crest">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
        <rect x="4" y="10.5" width="16" height="10" rx="2.4" />
        <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
        <circle cx="12" cy="15.4" r="1.2" fill="currentColor" stroke="none" />
      </svg>
    </div>
    <div class="eyebrow">Warden protected</div>
    <h1>Screen locked</h1>
    <div class="user">Signed in as <strong id="user">this device</strong></div>
    <button class="hello" id="hello" type="button">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3.6c-3.1 0-5.6 2.5-5.6 5.6v2.2c0 2.1-.5 4-1.6 5.6" />
        <path d="M12 6.6a2.6 2.6 0 0 0-2.6 2.6v2.6c0 1.7-.4 3.2-1.2 4.5" />
        <path d="M14.6 9.2v2.6c0 2.6-.7 5-2 7" />
        <path d="M17.6 9.2v2.6c0 3.3-1 6.3-2.8 8.6" />
        <path d="M12 12.6v.6" />
      </svg>
      <span>Unlock with Windows Hello</span>
    </button>
    <div class="hello-note" id="helloNote"></div>
    <div class="or">PIN, fingerprint or face · or your account password</div>
    <form id="form" autocomplete="off">
      <div class="field">
        <input id="password" type="password" placeholder="Account password" spellcheck="false" autofocus />
        <button id="submit" type="submit">Unlock</button>
      </div>
    </form>
    <div class="error" id="error"></div>
    <div class="hint"><span><kbd>Ctrl</kbd> <kbd>\\</kbd> locks</span><span>·</span><span id="reason">Hello unlocks this screen</span></div>
  </div>
<script>
  (async function () {
    var api = window.warden;
    var input = document.getElementById('password');
    var button = document.getElementById('submit');
    var hello = document.getElementById('hello');
    var helloNote = document.getElementById('helloNote');
    var helloUsable = true;
    var error = document.getElementById('error');
    var backdrop = document.getElementById('backdrop');
    var clock = document.getElementById('clock');

    setInterval(function () {
      clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }, 1000);
    clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (!api || !api.lock) {
      error.textContent = 'Lock channel unavailable.';
      return;
    }

    var boot = await api.lock.bootstrap();
    document.getElementById('user').textContent = boot.user || 'this device';
    if (boot.background && /^data:image\//.test(boot.background)) {
      backdrop.style.backgroundImage = 'url("' + boot.background + '")';
    }
    if (boot.lock && boot.lock.byTimeout) {
      document.getElementById('reason').textContent = 'Locked after ' + boot.lock.timeoutMinutes + ' min idle';
    }

    api.lock.onState(function (state) {
      error.textContent = state.error || '';
      button.disabled = Boolean(state.busy);
      input.disabled = Boolean(state.busy);
      hello.disabled = Boolean(state.busy) || !helloUsable;
      if (!state.busy) input.focus();
    });

    // Ask the verifier before it is needed. If this account has no Hello
    // enrolment, say so here instead of letting the operator press a button
    // that cannot work while the screen is covered.
    function applyHello(report) {
      if (!report || !report.hello) return;
      // "enrolled" means the verifier stayed silent on a machine that has a
      // Hello container, so the button stays live and the password waits below.
      helloUsable = report.hello === 'available' || report.hello === 'enrolled';
      hello.disabled = !helloUsable;
      helloNote.textContent = helloUsable ? '' : report.note || '';
    }
    api.lock.helloStatus().then(applyHello).catch(function () {
      /* the password field remains the way in */
    });

    async function withHello() {
      error.textContent = '';
      hello.disabled = true;
      var result = await api.lock.hello();
      hello.disabled = false;
      if (!result.ok) error.textContent = result.error || 'Windows Hello did not verify you.';
    }
    hello.addEventListener('click', withHello);

    document.getElementById('form').addEventListener('submit', async function (event) {
      event.preventDefault();
      error.textContent = '';
      button.disabled = true;
      var result = await api.lock.unlock(input.value);
      if (!result.ok) {
        error.textContent = result.error || 'Unlock failed.';
        input.value = '';
        input.focus();
      }
      button.disabled = false;
    });

    // Ctrl+\ while locked must not do anything surprising, and Escape must not
    // dismiss the overlay: the app stays covered until the password checks out.
    window.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' || event.key === 'F12') event.preventDefault();
    });
    document.addEventListener('contextmenu', function (event) { event.preventDefault(); });
    input.focus();
  })();
</script>
</body></html>`
}
