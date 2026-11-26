import { registerPlugin } from '@capacitor/core'
import { Browser } from '@capacitor/browser'

/**
 * WARDEN's own browser surface.
 *
 * On both platforms this is the app's own engine with the app's chrome around it
 * — an editable address field, back, forward, reload — presented by a local
 * Capacitor plugin (`mobile/plugins/warden-browser`). It replaced the system
 * browser view, which was a different app's screen and left WARDEN with no
 * address bar of its own.
 *
 * Three calls come out of the same surface:
 *
 * - {@link openPage}: a private session. Closing it wipes what the page left.
 * - {@link openService}: a chat or mail web app. Its own store, kept across
 *   opens, wiped only by {@link clearServiceData}.
 * - {@link scryPage}: load a page, run the capture, close it, hand back the JSON.
 *
 * Nothing here is load-bearing on the platform piece being present: if the plugin
 * is not registered — an older build — a page still opens, in the system browser,
 * and the caller is told which of the two happened so the UI can say so.
 */
/** A per-site switch, as the browser's shield sheet left it. */
export interface SiteRule {
  host: string
  blocking: boolean
  cookies: boolean
}

export interface WardenBrowserPlugin {
  open(options: { url: string }): Promise<void>
  openService(options: { url: string }): Promise<void>
  scry(options: { url: string; script: string }): Promise<{ capture?: string }>
  clearServiceData(): Promise<void>
  /** Close the surface that is up. Absent on Android's plugin. */
  close(): Promise<void>
  /** Absent on a surface that has no per-site policy — Android's, for now. */
  siteRules(): Promise<{ rules?: SiteRule[] }>
  forgetSiteRules(): Promise<void>
  addListener(
    event: 'navigated',
    listener: (data: { url: string; title: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'closed', listener: () => void): Promise<{ remove: () => Promise<void> }>
  /**
   * A `warden://` address the app was opened with, raw. Present on iOS only:
   * the scheme is what the screenshot capture drives the app with, and the
   * shell parses it (`capture-tour.ts`) because that half can be tested.
   */
  addListener(
    event: 'tour',
    listener: (data: { url?: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
}

export const WardenBrowser = registerPlugin<WardenBrowserPlugin>('WardenBrowser')

export type BrowserSurface = 'in-app' | 'system'

export async function openPage(url: string): Promise<BrowserSurface> {
  try {
    await WardenBrowser.open({ url })
    return 'in-app'
  } catch {
    await Browser.open({ url, presentationStyle: 'fullscreen' })
    return 'system'
  }
}

/**
 * A chat or mail service, in the session that survives.
 *
 * The fallback is the system browser, which keeps its own cookies — the login
 * survives there too, just outside WARDEN.
 */
export async function openService(url: string): Promise<BrowserSurface> {
  try {
    await WardenBrowser.openService({ url })
    return 'in-app'
  } catch {
    await Browser.open({ url, presentationStyle: 'fullscreen' })
    return 'system'
  }
}

/** The capture JSON, or a thrown error that the panel can show as it is. */
export async function scryPage(url: string, script: string): Promise<string> {
  const result = await WardenBrowser.scry({ url, script })
  if (!result || typeof result.capture !== 'string') {
    throw new Error('The surface returned no capture.')
  }
  return result.capture
}

/**
 * Close the browser surface, if one is up.
 *
 * `scryPage` reads the surface it finds rather than reloading the address, so a
 * caller that needs the report itself on screen — the screenshot capture does —
 * has to close the page first. False when this build has no such call.
 */
export async function closeSurface(): Promise<boolean> {
  try {
    await WardenBrowser.close()
    return true
  } catch {
    return false
  }
}

export async function clearServiceData(): Promise<boolean> {
  try {
    await WardenBrowser.clearServiceData()
    return true
  } catch {
    return false
  }
}

/**
 * The per-site rules in force, for Policy to state.
 *
 * Empty rather than thrown when the surface has none: an older build, or the
 * Android surface, has no per-site policy to report, and a screen that says
 * "none" is true for both.
 */
export async function siteRules(): Promise<SiteRule[]> {
  try {
    const result = await WardenBrowser.siteRules()
    return Array.isArray(result?.rules) ? result.rules : []
  } catch {
    return []
  }
}

/** Blocking back on and cookies refused for every host the operator exempted. */
export async function forgetSiteRules(): Promise<boolean> {
  try {
    await WardenBrowser.forgetSiteRules()
    return true
  } catch {
    return false
  }
}
