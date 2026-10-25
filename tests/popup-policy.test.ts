import { describe, expect, it } from 'vitest'
import { popupDecision } from '../src/main/browser/popup-policy'

const page = 'https://web.yts.gg/'

describe('popup policy', () => {
  it('blocks the ad a click handler opens', () => {
    expect(
      popupDecision({
        url: 'https://net.geo.opera.com/opera/stable/windows?utm_source=adcash',
        disposition: 'foreground-tab',
        pageUrl: page
      })
    ).toBe('block')
  })

  it('allows a page to open a window on its own site', () => {
    expect(popupDecision({ url: 'https://web.yts.gg/home', disposition: 'foreground-tab', pageUrl: page })).toBe('tab')
    expect(popupDecision({ url: 'https://yts.gg/home', disposition: 'foreground-tab', pageUrl: page })).toBe('block')
  })

  /**
   * OIDC sign-in opens a sized window and then waits on the handle: a tab gives
   * the page null, so the page reports "sign-in window was blocked" and the
   * flow never starts. Same site only — a third party asking for a window is
   * still an ad.
   */
  it('gives a sized same-site window a real popup', () => {
    expect(
      popupDecision({ url: 'https://distro.innotel.us/api/auth/oidc/start', disposition: 'new-window', pageUrl: 'https://distro.innotel.us/admin' })
    ).toBe('window')
    expect(
      popupDecision({
        url: 'https://net.geo.opera.com/opera/stable/windows',
        disposition: 'new-window',
        pageUrl: page
      })
    ).toBe('block')
  })

  it('honours a middle or ctrl click wherever it points', () => {
    expect(
      popupDecision({
        url: 'https://www.neowin.net/news/',
        disposition: 'background-tab',
        pageUrl: page
      })
    ).toBe('tab')
  })

  it('refuses anything that is not web content', () => {
    for (const url of ['about:blank', 'javascript:void(0)', 'data:text/html,hi', 'file:///C:/Windows/win.ini']) {
      expect(popupDecision({ url, disposition: 'foreground-tab', pageUrl: page })).toBe('block')
    }
  })

  it('blocks when the opener has no usable site', () => {
    expect(popupDecision({ url: 'https://example.test/', disposition: 'foreground-tab', pageUrl: 'about:blank' })).toBe(
      'block'
    )
  })
})
