/**
 * The two addresses the App Store screenshot capture opens.
 *
 * The shots have to be of the running app, and a simulator cannot tap: so the
 * shell answers `warden://browse?url=…` and `warden://scry?url=…`, and
 * `simctl openurl` sends them. Each one does exactly what the same action does
 * by hand — open the address, or read the page and show its report — which is
 * what makes the resulting screenshots screenshots of the product rather than
 * of a screen built for the occasion.
 *
 * The parse is here, and not in Swift, for the same reason the capture script
 * is TypeScript: this half can be tested without a Mac.
 */
export interface TourStep {
  screen: 'browse' | 'scry'
  /** A `http` or `https` address, never anything else. */
  url: string
}

const SCREENS = new Set<TourStep['screen']>(['browse', 'scry'])

export function parseTourStep(raw: string | null | undefined): TourStep | null {
  if (!raw) return null

  let link: URL
  try {
    link = new URL(raw)
  } catch {
    return null
  }
  if (link.protocol !== 'warden:') return null

  // `warden://browse?url=…` puts the screen in the host, not the path: a
  // custom scheme has no authority rule of its own, so `hostname` is what was
  // typed after the slashes.
  const screen = link.hostname.toLowerCase()
  if (!SCREENS.has(screen as TourStep['screen'])) return null

  const target = link.searchParams.get('url') ?? ''
  let page: URL
  try {
    page = new URL(target)
  } catch {
    return null
  }
  // A tour may open a page; it may not open a file, a javascript: or another
  // app's scheme. Those are the same three the address bar refuses.
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return null

  return { screen: screen as TourStep['screen'], url: page.toString() }
}
