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
import { containsWallPhrase, looksLikeChallengeWall, WALL_SELECTORS } from '../shared/challenge-wall'
import { cosmeticCss, cosmeticSelectorsFor } from '../shared/cosmetic'
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

/**
 * Cosmetic filtering: hide the slot a blocked ad left behind.
 *
 * Blocking a request stops the ad loading but leaves its container holding the
 * space open, which reads as a broken page rather than a clean one. The
 * stylesheet below matches containers rather than requests, so it applies to
 * what is already in the document and to whatever the page adds later; the
 * sweep then collapses a wrapper whose only child was the ad.
 *
 * Asked of the main process on every document, like the sensor treatment, so a
 * Policy change applies to the next reload.
 */
const cosmeticOn = (() => {
  try {
    return ipcRenderer.sendSync('warden:cosmetic:sync') === true
  } catch {
    return false
  }
})()

/** Structure, never an ad slot: collapsing one of these breaks a layout. */
const COSMETIC_KEEP = new Set([
  'BODY',
  'HTML',
  'MAIN',
  'ARTICLE',
  'SECTION',
  'NAV',
  'HEADER',
  'FOOTER',
  'UL',
  'OL',
  'FORM',
  'TABLE'
])
const COSMETIC_SWEEP_MS = 400
/** Bounded so a page that matches everything cannot cost a layout pass per node. */
const COSMETIC_NODE_LIMIT = 600

let cosmeticTimer = 0
let cosmeticSweeping = false

function cosmeticMatches(): Element[] {
  if (!document.body) return []
  try {
    const found = document.body.querySelectorAll(cosmeticSelectorsFor(host).join(','))
    return Array.from(found).slice(0, COSMETIC_NODE_LIMIT)
  } catch {
    return []
  }
}

function cosmeticVisible(element: Element): boolean {
  const box = element as HTMLElement
  if (box.offsetHeight > 12) return true
  return false
}

function collapseAround(node: Element): void {
  let current = node.parentElement
  for (let depth = 0; depth < 3 && current && current !== document.body; depth += 1) {
    if (COSMETIC_KEEP.has(current.tagName)) break
    if ((current.textContent || '').trim()) break
    if (Array.from(current.children).some((child) => cosmeticVisible(child))) break
    current.style.setProperty('display', 'none', 'important')
    current = current.parentElement
  }
}

function sweepCosmetic(): void {
  if (cosmeticSweeping) return
  cosmeticSweeping = true
  try {
    for (const node of cosmeticMatches()) collapseAround(node)
  } finally {
    cosmeticSweeping = false
  }
}

function scheduleCosmeticSweep(): void {
  if (cosmeticTimer) return
  cosmeticTimer = window.setTimeout(() => {
    cosmeticTimer = 0
    sweepCosmetic()
  }, COSMETIC_SWEEP_MS)
}

function installCosmetic(): void {
  // A compatibility site is granted everything the prompt offers, and this pass
  // is one of the things it was granted exemption from.
  if (!cosmeticOn || compatibilitySite || !host) return
  try {
    if (!document.getElementById('warden-cosmetic')) {
      const style = document.createElement('style')
      style.id = 'warden-cosmetic'
      style.textContent = cosmeticCss(host)
      ;(document.head || document.documentElement)?.appendChild(style)
    }
  } catch {
    return
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleCosmeticSweep, { once: true })
  }
  scheduleCosmeticSweep()

  if (typeof MutationObserver !== 'function') return
  const observer = new MutationObserver(scheduleCosmeticSweep)
  const watch = (): void => {
    const root = document.documentElement
    if (root) observer.observe(root, { childList: true, subtree: true })
  }
  if (document.documentElement) watch()
  else document.addEventListener('DOMContentLoaded', watch, { once: true })
}

installCosmetic()

