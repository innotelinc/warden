import { hostOfUrl } from '@shared/urls'

export type PopupDecision = 'tab' | 'window' | 'block'

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
 *   - anything else that points at a third party is a popup;
 *   - a sized window on the page's own site (`new-window`) is a flow with a job
 *     — OIDC sign-in, a bank portal — and needs a real Window handle.
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
  if (target !== site) return 'block'

  // A sized window on the page's own site is how sign-in and payment flows ask
  // for a popup. Those flows need a live opener and the `window.open` handle to
  // watch the window close — a tab gives them neither, so the page is told the
  // window was blocked and the sign-in dies. It stays the opener's session, so
  // a cloaked tab's popup is isolated with it.
  return input.disposition === 'new-window' ? 'window' : 'tab'
}
