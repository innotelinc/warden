/**
 * Getting an existing mailbox into Relay.
 *
 * WARDEN speaks IMAP and SMTP with a password, so the two things that decide
 * whether an address works are the server names and what the provider calls a
 * password. Guessing `imap.<domain>` is right for a cPanel-style host and wrong
 * for Gmail's neighbours, Outlook, iCloud and Proton, and the old dialog left the
 * operator to discover that from a failed connection.
 *
 * These presets are the servers each provider documents, the ports that match
 * them, and one line about what has to be true first — usually an app password,
 * because the account password stopped working for third-party clients years ago.
 */

export type MailAuthKind = 'password' | 'app-password' | 'oauth'

export interface MailEndpoint {
  host: string
  port: number
  /** True for implicit TLS (993/465); false means STARTTLS (143/587). */
  secure: boolean
}

export interface MailProviderPreset {
  id: string
  name: string
  /** Lower-case domains that select this preset from an address. */
  domains: string[]
  imap: MailEndpoint
  smtp: MailEndpoint
  auth: MailAuthKind
  /**
   * False when the provider retired password auth for clients like this one, so
   * the dialog can say so instead of letting the connection fail first.
   */
  passwordWorks: boolean
  note: string
}

export const MAIL_PROVIDERS: MailProviderPreset[] = [
  {
    id: 'gmail',
    name: 'Gmail',
    domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
    auth: 'app-password',
    passwordWorks: true,
    note: 'Use a 16-character app password, not your Google password. Turn on 2-step verification, then create one at myaccount.google.com/apppasswords. IMAP also has to be enabled in Gmail settings.'
  },
  {
    id: 'microsoft',
    name: 'Outlook / Microsoft 365',
    // Microsoft hands out the same mailbox under regional spellings, and an
    // address on one of those that falls through to imap.<domain> cannot work.
    domains: [
      'outlook.com',
      'outlook.co.uk',
      'outlook.fr',
      'outlook.de',
      'outlook.it',
      'outlook.es',
      'hotmail.com',
      'hotmail.co.uk',
      'hotmail.fr',
      'hotmail.de',
      'hotmail.it',
      'hotmail.es',
      'live.com',
      'live.co.uk',
      'live.fr',
      'live.de',
      'live.it',
      'msn.com',
      'office365.com',
      'onmicrosoft.com'
    ],
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
    auth: 'oauth',
    passwordWorks: false,
    note: 'Microsoft retired password sign-in for IMAP and SMTP, so a personal Outlook account cannot be added here — it needs OAuth, which WARDEN does not implement yet. A Microsoft 365 tenant can enable SMTP AUTH and use an app password, if its administrator allows it.'
  },
  {
    id: 'icloud',
    name: 'iCloud Mail',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.me.com', port: 587, secure: false },
    auth: 'app-password',
    passwordWorks: true,
    note: 'Create an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords. Your Apple ID password will be rejected.'
  },
  {
    id: 'yahoo',
    name: 'Yahoo Mail',
    domains: ['yahoo.com', 'ymail.com', 'yahoo.co.uk', 'yahoo.ca'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, secure: true },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, secure: true },
    auth: 'app-password',
    passwordWorks: true,
    note: 'Generate an app password under Account Security → Generate app password. Yahoo blocks the account password for third-party clients.'
  },
  {
    id: 'fastmail',
    name: 'Fastmail',
    domains: ['fastmail.com', 'fastmail.fm', 'messagingengine.com'],
    imap: { host: 'imap.fastmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.fastmail.com', port: 465, secure: true },
    auth: 'app-password',
    passwordWorks: true,
    note: 'Create an app password in Settings → Privacy & Security → App passwords, scoped to Mail (IMAP/SMTP).'
  },
  {
    id: 'zoho',
    name: 'Zoho Mail',
    domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtp.zoho.com', port: 465, secure: true },
    auth: 'app-password',
    passwordWorks: true,
    note: 'With two-factor authentication on, Zoho requires an application-specific password from Account Security.'
  },
  {
    id: 'aol',
    name: 'AOL Mail',
    domains: ['aol.com'],
    imap: { host: 'imap.aol.com', port: 993, secure: true },
    smtp: { host: 'smtp.aol.com', port: 465, secure: true },
    auth: 'app-password',
    passwordWorks: true,
    note: 'Generate an app password under Account Security. AOL rejects the account password for IMAP.'
  },
  {
    id: 'proton',
    name: 'Proton Mail (Bridge)',
    domains: ['proton.me', 'protonmail.com', 'pm.me'],
    imap: { host: '127.0.0.1', port: 1143, secure: false },
    smtp: { host: '127.0.0.1', port: 1025, secure: false },
    auth: 'password',
    passwordWorks: true,
    note: 'Proton only speaks IMAP through Proton Mail Bridge: install and unlock Bridge first, then use the bridge password it prints. Both ports use STARTTLS, so leave the TLS switches on their STARTTLS settings.'
  },
  {
    id: 'custom',
    name: 'Other / self-hosted',
    domains: [],
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
    auth: 'password',
    passwordWorks: true,
    note: 'Most hosts answer on imap.<domain>:993 with TLS and smtp.<domain>:465 with TLS. If the server uses STARTTLS instead, switch its TLS button off and use 143 or 587.'
  }
]

