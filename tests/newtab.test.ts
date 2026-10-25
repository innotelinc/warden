import { describe, expect, it } from 'vitest'
import { lockPageHtml, newTabHtml } from '../src/main/internal-pages'

const html = newTabHtml({
  stats: {
    requestsSeen: 120,
    blockedTotal: 7,
    cookiesStripped: 3,
    trackersBlocked: 5,
    httpsUpgrades: 1,
    sessionStartedAt: 0,
    topHosts: [{ host: 'ads.example', count: 4 }],
    rulesLoaded: 208,
    filterLists: []
  },
  facts: ['DNS over HTTPS · Quad9', 'Private tab by default'],
  bookmarks: [{ url: 'https://example.com', title: 'Example' }],
  version: '0.2.1',
  homepage: 'warden://newtab'
})

describe('new tab splash', () => {
  it('opens with the splash and the mark', () => {
    expect(html).toContain('Welcome to WARDEN')
    expect(html).toContain('class="mark"')
    expect(html).toContain('class="w"')
    expect(html).toContain('svg class="shield"')
    expect(html).toContain('Read everything. Give nothing.')
  })

  it('renders one chip per privacy fact', () => {
    expect(html.match(/class="chip"/g)?.length).toBe(2)
    expect(html).toContain('DNS over HTTPS')
  })

  it('keeps the session panel and escapes injected text', () => {
    expect(html).toContain('ads.example')
    const escaped = newTabHtml({
      stats: {
        requestsSeen: 0,
        blockedTotal: 0,
        cookiesStripped: 0,
        trackersBlocked: 0,
        httpsUpgrades: 0,
        sessionStartedAt: 0,
        topHosts: [],
        rulesLoaded: 0,
        filterLists: []
      },
      facts: ['<script>alert(1)</script>'],
      bookmarks: [],
      version: '0.2.1',
      homepage: 'warden://newtab'
    })
    expect(escaped).not.toContain('<script>alert(1)</script>')
  })
})

describe('lock screen', () => {
  const lock = lockPageHtml()

  /**
   * The PIN is the credential people actually sign in with, and it can only be
   * verified by Windows Hello. A lock screen that offers nothing but a password
   * box rejects the one thing the operator knows.
   */
  it('offers Windows Hello first and the password second', () => {
    expect(lock).toContain('id="hello"')
    expect(lock).toContain('Unlock with Windows Hello')
    expect(lock).toContain('api.lock.hello()')
    expect(lock.indexOf('id="hello"')).toBeLessThan(lock.indexOf('id="form"'))
    expect(lock).toContain('PIN, fingerprint or face')
  })

  /**
   * The overlay asks the verifier as it opens, so a missing Hello enrolment is
   * reported while the operator can still read it — not after a dead button.
   */
  it('checks Hello availability on the way in', () => {
    expect(lock).toContain('api.lock.helloStatus()')
    expect(lock).toContain('id="helloNote"')
  })

  it('keeps the Hello button live when the verifier is silent but Hello is enrolled', () => {
    expect(lock).toContain("report.hello === 'enrolled'")
  })

  it('leaves the password field masked and empty in the markup', () => {
    expect(lock).toContain('type="password"')
    expect(lock).not.toMatch(/value="/)
  })

  it('cannot be dismissed with a key', () => {
    expect(lock).toContain("event.key === 'Escape'")
    expect(lock).toContain('event.preventDefault()')
  })

  /**
   * A local Windows account with no Hello enrolment and no password to type had
   * nothing on this screen that could verify it. The WARDEN PIN is that way in —
   * set in Policy, hashed in the main process, checked without Windows.
   */
  it('offers the WARDEN PIN and the Windows account as two ways in', () => {
    expect(lock).toContain('id="pin"')
    expect(lock).toContain('inputmode="numeric"')
    expect(lock).toContain('api.lock.unlockWithPin(pinInput.value)')
    expect(lock).toContain('id="switchMode"')
    expect(lock).toContain('Use the Windows account instead')
  })

  it('opens on whichever credential this machine actually has', () => {
    expect(lock).toContain("var mode = 'windows'")
    expect(lock).toContain("mode = pinSet ? 'pin' : 'windows'")
    expect(lock).toContain("windowsBlock.hidden = mode !== 'windows'")
  })

  /** A hidden input cannot take focus, so the visible one is chosen at runtime. */
  it('never autofocuses a field that may not be on screen', () => {
    expect(lock).not.toContain('autofocus')
    expect(lock).toContain('function activeInput()')
  })

  /**
   * The screen is one inline script, so a single bad escape inside the
   * TypeScript template leaves the page rendered but inert: the markup looks
   * right, and not one button works. The smoke harness drives the service
   * directly and cannot see that, so the shipped script is parsed here.
   */
  it('ships an inline script that actually parses', () => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(lock)?.[1] ?? ''
    expect(script.length).toBeGreaterThan(1000)
    expect(() => new Function(script)).not.toThrow()
  })
})
