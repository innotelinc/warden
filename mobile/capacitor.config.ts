import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Bundle identifiers are the ones the store listings are built around; changing
 * them after a release creates a second app, so they live in one place.
 */
const config: CapacitorConfig = {
  appId: 'us.innotel.warden',
  // The store name. The identifier is what a release is bound to, so only the
  // display name changes here: Mobile is the same app, named for what it is.
  appName: 'WARDEN Mobile',
  webDir: 'dist',
  // The shell is local. Anything a user opens leaves through the platform's
  // browser surface (Custom Tabs / SFSafariViewController), not an embedded
  // iframe, so a hostile page never shares the app's origin.
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false
  },
  ios: {
    contentInset: 'automatic',
    // Pairs with WKAppBoundDomains in ios/App/App/Info.plist: the bridge WebView
    // may only stay on the shell's own local origin, so no page can be navigated
    // into a context holding the Capacitor bridge. Capacitor requires both halves
    // or the setting does nothing useful.
    limitsNavigationsToAppBoundDomains: true
  }
}

export default config
