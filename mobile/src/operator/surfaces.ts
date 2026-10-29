/**
 * The operator surfaces, as the phone can have them.
 *
 * Two of the desktop's non-browser surfaces map onto a phone without a protocol
 * stack: **Scry** (read the page you are on) and **Services** (a chat or mail web
 * app in a session of its own). The service list is imported from `@shared`,
 * which is where the desktop reads it from, so a service added on one platform
 * cannot be missing on the other.
 *
 * Mail is the web client of the operator's provider rather than an IMAP client:
 * the desktop talks IMAP from the main process, and a phone has no equivalent
 * mailbox path yet. The panel says so instead of pretending.
 */
import { MESSAGING_SERVICES } from '@shared/defaults'

export interface OperatorButton {
  id: string
  name: string
  url: string
  color: string
  glyph: string
}

/** Slack, Discord, Teams and the rest — the desktop's own list, unchanged. */
export const SERVICES: readonly OperatorButton[] = MESSAGING_SERVICES

/**
 * Mail, by provider. Any address works: the panel takes an arbitrary one too, so
 * a self-hosted or team webmail is not a gap in the list.
 */
export const MAIL_PROVIDERS: readonly OperatorButton[] = [
  { id: 'gmail', name: 'Gmail', url: 'https://mail.google.com', color: '#EA4335', glyph: 'G' },
  { id: 'outlook', name: 'Outlook', url: 'https://outlook.office.com/mail/', color: '#0F6CBD', glyph: 'O' },
  { id: 'proton', name: 'Proton Mail', url: 'https://mail.proton.me', color: '#6D4AFF', glyph: 'P' },
  { id: 'fastmail', name: 'Fastmail', url: 'https://app.fastmail.com', color: '#0067B9', glyph: 'F' },
  { id: 'zoho', name: 'Zoho Mail', url: 'https://mail.zoho.com', color: '#E42527', glyph: 'Z' },
  { id: 'icloud', name: 'iCloud Mail', url: 'https://www.icloud.com/mail', color: '#3693F3', glyph: 'i' }
]

/**
 * What the Services and Mail panels must not imply.
 *
 * A service keeps its own cookies so a login survives; the browser wipes
 * everything when it closes. Both statements are true because the two live in
 * different stores, which is why this sentence names the store and not "the app".
 */
export const SERVICE_SESSION_NOTE =
  'Chat and mail keep their own sign-in so they are usable. The browser does not share it, and closing a page still clears what that page left behind.'