/**
 * Answer whether this document is a human-verification wall.
 *
 * The main process owns what to do with the answer; here it only reports on the
 * document in front of it, and it reports on every load — a solved wall clears
 * the prompt instead of leaving it behind. A compatible site is skipped: it has
 * already been granted everything the prompt would offer.
 */
const CHALLENGE_MARKUP = WALL_SELECTORS.join(',')

function rawText(): string {
  try {
    // textContent, unlike innerText, does not force a layout pass.
    return document.body ? (document.body.textContent || '').slice(0, 12_000) : ''
  } catch {
    return ''
  }
}

function visibleText(): string {
  try {
    return document.body ? (document.body.innerText || '').slice(0, 4000) : ''
  } catch {
    return ''
  }
}

function reportChallengeWall(): void {
  if (compatibilitySite || !tabId) return
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return

  let title = ''
  let hasChallengeMarkup = false
  try {
    title = document.title || ''
    hasChallengeMarkup = Boolean(document.querySelector(CHALLENGE_MARKUP))
  } catch {
    return
  }

  // Title and markup answer without touching the layout. Only when those come
  // back empty is the visible text read, and only if the raw text already looks
  // like a wall — a single-page app re-renders constantly and cannot pay for an
  // innerText pass on every mutation.
  let reason = looksLikeChallengeWall({ title, text: '', hasChallengeMarkup })
  if (!reason && containsWallPhrase(rawText())) {
    reason = looksLikeChallengeWall({ title, text: visibleText(), hasChallengeMarkup })
  }

  try {
    ipcRenderer.send('warden:challenge:wall', tabId, reason)
  } catch {
    /* the window may be gone already */
  }
}

/**
 * Report how much document there is.
 *
 * The main process pairs this with its blocked-request count for the tab: a
 * settled document with almost no text, a handful of elements and several
 * blocked requests is a site the filtering broke, and the operator is offered
 * the choice instead of being left with a blank page. Reported on every probe
 * because a single-page app that recovers must be able to retract it.
 */
function reportHealth(): void {
  if (compatibilitySite || !tabId) return
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return

  let textChars = 0
  let elements = 0
  try {
    const body = document.body
    if (!body) return
    // innerText, not textContent: an inline script bundle is text no visitor
    // ever sees, and counting it would make an empty page look full.
    textChars = (body.innerText || '').length
    elements = body.querySelectorAll('*').length
  } catch {
    return
  }

  try {
    ipcRenderer.send('warden:page:health', tabId, { textChars, elements })
  } catch {
    /* the window may be gone already */
  }
}

/**
 * A wall can arrive without a navigation: a single-page app swaps its own view,
 * or swaps the sheet in once the page has settled. Watch the body for a
 * substantial replacement and ask again, throttled, so a busy page costs one
 * debounced probe rather than a probe per mutation.
 */
const SPA_CHANGE_CHARS = 80
const SPA_PROBE_DELAY_MS = 900

let spaProbeTimer = 0

function scheduleSpaProbe(): void {
  if (spaProbeTimer) return
  spaProbeTimer = window.setTimeout(() => {
    spaProbeTimer = 0
    reportChallengeWall()
    reportHealth()
  }, SPA_PROBE_DELAY_MS)
}

function watchForSpaChanges(): void {
  if (typeof MutationObserver !== 'function') return
  const body = document.body
  if (!body) return
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      let added = 0
      for (const node of Array.from(record.addedNodes)) {
        added += node.textContent?.length ?? 0
        if (added >= SPA_CHANGE_CHARS) break
      }
      // A wall replaces the page; a badge, a spinner or a counter does not.
      if (added >= SPA_CHANGE_CHARS || record.removedNodes.length > 1) {
        scheduleSpaProbe()
        return
      }
    }
  })
  observer.observe(body, { childList: true, subtree: true })
}

