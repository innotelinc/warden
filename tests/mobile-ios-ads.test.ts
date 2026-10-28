import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AD_HOSTS, BUILTIN_TRACKER_HOSTS } from '../src/main/privacy/builtin-lists'

/**
 * The iOS shell runs a `WKWebView`, which has no request hook, so its blocking
 * lives in a content rule list built in Swift. Nothing here can compile Swift,
 * so what is checked is the promise the file makes: it blocks the lists the
 * desktop blocks, it removes the space an ad leaves, and the first page waits
 * for the rules instead of loading unfiltered.
 */
const BLOCKER = 'mobile/plugins/warden-browser/ios/Sources/WardenAdBlocker.swift'
const CONTROLLER = 'mobile/plugins/warden-browser/ios/Sources/WardenBrowserViewController.swift'

const read = (path: string): string => readFileSync(path, 'utf8')

describe('the iOS ad blocker', () => {
  it('blocks every host the desktop build blocks', () => {
    const swift = read(BLOCKER)
    const missing = [...BUILTIN_AD_HOSTS, ...BUILTIN_TRACKER_HOSTS].filter(
      (entry) => !swift.includes(`"${entry}"`)
    )
    expect(missing).toEqual([])
  })

  it('blocks Yahoo’s own ad hosts, which a front page loads first', () => {
    const swift = read(BLOCKER)
    expect(swift).toContain('"ads.yahoo.com"')
    expect(swift).toContain('"adserver.yahoo.com"')
    expect(swift).toContain('"gemini.yahoo.com"')
  })

  it('builds a rule list that blocks, hides containers, and keeps the page itself', () => {
    const swift = read(BLOCKER)
    expect(swift).toContain('"type": "block"')
    expect(swift).toContain('"type": "css-display-none"')
    expect(swift).toContain('"if-domain"')
    // A rule for the whole URL space with no selector would hide the document.
    expect(swift).toContain('"selector": cosmeticSelectors.joined')
    // The slot names that matter on the pages the operator reported.
    expect(swift).toContain('".adsbygoogle"')
    expect(swift).toContain('[id^=\\"google_ads\\"]')
    expect(swift).toContain('iframe[src*=\\"doubleclick.net\\"]')
  })

  it('collapses the wrapper a blocked ad leaves behind', () => {
    const swift = read(BLOCKER)
    // Hiding the ad alone keeps its reserved height, which is the hole the
    // operator sees; the wrapper has to go too.
    expect(swift).toContain('function collapse(')
    expect(swift).toContain('(parent.textContent || "").trim()')
    // And the page keeps building slots after load.
    expect(swift).toContain('new MutationObserver(schedule)')
  })

  it('installs the rules before the first page is requested', () => {
    const controller = read(CONTROLLER)
    expect(controller).toContain('WardenAdBlocker.install(on: configuration.userContentController)')
    const installAt = controller.indexOf('WardenAdBlocker.install(on:')
    const loadAt = controller.indexOf('strongSelf.load(strongSelf.startURL)')
    expect(installAt).toBeGreaterThan(-1)
    expect(loadAt).toBeGreaterThan(installAt)
    // The unconditional load that used to sit at the end of viewDidLoad would
    // race the compile and win.
    expect(controller).not.toContain('\n        load(startURL)\n')
  })
})
