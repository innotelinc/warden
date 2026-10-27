import { registerPlugin } from '@capacitor/core'
import { Browser } from '@capacitor/browser'

/**
 * WARDEN's own browser surface.
 *
 * On iOS this is a `WKWebView` with the app's chrome around it — an editable
 * address field, back, forward, reload — presented by a local Capacitor plugin
 * (`mobile/plugins/warden-browser`). It replaces the system browser view, which
 * was a different app's screen and left WARDEN with no address bar of its own.
 *
 * Nothing here is load-bearing on the platform piece being present: if the plugin
 * is not registered — an older build, or Android, where the surface is the system
 * browser — the page still opens, in the system browser, and the caller is told
 * which of the two happened so the UI can say so.
 */
export interface WardenBrowserPlugin {
  open(options: { url: string }): Promise<void>
  addListener(
    event: 'navigated',
    listener: (data: { url: string; title: string }) => void
  ): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'closed', listener: () => void): Promise<{ remove: () => Promise<void> }>
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
