import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { captureScript } from '../mobile/src/operator/capture'
import { reportFromCapture } from '../mobile/src/operator/scry'
import { MAIL_PROVIDERS, SERVICES } from '../mobile/src/operator/surfaces'
import { buildReport } from '../src/shared/scry-report'
import { MESSAGING_SERVICES } from '../src/shared/defaults'

/**
 * The operator surfaces — Scry, Services, Mail — are the desktop product's
 * non-browser half, brought to a phone. None of this can be run on a device here,
 * so the checks are the facts that make the difference between a surface that
 * exists and one that is a screenshot of a surface:
 *
 * - both native engines can capture the page (a thin bridge, because the script
 *   and the report are TypeScript),
 * - the capture script is real JavaScript that produces a real capture,
 * - the report is the desktop's own builder, not a second copy of the rules,
 * - the service session is a separate store, so the private browser's wipe cannot
 *   sign a chat app out.
 */

const read = (path: string): string => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')

const ANDROID = 'mobile/plugins/warden-browser/android/src/main/java/us/innotel/warden/browser'
const SWIFT = 'mobile/plugins/warden-browser/ios/Sources/WardenBrowserViewController.swift'
const IOS_PLUGIN = 'mobile/plugins/warden-browser/ios/Sources/WardenBrowserPlugin.swift'

describe('one report, two platforms', () => {
  /**
   * A tracker list or a framework signature that lived twice would be right on
   * one platform and quietly wrong on the other, which is the kind of drift a
   * per-platform test would never catch.
   */
  it('builds the mobile report with the shared builder', () => {
    expect(read('mobile/src/operator/scry.ts')).toContain("from '@shared/scry-report'")
    expect(read('src/main/scry/recon.ts')).toContain("from '../../shared/scry-report'")
    // The desktop pipeline still imports the path it always did.
    expect(read('src/main/scry/scry-service.ts')).toContain("from './recon'")
  })

  it('reads the service list from the same module the desktop does', () => {
    expect(read('mobile/src/operator/surfaces.ts')).toContain("from '@shared/defaults'")
    expect(SERVICES).toEqual(MESSAGING_SERVICES)
    // Desktop's own list, not a subset that drifted.
    expect(SERVICES.map((entry) => entry.id)).toContain('slack')
    expect(SERVICES.length).toBeGreaterThanOrEqual(8)
  })

  it('ships mail providers, since the desktop client has no mobile path yet', () => {
    expect(MAIL_PROVIDERS.length).toBeGreaterThanOrEqual(4)
    for (const provider of MAIL_PROVIDERS) {
      expect(provider.url.startsWith('https://')).toBe(true)
    }
  })
})