function scheduleWallProbe(): void {
  if (location.protocol !== 'https:' && location.protocol !== 'http:') return
  reportChallengeWall()
  reportHealth()
  watchForSpaChanges()
  // Some walls are injected after load, so ask again once the page has settled.
  window.setTimeout(() => {
    reportChallengeWall()
    reportHealth()
  }, 2500)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', scheduleWallProbe, { once: true })
} else {
  scheduleWallProbe()
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

/**
 * Every absolute URL a media element can be named by.
 *
 * `currentSrc`, the `src` attribute and each `<source>` can all differ while
 * pointing at the same player, and different callers name it differently, so
 * nothing downstream should depend on one spelling being the right one.
 */
function mediaUrls(element: HTMLMediaElement): string[] {
  const raw: string[] = [element.currentSrc, element.getAttribute('src') ?? '', element.src]
  for (const source of Array.from(element.querySelectorAll('source'))) {
    raw.push(source.getAttribute('src') ?? '')
  }
  const urls = new Set<string>()
  for (const value of raw) {
    if (!value || value.startsWith('blob:') || value.startsWith('data:')) continue
    try {
      urls.add(new URL(value, location.href).toString())
    } catch {
      /* not a URL this document can resolve */
    }
  }
  return [...urls]
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
    // Every URL this element answers to, not just the one that wins the
    // precedence above. The menu is handed whatever Chromium reports for the
    // element under the cursor — often the `src` attribute or a `<source>` —
    // and a detach keyed on a single spelling silently found nothing, which is
    // how a "moved" video kept playing in the page.
    for (const alias of mediaUrls(element)) elementsByUrl.set(alias, element)

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

/**
 * Take the player off the page.
 *
 * Only ever sent because the operator asked for it: a dock opened automatically
 * mirrors the playing video and must leave the page alone, so this is a separate
 * signal from `claim` rather than the same one with a flag.
 *
 * Splay plays the source in its own view, so leaving the original in place would
 * mean the same audio twice and a page still holding a poster-sized gap for a
 * player nobody is watching. The element goes, and any wrapper that held only
 * the player collapses, so the page reflows around the hole: pick the second of
 * three videos and the other two close up.
 */
function takeFromPage(element: HTMLMediaElement): void {
  const parent = element.parentElement
  try {
    element.muted = true
    element.pause()
    // Dropping the source stops the download; a detached element with a live
    // `src` keeps fetching the stream nobody is rendering.
    element.removeAttribute('src')
    element.load()
  } catch {
    /* already detached, or the element refuses to unload */
  }
  try {
    element.remove()
  } catch {
    /* ignored: removal is best effort */
  }

  let current = parent
  for (let depth = 0; depth < 3 && current && current !== document.body; depth += 1) {
    if (COSMETIC_KEEP.has(current.tagName)) break
    if ((current.textContent || '').trim()) break
    const stillHolds = Array.from(current.children).some((child) => cosmeticVisible(child))
    if (stillHolds) break
    current.style.setProperty('display', 'none', 'important')
    current = current.parentElement
  }
}

/**
 * The element the detach means when the URL alone does not identify one.
 *
 * A player can rename its own source between the scan and the click (a signed
 * URL that refreshes, a `<source>` picked by the browser), and a page with a
 * single player leaves no ambiguity to resolve.
 */
function elementForDetach(url: string): HTMLMediaElement | null {
  const known = elementsByUrl.get(url)
  if (known) return known
  const all = Array.from(document.querySelectorAll('video, audio')) as HTMLMediaElement[]
  const renamed = all.find((element) => mediaUrls(element).includes(url))
  if (renamed) return renamed
  return all.length === 1 ? all[0]! : null
}

ipcRenderer.on('warden:media:detach', (_event, url: string) => {
  const element = elementForDetach(url)
  if (!element) return
  for (const alias of mediaUrls(element)) elementsByUrl.delete(alias)
  elementsByUrl.delete(url)
  takeFromPage(element)
  // The page's own layout changed, so the media list is stale until re-read.
  scheduleReport()
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
