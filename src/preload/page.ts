/**
 * Content preload. Runs before any page script in every tab.
 *
 *  1. installs fingerprint hardening in the page's main world
 *  2. discovers playable media and reports it for the Splay dock
 *  3. reports the hovered link target for the status bar
 *
 * It never exposes an API to the page.
 */
import { ipcRenderer, webFrame } from 'electron'
import { HARDENING_SCRIPT } from '../main/privacy/hardening'
import { sensorScript, type SensorConfig } from '../main/privacy/sensor-script'
import type { MediaItem, MediaKind } from '../shared/types'

function argValue(name: string): string {
  const prefix = `--${name}=`
  const entry = process.argv.find((value) => value.startsWith(prefix))
  if (!entry) return ''
  return entry.slice(prefix.length)
}

const tabId = argValue('warden-tab')
const cookieMode = argValue('warden-cookies') || 'block'
const allowlist = (() => {
  try {
    return decodeURIComponent(argValue('warden-allow'))
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  } catch {
    return []
  }
})()

const host = (() => {
  try {
    return location.hostname.toLowerCase()
  } catch {
    return ''
  }
})()

/**
 * Compatibility sites get no page-level shims.
 *
 * Asked of the main process synchronously at preload time rather than baked
 * into a tab's argv: the operator can flip a site into compatibility mode and
 * reload, and the answer has to be current for that same reload. A challenge
 * page that reads a patched `navigator` — or that has its `document.cookie`
 * writes swallowed — fails exactly like a site with cookies disabled.
 */
const compatibilitySite = (() => {
  if (!host) return false
  try {
    return ipcRenderer.sendSync('warden:compat:sync', host) === true
  } catch {
    return false
  }
})()

/**
 * The cookie lock is decided by the main process on every document, not by the
 * list passed at tab creation: granting an allowance must take effect on the
 * next reload, and the same reload re-runs this preload with the old argv.
 */
const cookiesAllowed = (() => {
  if (!host) return false
  try {
    const answer = ipcRenderer.sendSync('warden:cookie:sync', host)
    if (typeof answer === 'boolean') return answer
  } catch {
    /* fall through to the arguments baked into the tab */
  }
  return (
    cookieMode === 'first-party' ||
    allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`))
  )
})()

/**
 * Belt and braces: even if a page sets document.cookie in JavaScript, the
 * value never enters the store unless this site is allowed. Server set-cookie
 * headers are already stripped in the main process.
 */
const COOKIE_LOCK = `(() => {
  try {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      get: function () { return '' },
      set: function () {}
    });
  } catch (e) {}
  try { delete Window.prototype.cookieStore } catch (e) {}
  try { Object.defineProperty(window, 'cookieStore', { value: undefined, configurable: true }) } catch (e) {}
})()`

/**
 * Camera and microphone treatment, read from the main process on every
 * document so a Policy change applies to the next reload instead of needing a
 * tab to be recreated. Injected into the main world because patching
 * `navigator.mediaDevices` in an isolated preload world is invisible to pages.
 */
const sensors = (() => {
  try {
    const answer = ipcRenderer.sendSync('warden:sensors:sync')
    if (answer && typeof answer === 'object') return answer as SensorConfig
  } catch {
    /* fall through: sensors stay untouched */
  }
  return null
})()

function installHardening(): void {
  try {
    // Nothing is injected into a compatibility site; the main process has
    // already stopped filtering its traffic and stripping its cookies.
    if (compatibilitySite) return
    if (!cookiesAllowed) void webFrame.executeJavaScript(COOKIE_LOCK, false)
    void webFrame.executeJavaScript(HARDENING_SCRIPT, false)
    if (sensors) {
      const active =
        sensors.cameraBlocked ||
        sensors.microphoneBlocked ||
        sensors.cameraMode !== 'off' ||
        sensors.voiceMode !== 'off'
      if (active) {
        webFrame
          .executeJavaScript(sensorScript(sensors), false)
          .catch((error: Error) => {
            void webFrame.executeJavaScript(
              `window.__wardenSensorError = ${JSON.stringify(error.message || String(error))}`,
              false
            )
          })
      }
    }
  } catch {
    /* the page may be gone already */
  }
}

installHardening()
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installHardening, { once: true })
}

function hash(input: string): string {
  let value = 5381
  for (let index = 0; index < input.length; index += 1) {
    value = ((value << 5) + value + input.charCodeAt(index)) >>> 0
  }
  return value.toString(36)
}

function normaliseEmbed(url: string): { viewer: string; kind: MediaKind } | null {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.replace(/^www\./, '')

    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const id = parsed.pathname.startsWith('/embed/')
        ? parsed.pathname.split('/')[2]
        : parsed.searchParams.get('v')
      if (id) return { viewer: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`, kind: 'embed' }
    }
    if (host === 'youtu.be') {
      const id = parsed.pathname.slice(1)
      if (id) return { viewer: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1`, kind: 'embed' }
    }
    if (host.endsWith('vimeo.com')) {
      const id = parsed.pathname.split('/').filter(Boolean).pop()
      if (id && /^\d+$/.test(id)) return { viewer: `https://player.vimeo.com/video/${id}`, kind: 'embed' }
    }
    if (host.endsWith('dailymotion.com')) {
      const id = parsed.pathname.split('/video/')[1]?.split('_')[0]
      if (id) return { viewer: `https://www.dailymotion.com/embed/video/${id}`, kind: 'embed' }
    }
    if (host.endsWith('twitch.tv')) {
      const channel = parsed.pathname.split('/').filter(Boolean).pop()
      if (channel && parsed.pathname.includes('/videos/')) {
        return { viewer: `https://player.twitch.tv/?video=${channel}&parent=localhost`, kind: 'embed' }
      }
      if (channel) return { viewer: `https://player.twitch.tv/?channel=${channel}&parent=localhost`, kind: 'embed' }
    }
    return null
  } catch {
    return null
  }
}

