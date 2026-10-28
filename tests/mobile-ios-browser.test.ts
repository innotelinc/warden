import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The iOS shell has to be a browser, not a screen that hands every URL to
 * another app's UI. That depends on four pieces staying wired to each other: the
 * local plugin package, its podspec, the Swift surface, and the shell that opens
 * it. None of the four can be compiled here, so what is checked is the wiring —
 * and the session posture the surface claims.
 */
const read = (path: string): string => readFileSync(path, 'utf8')

const PLUGIN = 'mobile/plugins/warden-browser'
const SWIFT = `${PLUGIN}/ios/Sources/WardenBrowserViewController.swift`
const BRIDGE = `${PLUGIN}/ios/Sources/WardenBrowserPlugin.swift`

describe('the in-app browser package', () => {
  it('declares an iOS source folder so cap sync installs it', () => {
    const manifest = JSON.parse(read(`${PLUGIN}/package.json`)) as {
      capacitor?: { ios?: { src?: string } }
      main?: string
    }
    expect(manifest.capacitor?.ios?.src).toBe('ios')
    // Without a resolvable entry point npm treats this as a bare folder and
    // Capacitor never picks the plugin up.
    expect(manifest.main).toBeTruthy()
    expect(existsSync(`${PLUGIN}/${manifest.main}`)).toBe(true)
  })

  it('ships a podspec whose name the iOS build can resolve', () => {
    // CocoaPods resolves `<Name>.podspec` beside the path the generated Podfile
    // points at — the plugin package root — so it cannot live under `ios/`.
    expect(existsSync(`${PLUGIN}/WardenBrowser.podspec`)).toBe(true)
    const podspec = read(`${PLUGIN}/WardenBrowser.podspec`)
    expect(podspec).toContain("s.name = 'WardenBrowser'")
    expect(podspec).toContain("s.dependency 'Capacitor'")
    expect(podspec).toContain('ios/Sources/**/*.{swift,h,m}')
    expect(podspec).toContain("s.ios.deployment_target = '15.0'")
  })

  it('is listed as a file dependency of the shell', () => {
    const pkg = JSON.parse(read('mobile/package.json')) as { dependencies: Record<string, string> }
    expect(pkg.dependencies['warden-browser']).toBe('file:./plugins/warden-browser')
  })

  it('is installed before the archive, which is what adds the pod', () => {
    const workflow = read('.github/workflows/mobile-ios.yml')
    expect(workflow).toContain('npx cap sync ios')
    expect(workflow).toContain('pod install')
    // `cap sync` regenerates the Podfile from the installed plugin packages, so
    // the pod must not also be hand-written into it or CocoaPods sees it twice.
    expect(read('mobile/ios/App/Podfile')).not.toContain('WardenBrowser')
  })
})

describe('the browser surface', () => {
  it('registers under the name the shell imports', () => {
    const plugin = read(BRIDGE)
    expect(plugin).toContain('@objc(WardenBrowserPlugin)')
    expect(plugin).toContain('public let jsName = "WardenBrowser"')
    expect(plugin).toContain('CAPBridgedPlugin')
    expect(plugin).toContain('CAPPluginMethod(name: "open"')
    expect(plugin).toContain('host.present(browser, animated: true)')
  })

  it('has an address bar, and the controls a browser needs', () => {
    const surface = read(SWIFT)
    expect(surface).toContain('UITextField()')
    expect(surface).toContain('textFieldShouldReturn')
    expect(surface).toContain('canGoBack')
    expect(surface).toContain('canGoForward')
    expect(surface).toContain('stopLoading()')
    expect(surface).toContain('WKWebView')
  })

  it('keeps the session out of the filesystem', () => {
    // The posture screen claims nothing is written to disk, so the data store
    // has to be the in-memory one.
    expect(read(SWIFT)).toContain('websiteDataStore = .nonPersistent()')
  })

  it('resolves a typed address the same way the shell does', () => {
    const surface = read(SWIFT)
    expect(surface).toContain('https://" + value')
    expect(surface).toContain('duckduckgo.com/?q=')
  })

  it('hands an unknown scheme to the system rather than dropping it', () => {
    const surface = read(SWIFT)
    expect(surface).toContain('UIApplication.shared.open(url')
    expect(surface).toContain('decisionHandler(.cancel)')
  })

  it('falls back to the system browser when the plugin is absent', () => {
    const shell = read('mobile/src/App.tsx')
    expect(shell).toContain('openPage')
    const wrapper = read('mobile/src/warden-browser.ts')
    expect(wrapper).toContain("registerPlugin<WardenBrowserPlugin>('WardenBrowser')")
    expect(wrapper).toContain('Browser.open({ url, presentationStyle: \'fullscreen\' })')
  })
})
