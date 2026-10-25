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
