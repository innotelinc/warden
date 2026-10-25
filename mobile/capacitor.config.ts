import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Bundle identifiers are the ones the store listings are built around; changing
 * them after a release creates a second app, so they live in one place.
 */
const config: CapacitorConfig = {
  appId: 'us.innotel.warden',
  appName: 'WARDEN',
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
    limitsNavigationsToAppBoundDomains: true
  }
}

export default config
