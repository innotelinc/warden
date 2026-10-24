# WARDEN

**Read everything. Give nothing.**

A privacy-first operations browser for security and network administrators. WARDEN is a real Chromium browser (Electron 45) with a cookieless browsing profile, a request-level ad/tracker engine, an embedded shell, a site deconstructor, native mail, and a unified messaging hub — in one dense, keyboard-driven console.

| Module | What it is |
| --- | --- |
| **Bastion** | The privacy engine: cookies blocked unless a site is explicitly allowed, tracker/ad filtering, HTTPS-only, referrer trimming, GPC/DNT, fingerprint noise, permission lockdown. |
| **Splay** | Video dock. Playing media branches into up to three independent panes on the right so you can keep reading while it plays. |
| **Trench** | Terminal. Real PTY (ConPTY on Windows, PTY on Unix) via `node-pty`, with a line-buffered fallback if the native module cannot load. Custom mint-on-black theme, session tabs. |
| **Relay** | Mail. Native IMAP + SMTP, OS-keychain credentials, HTML sanitized with remote content withheld. |
| **Concourse** | Unified messaging. Slack, Discord, Teams, WhatsApp, Telegram, Element, Google Chat and Mattermost in isolated memory-only panes with unread aggregation. |
| **Scry** | Deconstructor. Capture a live page over Chrome DevTools Protocol, produce a recon report, a standalone static clone, and a Vite + React scaffold. |
| **Policy** | Every switch, with the enforcement point stated. |

---

## Privacy model (what is actually enforced)

WARDEN does not ask about cookies. It refuses them. Electron has no Chrome-style cookie-policy switch, so the guarantee is built from five layers, all in the main process:

1. **Request interception** — `webRequest.onBeforeRequest` consults the filter engine (Adblock-Plus syntax, EasyList-compatible subset) and cancels matched requests. HTTPS-only upgrades top-level `http://` navigation before it leaves the machine.
2. **Request headers** — `Cookie` is deleted unless the destination host is allowlisted (or is the visited site in first-party mode). `Referer` is trimmed to the origin. `DNT: 1` and `Sec-GPC: 1` are added. `X-Client-Data` is removed.
3. **Response headers** — `Set-Cookie` is stripped for every host the policy rejects, and `Report-To`/`NEL` beacons are removed.
4. **Cookie store guard** — `session.cookies.set` is wrapped to reject disallowed writes, and a sweep runs on navigation and on demand.
5. **Page-level lock** — the content preload redefines `Document.prototype.cookie` and removes `cookieStore` for any site that is not allowed, so JavaScript cannot create cookies either.

The browsing session is created from a partition **without** the `persist:` prefix, so Chromium keeps it in memory. Quit WARDEN and there is no cookie database, no cache of visited pages, and no session file. Burner tabs get their own throwaway session. Concourse service panes get one isolated session each, with first-party cookies allowed and third parties cut — otherwise chat logins could not work at all. That is stated in the UI.

Also enforced: every permission request is denied (geolocation, notifications, media, HID, serial, USB, MIDI, clipboard beyond sanitized-write/read), `webview` attachment is blocked, popups become WARDEN tabs, WebRTC non-proxied UDP is disabled, and the app's own network calls (filter sync only, on demand) are the only non-page traffic.

**Honest limits:** WARDEN is not a VPN; it does not hide your IP. It does not defeat TLS or DNS fingerprinting. It cannot stop a site from refusing service when cookies are blocked — that is what the allowlist is for. Storage APIs other than cookies (localStorage, IndexedDB, Cache) are likewise memory-only per session but are not individually blocked.

### Allowing a site

Toolbar shield → **Allow cookies for this site** (or Policy → allowlist). The allowance is in-memory for the session and never written to a cookie database. Revoking it purges that site's cookies immediately.

---

## Running it

```bash
npm install
npm run dev      # electron-vite dev, hot reload
npm run build    # produces out/
npm start        # run the built app
```

Requires Node 20+ (verified on 22.23.3). `node-pty` ships prebuilds for `win32-x64` and `darwin-*`; a PTY backend was verified under Electron on this machine, with the pipe fallback available everywhere else.

### Verification

```bash
npm run typecheck     # main, preload and renderer projects
npm test              # 67 unit tests over the privacy engine, clone writer, recon, sanitizers
npm run build
npm run smoke         # boots the real app, drives the UI, asserts privacy behaviour
npm run verify:remote # headless Chrome + CDP capture + clone + REA CLI probe
npm run verify        # typecheck + tests + build + smoke
npm run dist          # installer + portable build (release/)
npm run smoke:dist    # run the full smoke suite against the packaged app
```