function titleFor(element: HTMLElement): string {
  const labelled = element.getAttribute('title') || element.getAttribute('aria-label')
  if (labelled) return labelled.trim().slice(0, 120)
  const figure = element.closest('figure')
  const caption = figure?.querySelector('figcaption')?.textContent
  if (caption) return caption.trim().slice(0, 120)
  const heading = element.closest('article')?.querySelector('h1, h2, h3')?.textContent
  if (heading) return heading.trim().slice(0, 120)
  return document.title || 'Media'
}

const elementsByUrl = new Map<string, HTMLMediaElement>()
let lastPayload = ''
let scheduled = 0

function collect(): MediaItem[] {
  const items: MediaItem[] = []
  const pageUrl = location.href

  const mediaElements = Array.from(document.querySelectorAll('video, audio')) as HTMLMediaElement[]
  for (const element of mediaElements) {
    const source =
      element.currentSrc ||
      element.src ||
      (element.querySelector('source')?.getAttribute('src') ?? '')
    if (!source || source.startsWith('blob:') || source.startsWith('data:')) continue

    const absolute = new URL(source, location.href).toString()
    const isAudio = element.tagName === 'AUDIO'
    const hls = /\.m3u8(\?|$)/i.test(absolute)
    const id = `media-${hash(absolute)}`
    elementsByUrl.set(absolute, element)

    items.push({
      id,
      url: absolute,
      kind: hls ? 'hls' : isAudio ? 'audio' : 'video',
      title: titleFor(element),
      poster: element.getAttribute('poster'),
      width: (element as HTMLVideoElement).videoWidth || element.clientWidth || null,
      height: (element as HTMLVideoElement).videoHeight || element.clientHeight || null,
      duration: Number.isFinite(element.duration) ? element.duration : null,
      isLive: !Number.isFinite(element.duration) && element.readyState > 0,
      playable: !hls,
      viewerUrl: absolute,
      currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0,
      playing: !element.paused && !element.ended,
      source: 'direct',
      pageUrl
    })
  }

  const frames = Array.from(document.querySelectorAll('iframe')) as HTMLIFrameElement[]
  for (const frame of frames) {
    const src = frame.getAttribute('src')
    if (!src) continue
    const embed = normaliseEmbed(new URL(src, location.href).toString())
    if (!embed) continue
    const absolute = new URL(src, location.href).toString()
    items.push({
      id: `embed-${hash(embed.viewer)}`,
      url: absolute,
      kind: embed.kind,
      title: titleFor(frame),
      poster: null,
      width: frame.clientWidth || null,
      height: frame.clientHeight || null,
      duration: null,
      isLive: true,
      playable: true,
      viewerUrl: embed.viewer,
      currentTime: 0,
      playing: false,
      source: 'iframe',
      pageUrl
    })
  }

  return items
}

function report(): void {
  if (!tabId) return
  try {
    const items = collect()
    const payload = JSON.stringify(items)
    if (payload === lastPayload) return
    lastPayload = payload
    ipcRenderer.send('warden:media:found', tabId, items)
  } catch {
    /* never let discovery break a page */
  }
}

function scheduleReport(): void {
  if (scheduled) return
  scheduled = window.setTimeout(() => {
    scheduled = 0
    report()
  }, 450)
}

window.addEventListener('load', report, { once: true })
window.addEventListener('play', (event) => {
  if (event.target instanceof HTMLMediaElement) report()
}, true)
window.addEventListener('pause', scheduleReport, true)

document.addEventListener(
  'DOMContentLoaded',
  () => {
    report()
    const observer = new MutationObserver(scheduleReport)
    observer.observe(document.documentElement, { childList: true, subtree: true })
    setInterval(scheduleReport, 8000)
  },
  { once: true }
)

ipcRenderer.on('warden:media:scan', () => report())

ipcRenderer.on('warden:media:claim', (_event, url: string) => {
  const element = elementsByUrl.get(url)
  if (!element) return
  try {
    element.muted = true
    if (!element.paused) element.pause()
  } catch {
    /* element detached */
  }
})

let hovered = ''
document.addEventListener(
  'mouseover',
  (event) => {
    const anchor = (event.target as Element | null)?.closest?.('a')
    const href = anchor?.getAttribute('href')
    const next = href ? (() => {
      try {
        return new URL(href, location.href).toString()
      } catch {
        return ''
      }
    })() : ''
    if (next === hovered) return
    hovered = next
    ipcRenderer.send('warden:hover', tabId, next)
  },
  true
)