describe('the capture script', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * The script is serialised with `Function.prototype.toString` and evaluated in
   * the page, so it cannot reference anything from the module that produced it.
   * Running the produced text here is the only way to know that: a stray helper
   * reference would compile fine and throw a ReferenceError on a phone.
   */
  it('is valid JavaScript that reads a page', () => {
    vi.stubGlobal('location', {
      href: 'https://app.example/dash',
      origin: 'https://app.example',
      hostname: 'app.example',
      protocol: 'https:'
    })
    vi.stubGlobal('document', {
      title: 'Dash',
      documentElement: { outerHTML: '<html><body><div id="__next"></div><script src="/_next/a.js"></script></body></html>' },
      forms: [
        {
          getAttribute: (name: string) => (name === 'action' ? '/login' : name === 'method' ? 'post' : null),
          elements: { length: 3 }
        }
      ],
      cookie: 'sid=abc; theme=dark',
      querySelectorAll: () => [
        {},
        {}
      ]
    })
    vi.stubGlobal('performance', {
      timeOrigin: 1,
      now: () => 12,
      getEntriesByType: () => [
        {
          name: 'https://www.google-analytics.com/collect',
          initiatorType: 'script',
          transferSize: 1200,
          encodedBodySize: 900
        },
        { name: 'https://app.example/_next/a.js', initiatorType: 'script', transferSize: 40, encodedBodySize: 40 }
      ]
    })
    vi.stubGlobal('getComputedStyle', () => ({
      backgroundColor: 'rgb(11, 14, 18)',
      color: 'rgb(220, 230, 242)',
      fontFamily: '"Inter", sans-serif',
      fontSize: '14px',
      borderRadius: '8px',
      boxShadow: 'none',
      padding: '12px'
    }))

    // Native `evaluateJavascript` evaluates an expression and returns its value;
    // a `Function` body needs the `return` spelled out to do the same.
    const text = new Function(`return ${captureScript()}`)() as string
    expect(typeof text).toBe('string')

    const capture = JSON.parse(text)
    expect(capture.finalUrl).toBe('https://app.example/dash')
    expect(capture.headersObserved).toBe(false)
    expect(capture.cookies.map((cookie: { name: string }) => cookie.name)).toEqual(['sid', 'theme'])
    expect(capture.forms[0]).toMatchObject({ action: 'https://app.example/login', method: 'POST', fields: 3 })
    expect(capture.requests.map((request: { host: string }) => request.host)).toContain('www.google-analytics.com')
    expect(capture.requests.find((request: { host: string }) => request.host === 'www.google-analytics.com').thirdParty).toBe(
      true
    )
    expect(capture.tokens.fonts[0].value).toBe('Inter')
  })

  it('reports a page that refuses to be read instead of throwing', () => {
    vi.stubGlobal('location', {
      href: 'https://app.example/',
      origin: 'https://app.example',
      hostname: 'app.example',
      protocol: 'https:'
    })
    vi.stubGlobal('document', {
      title: 'x',
      documentElement: { outerHTML: '<html></html>' },
      forms: [],
      cookie: '',
      querySelectorAll: () => []
    })
    vi.stubGlobal('performance', {
      timeOrigin: 1,
      now: () => 1,
      getEntriesByType: () => {
        throw new Error('no timing here')
      }
    })
    vi.stubGlobal('getComputedStyle', () => {
      throw new Error('no styles here')
    })

    const capture = JSON.parse(new Function(`return ${captureScript()}`)() as string)
    expect(capture.requests).toHaveLength(1)
    expect(capture.resources).toEqual([])
  })
})

describe('a capture becomes a report', () => {
  const capture = {
    finalUrl: 'https://app.example/',
    origin: 'https://app.example',
    title: 'App',
    capturedAt: 1,
    durationMs: 900,
    html: '<html><head><script src="/_next/main.js"></script></head><body><div id="__next"></div></body></html>',
    htmlTruncated: false,
    requests: [
      { url: 'https://app.example/', host: 'app.example', type: 'Document', status: 0, thirdParty: false },
      {
        url: 'https://www.google-analytics.com/collect',
        host: 'www.google-analytics.com',
        type: 'Script',
        status: 0,
        thirdParty: true
      }
    ],
    resources: [{ url: 'https://app.example/_next/main.js', kind: 'script', size: 40 }],
    documentHeaders: {},
    cookies: [],
    mixedContent: [],
    forms: [],
    tokens: {
      colors: [],
      fonts: [],
      fontSizes: [],
      radii: [],
      shadows: [],
      spacing: [],
      breakpoints: []
    },
    headersObserved: false
  }

  const outcome = reportFromCapture(JSON.stringify(capture))

  it('names the stack and the tracker that got through', () => {
    expect(outcome.error).toBe(null)
    expect(outcome.report?.technologies.map((tech) => tech.name)).toContain('Next.js')
    expect(outcome.report?.trackers.map((entry) => entry.host)).toEqual(['www.google-analytics.com'])
  })

  /** The one thing a phone report must not do is imply a header it never saw. */
  it('does not call security headers missing when it could not read them', () => {
    expect(outcome.report?.server.missingSecurityHeaders).toEqual([])
    expect(outcome.report?.notes.join(' ')).toMatch(/Response headers are not visible/i)
  })

  it('states that blocked requests are absent, so the counts read as a floor', () => {
    expect(outcome.report?.notes[0]).toMatch(/blocker refused never appears/i)
  })

  it('says so when the markup was cut', () => {
    const clipped = reportFromCapture(JSON.stringify({ ...capture, htmlTruncated: true }))
    expect(clipped.report?.notes.join(' ')).toMatch(/cut at 120 KB/i)
  })

  it('reports a failed capture as a message, not an empty report', () => {
    expect(reportFromCapture('{"error":"The page could not be read"}').report).toBe(null)
    expect(reportFromCapture('{"error":"The page could not be read"}').error).toBe('The page could not be read')
    expect(reportFromCapture('not json').error).toBeTruthy()
    expect(reportFromCapture('{}').error).toBeTruthy()
  })

  /** The same capture, through the desktop entry point, is the same report. */
  it('produces what the desktop builder produces for the same page', () => {
    const desktop = buildReport(capture as never)
    expect(desktop.technologies.map((tech) => tech.name)).toEqual(outcome.report?.technologies.map((tech) => tech.name))
    expect(desktop.trackers).toEqual(outcome.report?.trackers)
  })
})