`npm run smoke` serves a page that tries two tracker requests and sets cookies, then launches WARDEN and asserts:

- fingerprint surface is spoofed (`hardwareConcurrency` 4, empty plugins)
- `document.cookie` is inert and the cookie store stays empty
- Bastion blocked the tracker requests
- Scry captures the page and extracts design tokens
- Trench starts a PTY shell
- the renderer paints (brand, rail, toolbar, all six workspaces, no runtime errors)

`npm run verify:remote` launches headless Chrome on a debug port with a throwaway profile inside `.tmp/`, runs the WebSocket CDP capture/clone integration test against it, then asks the REA CLI to list the same targets.

---

## Packaging (Windows)

```bash
npm run dist           # NSIS installer + single-file portable, x64
npm run dist:dir       # unpacked build only (fast, for testing)
npm run smoke:dist     # boots release/win-unpacked/WARDEN.exe and asserts behaviour
npm run icon           # regenerate build/icon.ico + icon.png
```

| Output | What it is |
| --- | --- |
| `release/WARDEN-Setup-0.1.0.exe` | Per-user NSIS installer. Not one-click: the operator picks the directory, and it creates Start menu + desktop shortcuts named WARDEN. |
| `release/WARDEN-Portable-0.1.0.exe` | Single executable. Extracts to a temp directory at launch, keeps its own profile, leaves no installed state. |
| `release/win-unpacked/` | Raw app directory, useful for smoke tests and for copying to a lab share. |

The packaged app is verified, not just built: `npm run smoke:dist` runs the same 17 checks as `npm run smoke` (cookies inert, trackers blocked, PTY shell, all six workspaces) against `release/win-unpacked/WARDEN.exe`. Point it at the portable artifact to test that instead:

```bash
WARDEN_SMOKE_BIN=release/WARDEN-Portable-0.1.0.exe npm run smoke:dist
```

Both were run through the suite last build, 17/17. `node-pty` is unpacked from the asar archive (`asarUnpack`) because it loads a native `.node` binary; `npmRebuild` is off because the shipped prebuilds are the ones that were tested against Electron 45.

App metadata is embedded in both executables: `ProductName` WARDEN, `FileDescription` from the package description, version 0.1.0, company WARDEN, and the generated shield icon at 16–256px.

**The builds are unsigned.** Windows SmartScreen will warn on first run; that is expected without a code-signing certificate. To sign, set `CSC_LINK` and `CSC_KEY_PASSWORD` before `npm run dist`. Nothing else changes.

### Deploying it

Both actions are per-user and need no administrator rights, so they work under a standard account and through most endpoint tooling without an elevation step.

```bash
# Silent install, default path (%LOCALAPPDATA%\Programs\WARDEN)
WARDEN-Setup-0.1.0.exe /S

# Silent install to a chosen directory: /D= must be last, unquoted, no trailing backslash
WARDEN-Setup-0.1.0.exe /S /D=C:\Tools\WARDEN

# Silent uninstall
"%LOCALAPPDATA%\Programs\WARDEN\Uninstall WARDEN.exe" /currentuser /S
```

