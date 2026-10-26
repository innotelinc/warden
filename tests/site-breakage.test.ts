import { describe, expect, it } from 'vitest'
import {
  BLANK_ELEMENTS,
  BLANK_TEXT_CHARS,
  MIN_BLOCKED_REQUESTS,
  looksBrokenPage,
  type BreakageInput
} from '@shared/site-breakage'

/**
 * The blank-page detector decides when WARDEN asks the operator whether its own
 * filtering broke a site. Both kinds of mistake are expensive: a miss leaves a
 * blank tab with no explanation, and a false positive nags on a page that is
 * merely slow or sparse. So the boundaries are what these tests pin down.
 */
describe('looksBrokenPage', () => {
  /** A document that kept its head and script tags and drew nothing. */
  const blank = { textChars: 0, elements: 6 }
  const input = (patch: Partial<BreakageInput>): BreakageInput => ({
    health: blank,
    blocked: 5,
    compatible: false,
    loading: false,
    ...patch
  })

  it('names an empty document on a tab that had requests blocked', () => {
    expect(looksBrokenPage(input({}))).toEqual({ blocked: 5 })
  })

  it('keeps the blocked count so the prompt can state it', () => {
    expect(looksBrokenPage(input({ blocked: 42 }))?.blocked).toBe(42)
  })

  it('stays quiet while the page is still loading', () => {
    expect(looksBrokenPage(input({ loading: true }))).toBeNull()
  })

  it('stays quiet when nothing was blocked: a blank page under the full stack is not this app doing', () => {
    expect(looksBrokenPage(input({ blocked: MIN_BLOCKED_REQUESTS - 1 }))).toBeNull()
    expect(looksBrokenPage(input({ blocked: 0 }))).toBeNull()
  })

  it('stays quiet for a host that is already exempt', () => {
    expect(looksBrokenPage(input({ compatible: true }))).toBeNull()
  })

  it('stays quiet for a page that drew something', () => {
    expect(looksBrokenPage(input({ health: { textChars: 4000, elements: 600 } }))).toBeNull()
  })

  it('accepts a document sitting exactly on both limits', () => {
    expect(
      looksBrokenPage(
        input({ health: { textChars: BLANK_TEXT_CHARS, elements: BLANK_ELEMENTS }, blocked: 3 })
      )
    ).toEqual({ blocked: 3 })
  })

  it('rejects a long single block of text even with few elements', () => {
    // A <pre>-only page: three elements, thousands of characters. It drew.
    expect(looksBrokenPage(input({ health: { textChars: BLANK_TEXT_CHARS + 1, elements: 3 } }))).toBeNull()
  })

  it('rejects a sparse but real layout', () => {
    expect(
      looksBrokenPage(input({ health: { textChars: 0, elements: BLANK_ELEMENTS + 1 } }))
    ).toBeNull()
  })

  it('ignores a measurement it does not have', () => {
    expect(looksBrokenPage(input({ health: null }))).toBeNull()
    expect(looksBrokenPage(input({ health: { textChars: Number.NaN, elements: 4 } }))).toBeNull()
    expect(looksBrokenPage(input({ health: { textChars: 10, elements: Number.NaN } }))).toBeNull()
    expect(looksBrokenPage(input({ health: { textChars: -1, elements: 4 } }))).toBeNull()
  })

  it('ignores an impossible blocked count', () => {
    expect(looksBrokenPage(input({ blocked: Number.NaN }))).toBeNull()
  })
})