describe('the native halves can capture and keep a service signed in', () => {
  it('Android evaluates the shell’s script and unquotes what comes back', () => {
    const activity = read(`${ANDROID}/WardenBrowserActivity.java`)
    const plugin = read(`${ANDROID}/WardenBrowserPlugin.java`)
    expect(activity).toContain('webView.evaluateJavascript(captureScript')
    expect(activity).toContain('WardenBrowserPlugin.deliverCapture(value)')
    expect(plugin).toContain('@PluginMethod')
    expect(plugin).toContain('public void scry(PluginCall call)')
    // evaluateJavascript hands a string result back JSON-quoted; the shell parses
    // plain JSON because the plugin unquotes it exactly once.
    expect(plugin).toContain('private static String unquote(String value)')
    expect(plugin).toContain('call.setKeepAlive(true)')
  })

  it('iOS evaluates the same script and closes the capture surface', () => {
    const surface = read(SWIFT)
    const plugin = read(IOS_PLUGIN)
    expect(surface).toContain('webView.evaluateJavaScript(script)')
    expect(surface).toContain('onCapture')
    expect(plugin).toContain('CAPPluginMethod(name: "scry"')
    /**
     * A property on iOS, a setter on Android. Writing Android's spelling here
     * does not fail any typecheck in this repository — there is no Swift
     * compiler on the machine that writes it — it fails the archive, which is a
     * release. So the two spellings are pinned side by side.
     */
    expect(plugin).toContain('call.keepAlive = true')
    expect(plugin).not.toContain('setKeepAlive')
    expect(read(`${ANDROID}/WardenBrowserPlugin.java`)).toContain('call.setKeepAlive(true)')
  })

  /**
   * A private page wipes cookies and web storage when it closes, which on Android
   * is the whole process's jar. If services shared it, every browser close would
   * sign the operator out of Slack, Teams and WhatsApp.
   */
  it('runs Android services in their own process with their own data directory', () => {
    const manifest = read('mobile/plugins/warden-browser/android/src/main/AndroidManifest.xml')
    expect(manifest).toContain('android:name=".WardenServicesActivity"')
    expect(manifest).toContain('android:process=":services"')
    expect(read(`${ANDROID}/WardenServicesActivity.java`)).toContain('WebView.setDataDirectorySuffix(SUFFIX)')
    // The wipe has to stay in the private session, or a service keeps nothing.
    expect(read(`${ANDROID}/WardenBrowserActivity.java`)).toContain('if (!serviceSession) {')
  })

  it('keeps the iOS stores apart, and says which one a session uses', () => {
    const surface = read(SWIFT)
    expect(surface).toContain('session == .service ? .default() : .nonPersistent()')
    expect(read(IOS_PLUGIN)).toContain('openService')
    expect(read(IOS_PLUGIN)).toContain('removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes()')
  })

  it('wipes the service session on request, from both shells', () => {
    expect(read(`${ANDROID}/WardenServicesActivity.java`)).toContain('EXTRA_CLEAR')
    expect(read(`${ANDROID}/WardenBrowserPlugin.java`)).toContain('public void clearServiceData(PluginCall call)')
    expect(read('mobile/src/warden-browser.ts')).toContain('WardenBrowser.clearServiceData()')
  })
})

describe('the shell hosts the operator surfaces', () => {
  it('puts Scry, Services and Mail beside the browser', () => {
    const app = read('mobile/src/App.tsx')
    for (const label of ['Browser', 'Scry', 'Services', 'Mail']) {
      expect(app).toContain(`label: '${label}'`)
    }
    expect(app).toContain('<ScryPanel')
    expect(app).toContain('<ServicesPanel')
    expect(app).toContain('<MailPanel')
  })

  it('does not pretend mail is the desktop client', () => {
    expect(read('mobile/src/panels/MailPanel.tsx')).toMatch(/not the desktop program/i)
  })
})
