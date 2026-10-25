import type { MessagingService, Settings } from './types'
import { DEFAULT_DOH_PROVIDER } from './dns'

export const APP_NAME = 'WARDEN'
export const APP_TAGLINE = 'Read everything. Give nothing.'

export const DEFAULT_SETTINGS: Settings = {
  cookieMode: 'block',
  blockAds: true,
  blockTrackers: true,
  httpsOnly: true,
  fingerprintHardening: true,
  stripReferrer: true,
  globalPrivacyControl: true,
  blockWebSockets: false,
  javascriptEnabled: true,
  imagesEnabled: true,
  webrtcLeakProtection: true,
  allowlist: [],
  compatibility: [],
  customRules: '',
  searchEngine: 'duckduckgo',
  homepage: 'warden://newtab',
  terminalShell: '',
  terminalFontSize: 13,
  autoDockMedia: true,
  lastMailAccountId: null,
  scryPort: 9222,
  scryOutputDir: null,
  theme: 'ops',
  debugPort: 0,
  autoUpdate: true,
  lockTimeoutMinutes: 5,
  dnsOverHttps: true,
  dnsProvider: DEFAULT_DOH_PROVIDER,
  privateByDefault: true,
  vpnEnabled: true,
  vpnMode: 'socks5',
  vpnHost: '',
  vpnPort: 0,
  vpnBypass: '<local>',
  cameraMode: 'off',
  cameraStrength: 55,
  voiceMode: 'off',
  cameraBlocked: false,
  microphoneBlocked: false
}

export interface SearchEngine {
  id: string
  name: string
  searchUrl: string
}

export const SEARCH_ENGINES: SearchEngine[] = [
  { id: 'duckduckgo', name: 'DuckDuckGo', searchUrl: 'https://duckduckgo.com/?q=%s' },
  { id: 'startpage', name: 'Startpage', searchUrl: 'https://www.startpage.com/sp/search?query=%s' },
  { id: 'brave', name: 'Brave Search', searchUrl: 'https://search.brave.com/search?q=%s' },
  { id: 'mojeek', name: 'Mojeek', searchUrl: 'https://www.mojeek.com/search?q=%s' },
  { id: 'wikipedia', name: 'Wikipedia', searchUrl: 'https://en.wikipedia.org/w/index.php?search=%s' },
  { id: 'google', name: 'Google', searchUrl: 'https://www.google.com/search?q=%s' }
]

export const MESSAGING_SERVICES: MessagingService[] = [
  { id: 'slack', name: 'Slack', url: 'https://app.slack.com/client', color: '#4A154B', glyph: 'S' },
  { id: 'discord', name: 'Discord', url: 'https://discord.com/app', color: '#5865F2', glyph: 'D' },
  { id: 'teams', name: 'Teams', url: 'https://teams.microsoft.com', color: '#5059C9', glyph: 'T' },
  { id: 'whatsapp', name: 'WhatsApp', url: 'https://web.whatsapp.com', color: '#25D366', glyph: 'W' },
  { id: 'telegram', name: 'Telegram', url: 'https://web.telegram.org/a/', color: '#2AABEE', glyph: 'G' },
  { id: 'element', name: 'Element', url: 'https://app.element.io', color: '#0DBD8B', glyph: 'E' },
  { id: 'google-chat', name: 'Google Chat', url: 'https://mail.google.com/chat/u/0/', color: '#00AC47', glyph: 'C' },
  { id: 'mattermost', name: 'Mattermost', url: 'https://mattermost.com/login', color: '#1E325C', glyph: 'M' }
]

export const DEFAULT_MAIL_FOLDER = 'INBOX'

/** Search-bar prefixes that resolve to internal surfaces. */
export const INTERNAL_SCHEMES = ['warden://', 'about:'] as const
