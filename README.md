<div align="center">

<img src="build/icon.png" width="96" alt="WARDEN shield">

# WARDEN

**Read everything. Give nothing.**

A privacy-first operations browser for security and network administrators: a real Chromium browser
with a cookieless profile, a request-level ad and tracker engine, an embedded shell, a site
deconstructor, native mail and a unified messaging hub — in one dense, keyboard-driven console.

[![Platform: Windows x64](https://img.shields.io/badge/platform-Windows%20x64-18181b)](https://github.com/innotelinc/warden/releases)
[![Electron 45](https://img.shields.io/badge/electron-45-4fe3c1)](package.json)
[![Node 20+](https://img.shields.io/badge/node-20%2B-339933)](package.json)
[![Landing page](https://img.shields.io/badge/landing-innotelinc.github.io%2Fwarden-2ea043)](https://innotelinc.github.io/warden/)
[![No cookie jar](https://img.shields.io/badge/cookies-none%20by%20default-f5b95b)](https://github.com/innotelinc/warden#privacy-model-what-is-actually-enforced)

**Landing page:** [innotelinc.github.io/warden](https://innotelinc.github.io/warden/) ·
**Packaging & deployment:** [below](#packaging-windows) ·
**Known limits:** [below](#known-limits)

</div>

---

## About WARDEN

WARDEN is the browser for the person who has to answer "what is this site doing?" — and then prove it.
It refuses cookies instead of asking, filters at the request level instead of the settings level, and
keeps the operator's tools in the same window as the page: a PTY shell, IMAP/SMTP mail, isolated
messaging panes, a streaming assistant, and **Scry**, which captures a live page over Chrome DevTools
Protocol and hands back a recon report, a static clone with rewritten scripts, a Vite + React scaffold,
or an "innovate" rebuild that replaces the original behaviour rather than copying it.

The privacy guarantee is structural, not a preference: five independent layers in the main process
(request interception, header rewriting, response header stripping, a guarded cookie store, and a
page-level cookie lock), on a browsing session created without the `persist:` partition. Quit the app
and there is no cookie database, no page cache and no session file to recover. Burner tabs get their
own throwaway session, and every messaging service runs in its own isolated one.

Currently at **v0.2.0**: all seven workspaces are functional, the filter engine parses Adblock-Plus
syntax, Scry captures and rebuilds sites, the terminal runs a real PTY, mail speaks IMAP and SMTP, and
the Windows installer plus portable build are produced by `npm run dist`. Verified by unit tests over
the decision surfaces and a smoke suite that drives the real UI and the packaged binary.

**Deliberate limits, stated up front:** no VPN and no IP hiding, no TLS or DNS fingerprint defence, and
no promise that a hostile challenge page can be bypassed — [compatibility mode](#compatibility-mode-per-site)
removes WARDEN's obstacles and says plainly where Cloudflare's begin.

---

## Modules

| Module | What it is |
| --- | --- |
| **Bastion** | The privacy engine: cookies blocked unless a site is explicitly allowed, tracker/ad filtering, HTTPS-only, referrer trimming, GPC/DNT, fingerprint noise, permission lockdown. |
| **Splay** | Video dock. Playing media branches into up to three independent panes on the right so you can keep reading while it plays. |
| **Trench** | Terminal and ssh client. Real PTY (ConPTY on Windows, PTY on Unix) via `node-pty`, with a line-buffered fallback if the native module cannot load. A **SHELL / SSH** toggle switches a session between a local shell and the system `ssh` binary running in the same PTY, so key passphrases, host-key prompts and agent forwarding behave exactly as in a normal terminal. Destinations are validated as a single argv element — `-oProxyCommand=…` cannot be typed in. Custom mint-on-black theme, session tabs. |
| **Relay** | Mail. Native IMAP + SMTP, OS-keychain credentials, HTML sanitized with remote content withheld. |
| **Concourse** | Unified messaging. Slack, Discord, Teams, WhatsApp, Telegram, Element, Google Chat and Mattermost in isolated memory-only panes with unread aggregation. |
| **Scry** | Deconstructor. Capture a live page over Chrome DevTools Protocol, produce a recon report, a standalone static clone, and a Vite + React scaffold. The name is the verb — to look *into* something to reveal what is hidden — not an acronym. |
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

### Compatibility mode (per site)

Some sites will not load through a privacy stack at all: Cloudflare challenge pages, bank portals, SSO. For those, the shield panel has **Reload in compatibility mode**, and Policy carries the same list for hosts an admin wants to seed before anyone visits them.

A compatible host is loaded as if WARDEN were a plain browser:

| Layer | Default | Compatibility |
| --- | --- | --- |
| Ad / tracker filtering | on | off, including third-party scripts |
| HTTPS-only upgrade | on | still on (top-level only, never breaks a page) |
| `Cookie`, `Referer` rewriting, `DNT` / `Sec-GPC`, client-hint removal | on | off — headers go as the page built them |
| `Set-Cookie` stripping and the cookie-store guard | on | off — the site's cookies are kept, and are not purged by *Purge all cookies* |
| Page preload: fingerprint shims and the `document.cookie` lock | on | off — nothing is injected into the page |

Matching is on the host and its subdomains (`neowin.net` covers `www.neowin.net`), stored in `settings.json` alongside the allowlist, and capped at 100 entries. Toggling reloads every tab already on that host, because the preload asks the main process at document start rather than reading a value fixed when the tab was created. Revoking the exemption returns the site to the full stack on the next load; it does not retroactively undo cookies the site already set, so purge them if that matters.

**Honest limit:** compatibility mode removes *WARDEN's* obstacles, not Cloudflare's. A managed challenge that refuses Electron itself still refuses it with every layer off — verified against `neowin.net`, which reaches "Verification successful" and is then handed another 403 with no `cf_clearance` cookie. Blaming the privacy stack for that would be wrong; the browser engine is the variable, and stock Chrome is the only workaround for those specific sites.

---

## Privacy lock

`Ctrl+\` covers WARDEN with an opaque overlay built from a heavily blurred capture of the
page that was on screen, then disables the window underneath. Nothing is readable, nothing is
clickable, and the tabs keep their scroll position. The lock window cannot be dismissed with
Escape, Alt+F4 or a second press of the shortcut.

Unlocking needs the **Windows account password**, not a WARDEN passphrase. The check runs in a
short-lived PowerShell child that P/Invokes `LogonUserW`; the password goes in on stdin and is
never written to argv, the settings file, or a log. Microsoft accounts sign in with the account
email, which the verifier tries alongside `DOMAIN\user`. Anything that is not a successful logon —
including the verifier itself failing — leaves the screen covered.

Policy → **Session lock** sets the idle timeout (`Never`, 1, 5, 15, 30 or 60 minutes). The timer uses
system-wide idle time, so reading a PDF in another app still counts as activity, and the lock also
comes down when the Windows session itself locks (Win+L). The timeout is enforced in the main
process, not by a page script.

**Honest limits:** the overlay depends on the Windows desktop, so a user who can switch to another
application can still see whatever that application shows; this protects WARDEN's content, not the
whole desktop. A blank or disabled Windows password is rejected by `LogonUserW`, which means a
passwordless account cannot unlock — set a password, or leave the timeout at *Never*.

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
npm test              # unit tests over the privacy engine, clone writer, recon, sanitizers
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
| `release/WARDEN-Setup-0.2.0.exe` | Per-user NSIS installer. Not one-click: the operator picks the directory, and it creates Start menu + desktop shortcuts named WARDEN. |
| `release/WARDEN-Portable-0.2.0.exe` | Single executable. Extracts to a temp directory at launch, keeps its own profile, leaves no installed state. |
| `release/win-unpacked/` | Raw app directory, useful for smoke tests and for copying to a lab share. |

The packaged app is verified, not just built: `npm run smoke:dist` runs the same 17 checks as `npm run smoke` (cookies inert, trackers blocked, PTY shell, all six workspaces) against `release/win-unpacked/WARDEN.exe`. Point it at the portable artifact to test that instead:

```bash
WARDEN_SMOKE_BIN=release/WARDEN-Portable-0.2.0.exe npm run smoke:dist
```

Both were run through the suite last build, 32/32. `node-pty` is unpacked from the asar archive (`asarUnpack`) because it loads a native `.node` binary; `npmRebuild` is off because the shipped prebuilds are the ones that were tested against Electron 45.

App metadata is embedded in both executables: `ProductName` WARDEN, `FileDescription` from the package description, version 0.2.0, company WARDEN, and the generated shield icon at 16–256px.

**The builds are unsigned as shipped today.** Windows SmartScreen warns on first run until a certificate backs them. There are two routes, and only one of them is both free and publicly trusted.

### Code signing

**SignPath Foundation — free, publicly trusted.** SignPath signs qualifying open-source projects at no cost with an OV-level certificate, so the installers show `innotelinc` as the publisher and SmartScreen reputation starts accumulating. The catch is that it is an application, not a download: the certificate is only issued after SignPath reviews the project, and every signature is made by their service against an artifact built in your CI, never by a key on a laptop. WARDEN is eligible on paper — [the repository is public](https://github.com/innotelinc/warden) and the build is reproducible from a tag.

What is already in this repo:

| Path | Purpose |
| --- | --- |
| [`.github/workflows/sign-release.yml`](.github/workflows/sign-release.yml) | Builds both installers on `windows-latest`, uploads them as one artifact, submits the signing request, checks the returned signatures are valid *and* timestamped, then attaches them to the release. |
| [`signing/artifact-configuration.xml`](signing/artifact-configuration.xml) | Tells SignPath which files inside the uploaded ZIP to Authenticode-sign. |
| [`scripts/sign-build.ps1`](scripts/sign-build.ps1) | The local fallback described below. |

To switch it on:

1. Apply at [signpath.org](https://signpath.org/) with the repository URL and a short project description. Approval is a review of the project, so a public history of real commits helps.
2. Install the SignPath GitHub App on the repository — it supplies the origin metadata SignPath verifies before signing.
3. In SignPath, create the project and a signing policy for release builds, then paste [`signing/artifact-configuration.xml`](signing/artifact-configuration.xml) as a new artifact configuration and note its slug.
4. Add repository secret `SIGNPATH_API_TOKEN` and repository variables `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`, `SIGNPATH_ARTIFACT_CONFIGURATION_SLUG` (Settings → Secrets and variables → Actions).
5. Push a `v*` tag, or run *Build and sign release* from the Actions tab. The workflow fails loudly if a signature comes back invalid or without a timestamp.

Until that approval lands, the installers stay unsigned and SmartScreen keeps warning. Nothing in the build is blocked on it.

**Self-signed — free, not publicly trusted.** [`scripts/sign-build.ps1`](scripts/sign-build.ps1) creates a code-signing certificate in the current user's store, exports it to `%USERPROFILE%\.warden-signing` (owner-only ACL), and signs everything in `release/` with an RFC 3161 timestamp:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/sign-build.ps1
```

Every file then carries a publisher name, digest and timestamp — visible in file properties and in `Get-AuthenticodeSignature` — but no public CA vouches for it, so other machines still report an untrusted publisher until `warden-codesign.cer` is deployed to Trusted Root + Trusted Publisher. That is a reasonable internal-fleet arrangement (GPO or Intune certificate deployment) and a poor public-distribution one. `-TrustCurrentUser` adds the certificate to this account's stores, which makes it verify locally; Windows asks for confirmation, so it cannot be done silently. Pass `-PfxPath` to sign with a CA-issued certificate instead, or set `CSC_LINK`/`CSC_KEY_PASSWORD` and let electron-builder sign during `npm run dist`.

### Deploying it

Both actions are per-user and need no administrator rights, so they work under a standard account and through most endpoint tooling without an elevation step.

```bash
# Silent install, default path (%LOCALAPPDATA%\Programs\WARDEN)
WARDEN-Setup-0.2.0.exe /S

# Silent install to a chosen directory: /D= must be last, unquoted, no trailing backslash
WARDEN-Setup-0.2.0.exe /S /D=C:\Tools\WARDEN

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

### Updates

Packaged builds update themselves from GitHub releases (`innotelinc/warden`). The feed is baked
into `resources/app-update.yml` by electron-builder from the `publish` block, and the app checks
it 20 seconds after launch and every four hours after that. A newer release downloads in the
background; the status bar shows the percentage, and the restart happens from Policy →
**Updates** (or on the next normal quit, since `autoInstallOnAppQuit` is on). Policy carries the
version, the last check result and a **check now** button, and a switch to turn automatic checks
off without losing the manual one.

Only the NSIS installed build can replace itself. The portable exe reports *portable build —
update by download* and never touches its own file; download the next `WARDEN-Portable` exe from
the releases page.

A release makes the feed work only when the metadata goes up with the installers:

```bash
npm run dist:release            # builds and publishes with GH_TOKEN set
# or, when uploading by hand:
gh release upload v0.2.0 release/WARDEN-Setup-0.2.0.exe \
  release/WARDEN-Portable-0.2.0.exe release/latest.yml \
  release/WARDEN-Setup-0.2.0.exe.blockmap --clobber
```

`latest.yml` and the `.blockmap` files are not optional: without `latest.yml` no client sees an
update, and without the blockmap every update is a full download. Builds are unsigned, so
SmartScreen may warn once per release and `electron-updater` accepts the installer on the
content hash rather than a publisher signature — decide deliberately before pointing a fleet at
`latest`.

**The installed 0.1.0 build has no updater**, so it cannot pick 0.2.0 up on its own: install 0.2.0
once by hand (or through Intune), and every release after that is automatic.

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
| Drag a tab | Reorder the strip; the active page and its state are untouched |
| `Ctrl+Shift+N` | Burner tab |
| `Ctrl+\` | Lock the screen; the Windows password clears it |
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
