/**
 * A page the privacy stack broke.
 *
 * WARDEN already recognises two dead ends: a tab that keeps reloading the same
 * document (challenge-loop.ts) and a document that is a human-verification wall
 * (challenge-wall.ts). Both leave something on screen that says what they are.
 * This is the third shape — the document arrived, the tab is not loading, and
 * almost nothing was drawn.
 *
 * Emptiness alone proves nothing: an offline error page, a slow single-page app
 * and a paywall all look like that. What makes it evidence is the correlation —
 * a blank document on a tab where WARDEN blocked several of the page's own
 * requests. That is the signature of a bundle, a frame or an API call that the
 * filter removed and the site never recovered from.
 *
 * The answer is a verdict about the page, never a decision about the host: the
 * operator is asked before anything is exempted. Pure and time-free so the
 * thresholds can be tested without a browser.
 */

/** The document's own report, measured in the page by the content preload. */
export interface PageHealth {
  /** Characters of visible text the document rendered. */
  textChars: number
  /** Elements inside <body>. A page that drew nothing has a handful. */
  elements: number
}

export interface BreakageInput {
  /** Null until the preload has measured the settled document. */
  health: PageHealth | null
  /** Requests WARDEN blocked in this tab. */
  blocked: number
  /** The host is already exempt — there is nothing left to offer. */
  compatible: boolean
  /** Still loading: an empty document is expected, not a failure. */
  loading: boolean
}

export interface BrokenPage {
  /** Blocked requests the page had to do without. */
  blocked: number
}

/**
 * Thresholds, deliberately at the ends where an ordinary page cannot land.
 *
 * A real page that failed to render keeps its <head>, its script tags and maybe
 * a noscript sentence — tens of elements, a line or two of text. Anything that
 * drew a header, a cookie sheet or a paragraph is already far above these.
 */
export const BLANK_TEXT_CHARS = 200
export const BLANK_ELEMENTS = 40
/** One blocked request is a tracker; several are a page that cannot start. */
export const MIN_BLOCKED_REQUESTS = 3

export function looksBrokenPage(input: BreakageInput): BrokenPage | null {
  if (input.compatible || input.loading) return null
  const health = input.health
  if (!health) return null
  if (!Number.isFinite(health.textChars) || !Number.isFinite(health.elements)) return null
  if (health.textChars < 0 || health.elements < 0) return null
  if (health.textChars > BLANK_TEXT_CHARS) return null
  if (health.elements > BLANK_ELEMENTS) return null
  if (!Number.isFinite(input.blocked) || input.blocked < MIN_BLOCKED_REQUESTS) return null
  return { blocked: input.blocked }
}
