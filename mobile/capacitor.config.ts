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
    // The shell paints its own safe-area padding from env(safe-area-inset-*)
    // (styles.css), and index.html sets viewport-fit=cover. Letting the web view
    // add its own insets as well leaves the strip below the content showing the
    // scroll view's default white — the band under WARDEN's footer in the first
    // capture runs, exactly 34pt on a home-indicator phone, absent on an iPad.
    contentInset: 'never'
    // Deliberately no `limitsNavigationsToAppBoundDomains`. That switch only does
    // anything alongside WKAppBoundDomains in the app's Info.plist, and declaring
    // that key puts *every* web view in the app into WebKit's app-bound mode,
    // which denies JavaScript injection, user scripts and message handlers on any
    // page that is not listed in it. A browser loads arbitrary pages and this
    // app's policy is injected script — the fingerprint shim, the cookie lock,
    // the cosmetic pass, Scry's capture — so it cannot be app-bound. The bridge
    // stays on the shell's own origin because the shell never navigates it: a
    // page opens in the native surface, never in the bridge. See docs/MOBILE.md.
  }
}

export default config