For uninstall, prefer the `QuietUninstallString` value under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>` — it already
encodes the install path and correct arguments, so it stays valid when `/D=`
was used. Do not hardcode the path above in a script that used a custom directory.

The uninstall entry is written to HKCU (never HKLM) and carries `DisplayName`,
`DisplayVersion`, `Publisher`, `DisplayIcon`, `EstimatedSize`, and
`InstallLocation`. `InstallLocation` is populated by the hook in
[`build/installer.nsh`](build/installer.nsh) because electron-builder otherwise
records it only in its own bookkeeping key, where Windows and asset-inventory
tools will not find it. Silent install does not launch the app.

**What uninstall leaves behind:** `%APPDATA%\WARDEN` (about 7 MB) survives, by
`deleteAppDataOnUninstall: false`. It holds `settings.json`, `history.json` and
GPU caches — and no cookie jar, since the profile is memory-only for cookies.
Removing the directory is what makes an uninstall total, and it also clears
allowlists, so decide per fleet whether reinstall should preserve settings. The
install directory, both shortcuts, and every registry key are removed.

**Portable caveat:** the portable exe extracts a full Electron tree to
`%TEMP%\WARDEN` (about 375 MB) and deletes it only on a graceful exit. A killed
or crashed portable process leaves that directory behind until temp cleanup
runs, which matters if you hand the exe to people who force-quit.

**For Intune or SCCM,** [`scripts/deploy-warden.ps1`](scripts/deploy-warden.ps1) wraps
all of the above into one script with `-Action Install|Uninstall|Detect`, so the same
file serves as the install, detection and uninstall command. It logs to
`%ProgramData%\WARDEN-Deploy\deploy.log`, returns 0/1 from Detect for the Intune
detection contract, and refuses a per-user install under SYSTEM — that combination
silently installs into the SYSTEM profile where no user can see it. Use
`-Scope Machine` for a fleet install to Program Files with an HKLM entry:

```powershell
.\scripts\deploy-warden.ps1 -Action Install -Scope Machine   # or User, when Intune runs as the user
.\scripts\deploy-warden.ps1 -Action Detect                   # exit 0 = present
.\scripts\deploy-warden.ps1 -Action Uninstall                # add -KeepUserData to keep settings
```

**For Intune Win32,** [`deployment/intune/warden-win32app.json`](deployment/intune/warden-win32app.json)
is the app definition as a Graph `win32LobApp` body: install and uninstall command
lines, a file-version detection rule on `%ProgramFiles%\WARDEN\WARDEN.exe` (not the
uninstall `DisplayName`, which embeds the version), x64 / Windows 10 requirements, and
return codes. Intune has no manifest file to upload — the `.intunewin` comes from
Microsoft's Content Prep Tool — so [`scripts/package-intune.ps1`](scripts/package-intune.ps1)
stages the payload with both the setup exe and the deploy script (the command lines use
relative paths, so both must sit at the content root) and builds the package when the
tool is available.

---

## Keyboard

| Keys | Action |
| --- | --- |
| `Ctrl+K` | Command palette |
| `Ctrl+L` | Address bar |
| `Ctrl+T` / `Ctrl+W` | New tab / close tab |
| `Ctrl+Shift+N` | Burner tab |
| `Ctrl+1…6` | Browse / Trench / Relay / Concourse / Scry / Policy |
| `Ctrl+J` | Toggle Splay dock |
| `` Ctrl+` `` | Toggle Trench drawer |
| `Ctrl+Shift+S` | Scry the current page |
| `Ctrl+,` | Policy |
| `Ctrl+F` | Find in page |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in Trench |

---

## Scry: deconstruct a site

Two sources feed the same pipeline:

**WARDEN tabs** — pick any open tab in Scry. WARDEN attaches its own debugger and reloads the tab with the network recorder armed. No Chrome needed.

**Chrome on port 9222** — launch Chrome with:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="C:\chrome-debug-profile" http://192.168.1.88/
```

then **scan port** in Scry. WARDEN connects over CDP directly — the app has no dependency on REA.

**Debug mode** — Policy → Scry → *Debug mode (self debug port)* exposes WARDEN's own
CDP endpoint on loopback, so REA, Chrome DevTools or `curl http://127.0.0.1:9223/json`
can inspect the tabs WARDEN is already running. It binds `127.0.0.1` only, stays closed
at `0`, and takes effect after a restart. With it on, `rea analyze` works against WARDEN
tabs as well as remote ones. Scry itself never needs it: WARDEN tabs go through the
built-in debugger.

Each capture writes, under `Documents/WARDEN-Scry/<host>-<timestamp>/`:

- `clone/` — standalone static copy with local assets and rewritten CSS/HTML references. Scripts and inline event handlers are stripped by default.
- `scaffold/` — a runnable Vite + React project: one component per captured top-level block, design tokens as CSS variables, assets under `public/`.
- `report.json` — detected stack, response headers and missing security headers, third parties, tracker hosts, cookies (names only), mixed content, XHR/fetch endpoints, forms, design tokens, findings.
- `capture.json` — every observed request and captured resource, without bodies.
- `screenshot.png` when cloning.

Because Bastion is running, Scry sees only requests that actually left the browser. The report states the blocked count and calls its tracker list a lower bound. Turn off the relevant filters if you need the full footprint.

### REA (optional escalation)

