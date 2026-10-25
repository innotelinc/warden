import { describe, expect, it } from 'vitest'
import { newTabHtml } from '../src/main/internal-pages'

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
