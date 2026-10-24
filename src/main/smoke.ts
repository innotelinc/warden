import { app } from 'electron'
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
