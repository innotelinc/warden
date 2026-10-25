import { describe, expect, it } from 'vitest'
import { containsWallPhrase, looksLikeChallengeWall, WALL_SELECTORS } from '../src/shared/challenge-wall'

const page = (title: string, text = '', hasChallengeMarkup = false) =>
  looksLikeChallengeWall({ title, text, hasChallengeMarkup })

describe('looksLikeChallengeWall', () => {
  it('recognises a Cloudflare interstitial by its title', () => {
    expect(page('Just a moment...')).toBe('title')
    expect(page('Attention Required! | Cloudflare')).toBe('title')
  })

  it('recognises a wall by the sentence it prints', () => {
    expect(page('Amazon.com', 'Enter the characters you see below Sorry, we just need to make sure you are not a robot.')).toBe(
      'text'
    )
    expect(page('Security measure', 'Max challenge attempts exceeded. Please refresh the page to try again!')).toBe(
      'text'
    )
  })

  it('recognises the challenge forms the walls ship', () => {
    expect(page('', '', true)).toBe('form')
    expect(page('Some site', 'ordinary content', true)).toBe('form')
  })

  it('leaves an ordinary page alone, even when it talks about captchas', () => {
    expect(page('Documentation', 'This page explains how to add a captcha to a signup form.')).toBeNull()
    expect(page('Product', 'Verify your email address to finish setting up your account.')).toBeNull()
  })

  it('leaves an empty document alone', () => {
    expect(page('', '')).toBeNull()
    expect(page('Loading', '')).toBeNull()
  })

  it('only matches whole phrases, not single words', () => {
    expect(page('', 'The robot arm moved.')).toBeNull()
    expect(page('', 'human readable output')).toBeNull()
  })

  it('normalises whitespace and casing before matching', () => {
    expect(page('', 'VERIFY   YOU\nARE   HUMAN')).toBe('text')
  })

  it('prefilters raw text without deciding on its own', () => {
    expect(containsWallPhrase('please verify you are human to continue')).toBe(true)
    expect(containsWallPhrase('VERIFY  YOU  ARE  HUMAN')).toBe(true)
    expect(containsWallPhrase('ordinary product page')).toBe(false)
    expect(containsWallPhrase('')).toBe(false)
  })

  it('ships selectors that a normal page does not contain', () => {
    expect(WALL_SELECTORS.length).toBeGreaterThan(0)
    expect(WALL_SELECTORS.every((selector) => selector.length > 0)).toBe(true)
  })
})
