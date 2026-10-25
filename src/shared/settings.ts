import { DEFAULT_SETTINGS } from './defaults'
import { DEFAULT_DOH_PROVIDER, dohTemplateFor } from './dns'
import { normalizeProxy } from './network'
import { isCameraMode, isVoiceMode } from './sensors'
import { DEFAULT_THEME, isThemeId } from './themes'
import type { Settings } from './types'

/** Coerce anything read from disk or the renderer into a valid Settings object. */
export function sanitizeSettings(value: unknown): Settings {
  const input = (value ?? {}) as Partial<Settings>
  const merged: Settings = { ...DEFAULT_SETTINGS, ...input }
  merged.cookieMode = input.cookieMode === 'first-party' ? 'first-party' : 'block'
  merged.allowlist = Array.isArray(input.allowlist)
    ? input.allowlist
        .filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
        .map((host) => host.trim().toLowerCase())
    : []
  merged.compatibility = Array.isArray(input.compatibility)
    ? input.compatibility
        .filter((host): host is string => typeof host === 'string' && host.trim().length > 0)
        .map((host) => host.trim().toLowerCase())
    : []
  merged.compatibility = [...new Set(merged.compatibility)].slice(0, 100)
  merged.customRules = typeof input.customRules === 'string' ? input.customRules.slice(0, 200_000) : ''
  merged.terminalFontSize = Math.min(22, Math.max(10, Number(input.terminalFontSize) || 13))
  merged.scryPort = Math.min(65535, Math.max(1024, Number(input.scryPort) || 9222))
  // 0 keeps WARDEN's own debug endpoint closed; anything else is a usable port.
  const debugPort = Number(input.debugPort)
  merged.debugPort =
    Number.isInteger(debugPort) && debugPort >= 1024 && debugPort <= 65535 ? debugPort : 0
  merged.autoUpdate = merged.autoUpdate !== false
  merged.dnsOverHttps = merged.dnsOverHttps !== false
  merged.dnsProvider = dohTemplateFor(input.dnsProvider ?? '') ? String(input.dnsProvider) : DEFAULT_DOH_PROVIDER
  merged.privateByDefault = merged.privateByDefault !== false
  merged.vpnEnabled = merged.vpnEnabled !== false
  const proxy = normalizeProxy({
    mode: merged.vpnMode,
    host: merged.vpnHost,
    port: merged.vpnPort,
    bypass: merged.vpnBypass
  })
  merged.vpnMode = proxy.mode
  merged.vpnHost = proxy.host
  merged.vpnPort = proxy.port
  merged.vpnBypass = proxy.bypass
  merged.cameraMode = isCameraMode(input.cameraMode) ? input.cameraMode : 'off'
  merged.cameraStrength = Math.min(100, Math.max(0, Math.round(Number(merged.cameraStrength) || 55)))
  merged.voiceMode = isVoiceMode(input.voiceMode) ? input.voiceMode : 'off'
  merged.cameraBlocked = Boolean(merged.cameraBlocked)
  merged.microphoneBlocked = Boolean(merged.microphoneBlocked)
  const lock = Number(input.lockTimeoutMinutes)
  merged.lockTimeoutMinutes = [0, 1, 5, 15, 30, 60].includes(lock) ? lock : DEFAULT_SETTINGS.lockTimeoutMinutes
  merged.blockAds = Boolean(merged.blockAds)
  merged.blockTrackers = Boolean(merged.blockTrackers)
  merged.httpsOnly = Boolean(merged.httpsOnly)
  merged.fingerprintHardening = Boolean(merged.fingerprintHardening)
  merged.stripReferrer = Boolean(merged.stripReferrer)
  merged.globalPrivacyControl = Boolean(merged.globalPrivacyControl)
  merged.allowlist = [...new Set(merged.allowlist)].slice(0, 500)
  if (typeof merged.homepage !== 'string' || !merged.homepage.trim()) {
    merged.homepage = DEFAULT_SETTINGS.homepage
  }
  if (typeof merged.searchEngine !== 'string') merged.searchEngine = DEFAULT_SETTINGS.searchEngine
  if (typeof merged.terminalShell !== 'string') merged.terminalShell = ''
  if (typeof merged.scryOutputDir !== 'string' || !merged.scryOutputDir) merged.scryOutputDir = null
  if (typeof merged.lastMailAccountId !== 'string') merged.lastMailAccountId = null
  merged.theme = isThemeId(input.theme) ? input.theme : DEFAULT_THEME
  return merged
}
