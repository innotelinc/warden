import { hostOfUrl } from '@shared/urls'

export type PopupDecision = 'tab' | 'block'

/**
 * Whether a window-open request becomes a WARDEN tab or a blocked popup.
 *
 * Chromium's `disposition` cannot separate a link from a popup: a scripted
 * `window.open()` fired during a click is reported as `foreground-tab`, the
 * same as a `target="_blank"` anchor. yts.gg exploits exactly that — its "Open
 * Full YTS Homepage" link navigates to its own page and simultaneously opens an
 * Opera ad in a second tab.
 *
 * So the rule is about the destination:
 *
 *   - a page may open windows on its own site;
 *   - `background-tab` means middle- or ctrl-click, an explicit gesture, and is
 *     always honoured;
 *   - anything else that points at a third party is a popup.
 *
 * Nothing is made unreachable: "Open link in new tab" in the page context menu
 * calls TabManager.create directly and never passes through this policy.
 */
export function popupDecision(input: {
  url: string
  disposition: string
  pageUrl: string
}): PopupDecision {
  if (!/^https?:/i.test(input.url)) return 'block'
  if (input.disposition === 'background-tab') return 'tab'

  const target = hostOfUrl(input.url)
  const site = hostOfUrl(input.pageUrl)
  if (!target || !site) return 'block'

  return target === site ? 'tab' : 'block'
}
