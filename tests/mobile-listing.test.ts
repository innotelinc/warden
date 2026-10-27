import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The store listing is the app's public claim about itself, and Apple checks it
 * against the build. Two kinds of mistake cost a review cycle: metadata over a
 * hard character limit, which App Store Connect rejects at submission time, and
 * a claim the build cannot back up, which is guideline 2.3.
 *
 * The claims checked here are the ones this app got wrong: there is no DNS
 * profile in the mobile build and no filter engine, so it may not say that it
 * encrypts DNS or blocks trackers.
 */

const file = (relative: string): string =>
  fileURLToPath(new URL(`../${relative}`, import.meta.url))

const read = (relative: string): string => readFileSync(file(relative), 'utf8')

interface Listing {
  name: string
  subtitle: string
  promotionalText: string
  keywords: string
  description: string
  reviewNotes: string
  supportUrl: string
  privacyPolicyUrl: string
  ageRating: { expected: string; answers: Record<string, string> }
  copyright: string
}

const listing = JSON.parse(read('mobile/store/ios/listing.json')) as Listing

const shell = [read('mobile/src/App.tsx'), read('mobile/store/ios/listing.json'),
  read('mobile/store/android/listing.json')].join('\n')

describe('iOS store listing', () => {
  /** Apple rejects metadata over these limits, at the last possible moment. */
  it('fits the metadata limits', () => {
    expect(listing.name.length).toBeLessThanOrEqual(30)
    expect(listing.name.length).toBeGreaterThanOrEqual(2)
    expect(listing.subtitle.length).toBeLessThanOrEqual(30)
    expect(listing.promotionalText.length).toBeLessThanOrEqual(170)
    expect(listing.description.length).toBeLessThanOrEqual(4000)
    expect(listing.reviewNotes.length).toBeLessThanOrEqual(4000)
    // Keywords are limited in bytes, not characters.
    expect(Buffer.byteLength(listing.keywords, 'utf8')).toBeLessThanOrEqual(100)
  })

  it('supplies the fields a first submission requires', () => {
    expect(listing.supportUrl).toMatch(/^https:\/\//)
    expect(listing.privacyPolicyUrl).toMatch(/^https:\/\//)
    expect(listing.copyright).toMatch(/\d{4}/)
    expect(listing.keywords.split(',').length).toBeGreaterThan(3)
  })

  /**
   * An address field is unrestricted web access, which Apple defines as 16+
   * under the current tiers. 4+ here would be a false declaration.
   */
  it('rates the app 16+ for unrestricted web access', () => {
    expect(listing.ageRating.expected).toBe('16+')

    const unrestricted = Object.keys(listing.ageRating.answers).find((key) =>
      /unrestricted web access/i.test(key)
    )
    expect(unrestricted).toBeDefined()
    expect(listing.ageRating.answers[unrestricted!]).toMatch(/^Yes/)
  })

  /** Review notes are read by a person deciding whether this is a wrapper. */
  it('tells the reviewer how to test and what the app actually is', () => {
    expect(listing.reviewNotes).toContain('SFSafariViewController')
    expect(listing.reviewNotes).toMatch(/example\.com/)
    expect(listing.reviewNotes).toMatch(/No sign-in/i)
    expect(listing.reviewNotes).toMatch(/unrestricted web access/i)
  })

  it('does not promise app-bound-domain breaks it cannot keep', () => {
    // The listing may describe what ships; the roadmap belongs in a sentence
    // that says it is not here yet.
    expect(listing.description).toMatch(/does not block ads or trackers/i)
  })
})

describe('claims the mobile build cannot back up', () => {
  const forbidden = [
    /encrypted DNS/i,
    /DNS-over-HTTPS/i,
    /DoH is enforced/i,
    /blocks? (ads|trackers|advertisements) (and|&) (trackers|ads)/i,
  ]

  /**
   * There is no DNS profile in the app and no request filtering — Phase 2 of
   * docs/MOBILE.md. Saying otherwise to a reviewer, or to a user on the first
   * screen, is the one kind of marketing this project should not do.
   */
  it('never claims DNS encryption or tracker blocking', () => {
    for (const pattern of forbidden) {
      expect(shell).not.toMatch(pattern)
    }
  })

  /**
   * Quick destinations are seen by everyone who installs the app, a store
   * reviewer included. A team's own paid service is that team's business, not
   * a feature of the product being submitted.
   */
  it('ships no tenant-specific destinations', () => {
    expect(shell).not.toMatch(/nas\.innotel\.us/i)
    expect(shell).not.toMatch(/\bNAS SSO\b/i)
  })

  /** What the posture screen says has to match what the code does. */
  it('keeps the posture screen to things the shell does', () => {
    const posture = read('mobile/src/App.tsx')
    // The shell is its own browser surface now, and it says so; the two claims
    // that were false in an earlier build must not come back in any form.
    expect(posture).toContain('A real address bar')
    expect(posture).toContain('Nothing on disk')
    expect(posture).not.toMatch(/DoH is enforced|Encrypted DNS/i)
    expect(posture).toContain('No telemetry')
    expect(posture).toContain('Sensors')
  })
})
