import { describe, expect, it } from 'vitest'
import { WALKTHROUGH_STEPS, walkthroughDue } from '../src/shared/walkthrough'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { sanitizeSettings } from '../src/shared/settings'

describe('walkthrough gate', () => {
  it('is due until it has been seen', () => {
    expect(walkthroughDue(undefined)).toBe(true)
    expect(walkthroughDue(false)).toBe(true)
    expect(walkthroughDue(true)).toBe(false)
  })

  it('is due on a fresh profile and quiet once recorded', () => {
    expect(walkthroughDue(DEFAULT_SETTINGS.walkthroughSeen)).toBe(true)
    expect(sanitizeSettings({ walkthroughSeen: true }).walkthroughSeen).toBe(true)
    expect(sanitizeSettings({}).walkthroughSeen).toBe(false)
  })
})

describe('walkthrough steps', () => {
  it('has a real step for every feature it claims to introduce', () => {
    expect(WALKTHROUGH_STEPS.length).toBeGreaterThanOrEqual(6)
    const ids = new Set(WALKTHROUGH_STEPS.map((step) => step.id))
    expect(ids.size).toBe(WALKTHROUGH_STEPS.length)
    for (const step of WALKTHROUGH_STEPS) {
      expect(step.title.trim().length).toBeGreaterThan(0)
      expect(step.body.trim().length).toBeGreaterThan(40)
    }
  })

  it('points at the switches, the cape, the workspaces and the assistant', () => {
    const text = WALKTHROUGH_STEPS.map((step) => `${step.title} ${step.body} ${step.where ?? ''}`).join(' ').toLowerCase()
    expect(text).toContain('cloak')
    expect(text).toContain('genie')
    expect(text).toContain('scry')
    expect(text).toContain('privacy')
    expect(text).toContain('cookies')
  })

  it('never claims the product is something it is not', () => {
    const text = WALKTHROUGH_STEPS.map((step) => step.body).join(' ').toLowerCase()
    expect(text).not.toContain('vpn')
    expect(text).not.toContain('unlimited')
  })
})
