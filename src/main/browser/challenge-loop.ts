/**
 * Challenge-loop detection.
 *
 * A tab that hands the same document back three times in a few seconds — or
 * alternates between two — is not navigating, it is failing. Bot walls, cookie
 * gates and login flows that keep restarting all look like that in the
 * navigation stream, and all of them have the same remedy in WARDEN: per-site
 * compatibility mode. The watcher only recognises the shape and names the host;
 * the operator decides whether to exempt it.
 *
 * Pure and time-injected so the thresholds can be tested without a browser.
 */

export interface NavigationEvent {
  url: string
  at: number
}

export interface NavigationLoop {
  host: string
  /** Main-frame loads of that host inside the window. */
  attempts: number
}

/** How far back a load still counts as part of the same loop. */
export const LOOP_WINDOW_MS = 20_000
/** Same document loaded this many times inside the window. */
export const SAME_URL_ATTEMPTS = 3
/** Two documents handed back and forth this many times inside the window. */
export const ALTERNATING_ATTEMPTS = 4

/**
 * The comparison key for a navigation: the full URL without its fragment.
 *
 * Only http(s) counts. WARDEN's own `warden://` surfaces and `about:blank`
 * reload by design and are never a challenge.
 */
export function loopKey(raw: string): string | null {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function detectChallengeLoop(
  events: readonly NavigationEvent[],
  now: number
): NavigationLoop | null {
  const recent = events.filter((event) => now - event.at <= LOOP_WINDOW_MS && loopKey(event.url) !== null)
  if (recent.length < SAME_URL_ATTEMPTS) return null

  const latest = recent[recent.length - 1]
  if (!latest) return null
  const latestKey = loopKey(latest.url)
  if (!latestKey) return null
  const host = new URL(latestKey).hostname.toLowerCase()

  // Somebody else's loop in the same tab is not this prompt's business: judge
  // the sequence against the host the tab is on now.
  const onHost = recent.filter((event) => {
    const key = loopKey(event.url)
    return key !== null && new URL(key).hostname.toLowerCase() === host
  })
  if (onHost.length < SAME_URL_ATTEMPTS) return null

  const keys = onHost.map((event) => loopKey(event.url))
  const sameDocument = keys.filter((key) => key === latestKey).length
  const documents = new Set(keys)

  const looping =
    sameDocument >= SAME_URL_ATTEMPTS ||
    (onHost.length >= ALTERNATING_ATTEMPTS && documents.size <= 2)
  if (!looping) return null

  return { host, attempts: onHost.length }
}
