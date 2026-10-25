import { app } from 'electron'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WardenContext } from './ipc'

const emit = (payload: unknown): void => {
  process.stdout.write(`WARDEN_SMOKE ${JSON.stringify(payload)}\n`)
}

function waitForLoad(wc: Electron.WebContents, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      setTimeout(resolve, 1200)
    }
    const timer = setTimeout(() => resolve(), timeoutMs)
    if (!wc.isLoading()) return done()
    wc.once('did-stop-loading', done)
  })
}

/**
 * End-to-end verification: renders a local page that tries to track, then
 * checks the cookie store, the fingerprint surface, the filter engine and the
 * Scry capture pipeline against real Chromium behaviour.
 */
export async function runSmoke(ctx: WardenContext, url: string): Promise<void> {
  const result: Record<string, unknown> = { ok: false }
  try {
    const tabId = ctx.tabs.create(url)
    const wc = ctx.tabs.getWebContents(tabId)
    if (!wc) throw new Error('tab has no webContents')

    await waitForLoad(wc)

    result.tabCount = ctx.tabs.list().length
    result.stats = ctx.privacy.snapshot()
    result.cookieCount = (await ctx.privacy.browsingSession.cookies.get({})).length
    result.hardened = await wc.executeJavaScript('Boolean(window.__wardenHardened)', true)
    result.cores = await wc.executeJavaScript('navigator.hardwareConcurrency', true)
    result.plugins = await wc.executeJavaScript('navigator.plugins.length', true)
    result.cookieReadback = await wc.executeJavaScript(
      "(() => { document.cookie = 'probe=1; path=/'; return document.cookie })()",
      true
    )
    result.heading = await wc.executeJavaScript('document.querySelector("h1")?.textContent ?? ""', true)

    const report = await ctx.scry.capture({ source: 'local', id: tabId })
    result.scry = {
      requests: report.requests,
      resources: report.designTokens ? true : false,
      trackers: report.trackers.map((entry) => entry.host),
      technologies: report.technologies.map((entry) => entry.name),
      notes: report.notes,
      tokens: report.designTokens.colors.length
    }

    // Innovate end to end: the rebuilt page must not load the site's own scripts.
    const rebuilt = await ctx.scry.innovate({ source: 'local', id: tabId })
    const modernDir = rebuilt.modernPath ?? ''
    const modernHtml = modernDir ? await fs.readFile(path.join(modernDir, 'index.html'), 'utf8') : ''
    const scriptSources = [...modernHtml.matchAll(/<script[^>]*\ssrc="([^"]+)"/gi)].map((match) => match[1] ?? '')
    result.innovate = {
      modernDir: Boolean(modernDir),
      files: ['index.html', 'theme.css', 'app.js', 'innovations.json'].filter((name) =>
        existsSync(path.join(modernDir, name))
      ),
      scriptSources,
      originalScripts: rebuilt.innovation?.scripts ?? 0,
      droppedScripts: rebuilt.innovation?.droppedScripts ?? 0,
      behaviors: rebuilt.innovation?.behaviors ?? 0,
      rewrittenBehaviors: rebuilt.innovation?.rewrittenBehaviors ?? 0,
      inlineHandlersLeft: /\son[a-z]+\s*=/i.test(modernHtml),
      themeTokens: (modernHtml.match(/theme\.css/) ?? []).length > 0
    }

    // Drive the real renderer: click every rail workspace and read the DOM back.
    result.ui = await ctx.win.webContents.executeJavaScript(
      `(async () => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const out = { errors: window.__wardenUiErrors ?? [] };
        out.brand = document.querySelector('.brand-name')?.textContent ?? '';
        out.railButtons = document.querySelectorAll('.rail-btn').length;
        out.hasToolbar = Boolean(document.querySelector('.toolbar'));
        out.hasStatus = Boolean(document.querySelector('.statusbar'));
        out.addressBar = Boolean(document.querySelector('.address input'));
        out.tabCount = document.querySelectorAll('.tab').length;
        const buttons = Array.from(document.querySelectorAll('.rail-btn'));
        const titles = [];
        for (const button of buttons) {
          button.click();
          await wait(220);
          titles.push((document.querySelector('.ws-head h1')?.textContent ?? '').trim());
        }
        buttons[0]?.click();
        await wait(200);
        out.workspaceTitles = titles;
        out.hasDock = Boolean(document.querySelector('.dock'));

        // Address bar: a single click selects the whole URL instead of parking a caret.
        const addr = document.querySelector('.address input');
        addr.blur();
        addr.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        addr.focus();
        addr.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        await wait(80);
        out.addressSelection = {
          value: addr.value,
          all: addr.value.length > 0 && addr.selectionStart === 0 && addr.selectionEnd === addr.value.length
        };

        // Find bar: same button opens it and collapses it.
        const findBtn = document.querySelector('.toolbar button[title^="Find in page"]');
        findBtn.click();
        await wait(260);
        const bar = document.querySelector('.findbar');
        out.findBar = {
          present: Boolean(bar),
          radius: bar ? getComputedStyle(bar).borderTopLeftRadius : null,
          bottom: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
          stripLimit: bar ? Math.round(bar.closest('.content').getBoundingClientRect().top) + 48 : null
        };
        findBtn.click();
        await wait(260);
        out.findClosed = !document.querySelector('.findbar');

        // Bastion has to expose the compatibility escape hatch for this site.
        document.querySelector('.shield-pill')?.click();
        await wait(320);
        out.bastionButtons = Array.from(document.querySelectorAll('.dock .btn')).map((el) =>
          (el.textContent ?? '').trim()
        );
        document.querySelector('.dock .chip')?.click();
        await wait(200);

        // The toolbar button must carry the current tab into Scry by itself.
        buttons[0]?.click();
        await wait(200);
        const send = document.querySelector('.toolbar .scry-send');
        out.sendButton = Boolean(send);
        send?.click();
        await wait(420);
        out.sendToScry = {
          workspace: (document.querySelector('.ws-head h1')?.textContent ?? '').trim(),
          modesArmed: Array.from(document.querySelectorAll('.scry-mode')).every((el) => !el.disabled),
          target: (document.querySelector('.scry-target.active b')?.textContent ?? '').trim()
        };

        // Scry: one button per mode, and the tab handed to it is already selected.
        buttons[4]?.click();
        await wait(260);
        out.scryModes = Array.from(document.querySelectorAll('.scry-mode')).map((el) => ({
          name: el.querySelector('b')?.textContent ?? '',
          disabled: el.disabled
        }));

        // Policy: switching palette rewrites the live tokens.
        buttons[buttons.length - 1]?.click();
        await wait(260);
        const cards = Array.from(document.querySelectorAll('.theme-card'));
        out.themeCards = cards.length;
        const before = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim();
        cards[1]?.click();
        await wait(320);
        const after = getComputedStyle(document.documentElement).getPropertyValue('--mint').trim();
        out.theme = { name: cards[1]?.querySelector('b')?.textContent ?? '', before, after, changed: before !== after };
        cards[0]?.click();
        await wait(260);
        buttons[0]?.click();
        await wait(200);
        return out;
      })()`,
      true
    )

    const term = ctx.terminal.create('')
    await new Promise((resolve) => setTimeout(resolve, 900))

    ctx.setDrawer(true)
    await new Promise((resolve) => setTimeout(resolve, 900))
    result.ui = {
      ...(result.ui as Record<string, unknown>),
      ...(await ctx.win.webContents.executeJavaScript(
        `({
          drawerHeight: Math.round(document.querySelector('.drawer-shell')?.getBoundingClientRect().height ?? 0),
          terminalHeight: Math.round(document.querySelector('.xterm')?.getBoundingClientRect().height ?? 0),
          drawerHead: document.querySelector('.term-head')?.textContent?.includes('TRENCH') ?? false
        })`,
        true
      ))
    }
    ctx.setDrawer(false)
    result.terminal = {
      backend: term.backend,
      shell: term.shell,
      alive: ctx.terminal.list().some((entry) => entry.id === term.id)
    }
    result.terminalScrollback = ctx.terminal.scrollback(term.id).length
    ctx.terminal.kill(term.id)

    // The tab surface must actually be on screen, not just addressable by IPC.
    result.view = ctx.tabs.viewState(tabId)

    // Compatibility mode: the same page with its host exempted has to behave
    // like a plain browser — no injected shims, cookies written and kept, and
    // its tracker requests left alone.
    const compatHost = new URL(url).hostname
    const originalSettings = ctx.privacy.getSettings()
    ctx.privacy.applySettings({ ...originalSettings, compatibility: [compatHost] })
    const compatTab = ctx.tabs.create(url)
    const compatWc = ctx.tabs.getWebContents(compatTab)
    if (compatWc) {
      await waitForLoad(compatWc)
      const blockedAtStart = ctx.privacy.snapshot().blockedTotal
      await compatWc.executeJavaScript(
        `(() => {
          const probe = new Image();
          probe.src = 'https://www.google-analytics.com/collect?v=compat&t=' + Date.now();
          document.body.appendChild(probe);
          return true;
        })()`,
        true
      )
      await new Promise((resolve) => setTimeout(resolve, 1600))
      result.compat = {
        site: compatHost,
        hardened: await compatWc.executeJavaScript('Boolean(window.__wardenHardened)', true),
        cores: await compatWc.executeJavaScript('navigator.hardwareConcurrency', true),
        cookie: await compatWc.executeJavaScript(
          "(() => { document.cookie = 'compat_probe=1; path=/'; return document.cookie })()",
          true
        ),
        stored: (await ctx.privacy.browsingSession.cookies.get({ domain: compatHost })).length,
        trackerBlocked: ctx.privacy.snapshot().blockedTotal - blockedAtStart
      }
    }
    ctx.tabs.close(compatTab)
    ctx.privacy.applySettings(originalSettings)

    const purged = await ctx.privacy.wipeCookies()
    result.purged = purged
    result.cookieCountAfter = (await ctx.privacy.browsingSession.cookies.get({})).length

    result.ok =
      Boolean(result.hardened) &&
      Number(result.cores) === 4 &&
      Number(result.plugins) === 0 &&
      result.cookieReadback === '' &&
      Number(result.cookieCount) === 0 &&
      Number(result.cookieCountAfter) === 0 &&
      String(result.heading).includes('smoke') &&
      Number((result.compat as { trackerBlocked?: number } | undefined)?.trackerBlocked) === 0 &&
      report.requests > 0
  } catch (error) {
    result.error = (error as Error).stack ?? (error as Error).message
  } finally {
    emit(result)
    // A packaged Windows GUI binary has no attached console, so also drop the
    // report where the harness can read it.
    const outFile = process.env.WARDEN_SMOKE_OUT
    if (outFile) {
      try {
        const fs = require('node:fs') as typeof import('node:fs')
        fs.writeFileSync(outFile, JSON.stringify(result), 'utf8')
      } catch {
        /* the harness reads stdout instead */
      }
    }
    setTimeout(() => app.exit(result.ok ? 0 : 1), 400)
  }
}