const BY_ID = new Map(MAIL_PROVIDERS.map((provider) => [provider.id, provider]))

export function providerById(id: string): MailProviderPreset | null {
  return BY_ID.get(id) ?? null
}

/** The preset an address belongs to, by its domain. Null for anything unknown. */
export function providerForEmail(email: string): MailProviderPreset | null {
  const domain = email.split('@')[1]?.trim().toLowerCase()
  if (!domain) return null
  const bare = domain.replace(/^www\./, '')
  for (const provider of MAIL_PROVIDERS) {
    if (provider.id === 'custom') continue
    if (provider.domains.some((entry) => bare === entry || bare.endsWith(`.${entry}`))) return provider
  }
  return null
}

/** The hosts to start from for an address nobody has a preset for. */
export function guessEndpoints(domain: string): { imap: MailEndpoint; smtp: MailEndpoint } {
  const clean = domain.trim().toLowerCase().replace(/^@/, '')
  return {
    imap: { host: clean ? `imap.${clean}` : '', port: 993, secure: true },
    smtp: { host: clean ? `smtp.${clean}` : '', port: 465, secure: true }
  }
}

/**
 * Turn a server's complaint into something an operator can act on.
 *
 * The raw string is still shown after this — this is the sentence that says
 * *which* of the four usual mistakes it is: wrong host, wrong port or TLS mode,
 * a password the provider no longer accepts, or a network path that is blocked.
 */
export function mailErrorHint(raw: string): string | null {
  const text = raw || ''
  if (/application-specific password|app password/i.test(text)) {
    return 'That provider wants an app password, not the account password.'
  }
  if (/basic authentication is disabled|oauth2?|\bOAuth\b/i.test(text) && /disabled|required|not supported/i.test(text)) {
    return 'This provider has retired password sign-in for IMAP; the account needs OAuth.'
  }
  if (/invalid credentials|authenticationfailed|login failed|auth(entication)? failed|username and password not accepted/i.test(text)) {
    return 'The server rejected the credentials. Check the username is the full address, and use an app password if the provider requires one.'
  }
  if (/enotfound|getaddrinfo|eai_again|no such host|name or service not known/i.test(text)) {
    return 'That host does not resolve. Check the IMAP and SMTP server names for this provider.'
  }
  if (/econnrefused|connection refused/i.test(text)) {
    return 'Nothing is listening on that port. Check the port, and whether the TLS switch matches it (993 and 465 use TLS, 143 and 587 use STARTTLS).'
  }
  if (/etimedout|etimeout|timed? ?out|connection not available/i.test(text)) {
    return 'The server did not answer in time. A firewall, a tunnel that is down, or the wrong host will all look like this.'
  }
  if (/certificate|self.signed|unable to verify|cert_|handshake/i.test(text)) {
    return 'The TLS certificate was not trusted, or the server expects STARTTLS where TLS was selected.'
  }
  if (/unknown user|no such mailbox|does not exist/i.test(text)) {
    return 'The server accepted the connection but does not know that mailbox.'
  }
  return null
}