`rea` is a separate reverse-engineering CLI. WARDEN detects it and offers **rea analyze** for remote targets, which runs `rea analyze-web-bundle` and shows the JSON in the panel. It is verified working against headless Chrome (`rea list-browser-targets` returned the live target with evidence metadata). WARDEN itself never requires it.

---

## Mail (Relay)

Add an account with IMAP + SMTP hosts, port, TLS and an app password. WARDEN verifies both protocols before saving. The password is encrypted with the OS keychain (`safeStorage`: DPAPI / Keychain / libsecret) into `secrets.json`; if the platform has no encryption backend WARDEN refuses to persist it rather than writing plaintext.

Message HTML is sanitized in the main process: scripts, iframes, forms, `<link>`, `<style>` and event handlers are removed, remote images are replaced with placeholders and counted, and the result renders inside a sandboxed iframe with a deny-all CSP. **No account or message content is fetched until you open Relay.**

## Messaging (Concourse)

Each service runs in its own memory-only session, so you sign in again after a quit. Unread counts are read from the document title conventions the services already use (`(3) Slack`, `[3] Discord`, `7 • WhatsApp`). Opening links from a pane loads them in a WARDEN tab, not your default browser.

---

## Genie

An assistant built into the browser, answering through your own gateway
(`gateway.innotel.us/v1`, OpenAI-compatible). It runs entirely in the main process:
the key is read from `INNOTEL_GATEWAY_KEY` (development) or from the OS keychain when
set in the Genie panel, and it never reaches the renderer, a page, or the package.

It gets three read-only tools over the browser it sits in — `active_page`,
`privacy_stats`, `scry_report` — and is told plainly that it cannot change settings,
run commands, or act on the network. Turns stream over SSE, tool calls appear as chips,
and a 60s watchdog fails the turn rather than leaving the panel on "thinking".

**Status:** the gateway answers `GET /v1/models` (1,398 ids, 1M context, tool calling)
but every `POST /v1/chat/completions` on this key hangs with zero response bytes —
tested with `auto/best-coding`, `auto/fast` and `auto/chat`, streaming and not, for 25s
and 90s. So the panel, streaming, tools and key handling are wired and unit-tested, but
no reply has been generated yet. The panel surfaces that error instead of pretending.

---

## Layout

```
src/
  main/                 Electron main process
    privacy/            Bastion: filter engine, cookie policy, session wiring, hardening
    browser/            WebContentsView tabs, downloads, URL resolution
    media/              Splay dock (native viewer views)
    terminal/           Trench PTY service
    mail/               Relay IMAP/SMTP + HTML sanitizer
    messaging/          Concourse hub
    scry/               CDP client, capture, recon, clone/scaffold writer
    store/              Atomic JSON store
    security/           OS-keychain vault
    ipc.ts              Every typed IPC handler
    internal-pages.ts   warden://newtab, error, viewer
  preload/
    index.ts            window.warden bridge
    page.ts             content preload: hardening, cookie lock, media discovery
  renderer/             React 19 UI
  shared/               Types, defaults, settings validation, URL helpers
tests/                  Unit + remote CDP integration tests
scripts/                smoke.mjs, remote-check.mjs
```

Native surfaces are `WebContentsView`s owned by the main process. The renderer measures the DOM and reports rectangles, so the video dock, terminal drawer, messaging pane and modal suppression all line up exactly with the CSS layout; dock and drawer widths animate by interpolating those bounds.

## Known limits

- **Windows only, x64.** The builder config targets `nsis` + `portable` for win32-x64. macOS/Linux packages would need their own targets and icons.
- **Unsigned binaries.** SmartScreen warns until a certificate is configured. No auto-updater is wired in; distribute new builds deliberately.
- **HLS** (`.m3u8`) is detected and listed but cannot play in Chromium without a media engine; Splay says so rather than showing a black box.
- **Mail** was verified against the protocol layer and a local harness, not against a live provider. IMAP/SMTP verification happens when you add an account, so failures surface there.
- **Messaging** depends on each vendor's web client; a service can break its own pane at any time.
- **REA MCP registration** was applied with your approval to `~/.codex/config.toml`, `~/.copilot/mcp-config.json` and VS Code's `mcp.json` (each with a backup); `rea doctor` reports healthy. REA has no Freebuff client entry, so it is invoked from the shell and WARDEN does not depend on it. Codex's `tool_timeout_sec` is still 450s where REA suggests 720s.
- The filter seed is 208 rules. `sync EasyList + EasyPrivacy` in Policy pulls the full lists on demand.
