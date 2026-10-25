/**
 * Human-verification wall detection.
 *
 * A page can be a dead end without looping: one load of a captcha or a
 * "checking your browser" interstitial is enough, and nothing on it explains
 * that WARDEN's own hardening is what the wall is reacting to. The probe below
 * is deliberately narrow — a handful of titles, a few distinctive sentences and
 * the forms the large walls ship — because a false positive nags on an ordinary
 * page. Its answer is a reason key, never a decision: the operator still clicks.
 *
 * Pure and shared by the content preload and the tests.
 */

export interface WallProbe {
  title: string
  /** Visible document text, truncated by the caller before it gets here. */
  text: string
  /** True when one of the challenge forms below is in the document. */
  hasChallengeMarkup: boolean
}

export type WallReason = 'form' | 'title' | 'text'

/** Selectors that only a challenge interstitial ships. */
export const WALL_SELECTORS = [
  '#challenge-form',
  '#cf-challenge-running',
  '#px-captcha',
  '#captchacharacters',
  'form[action*="validateCaptcha" i]',
  'iframe[src*="captcha-delivery.com"]'
]

export const WALL_TITLES = [
  'just a moment',
  'attention required',
  'security check',
  'checking your browser',
  'human verification',
  'are you a robot',
  'verify you are human',
  'unusual traffic',
  'pardon our interruption',
  'sorry, you have been blocked'
]

/**
 * Sentences the walls print, in the wording they actually use. Kept to whole
 * distinctive phrases: `captcha` on its own appears in ordinary documentation
 * and login forms, and matching it would prompt on pages that are working.
 */
export const WALL_PHRASES: readonly string[] = [
  'verify you are human',
  'verify you are a human',
  'confirm you are human',
  'are you a robot',
  'checking your browser before accessing',
  'checking if the site connection is secure',
  'enable javascript and cookies to continue',
  'complete the security check',
  'press and hold to confirm you are a human',
  'unusual traffic from your computer',
  'our systems have detected unusual traffic',
  'please stand by, while we are checking your browser',
  'needs to review the security of your connection',
  'pardon our interruption',
  'max challenge attempts exceeded',
  'complete the captcha',
  'enter the characters you see below'
]

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ')
}

/**
 * Cheap prefilter: is any wall phrase in this text at all?
 *
 * `textContent` does not force a layout, so a busy single-page app pays for one
 * string scan before anything expensive runs. Hidden or script text can make
 * this answer true; the caller confirms against visible text.
 */
export function containsWallPhrase(text: string): boolean {
  if (!text) return false
  const haystack = normalize(text)
  return WALL_PHRASES.some((entry) => haystack.includes(entry))
}

export function looksLikeChallengeWall(probe: WallProbe): WallReason | null {
  if (probe.hasChallengeMarkup) return 'form'

  const title = normalize(probe.title)
  if (title && WALL_TITLES.some((entry) => title.includes(entry))) return 'title'

  const text = normalize(probe.text)
  if (!text) return null
  if (WALL_PHRASES.some((entry) => text.includes(entry))) return 'text'
  return null
}
