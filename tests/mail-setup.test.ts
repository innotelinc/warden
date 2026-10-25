import { describe, expect, it } from 'vitest'
import {
  MAIL_PROVIDERS,
  guessEndpoints,
  mailErrorHint,
  providerById,
  providerForEmail
} from '../src/shared/mail-setup'

describe('mail provider presets', () => {
  it('gives every provider the servers and ports its service documents', () => {
    expect(providerById('gmail')?.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true })
    expect(providerById('gmail')?.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true })
    expect(providerById('microsoft')?.imap.host).toBe('outlook.office365.com')
    expect(providerById('microsoft')?.smtp.port).toBe(587)
    expect(providerById('icloud')?.imap.host).toBe('imap.mail.me.com')
    expect(providerById('proton')?.imap.port).toBe(1143)
  })

  it('keeps the TLS switch consistent with the port it ships with', () => {
    for (const provider of MAIL_PROVIDERS) {
      if (provider.id === 'custom') continue
      for (const endpoint of [provider.imap, provider.smtp]) {
        // 993 and 465 are implicit TLS; 143, 587 and the Bridge ports use
        // STARTTLS, which this app expresses as secure: false.
        const implicit = endpoint.port === 993 || endpoint.port === 465
        expect(endpoint.secure, `${provider.id}:${endpoint.host}:${endpoint.port}`).toBe(implicit)
      }
    }
  })

  it('marks the one provider that retired password sign-in', () => {
    expect(providerById('microsoft')?.passwordWorks).toBe(false)
    const usable = MAIL_PROVIDERS.filter((provider) => provider.passwordWorks).map((provider) => provider.id)
    expect(usable).toContain('gmail')
    expect(usable).toContain('proton')
    expect(usable).not.toContain('microsoft')
  })

  it('tells the operator how to get a password for each app-password provider', () => {
    for (const provider of MAIL_PROVIDERS.filter((entry) => entry.auth === 'app-password')) {
      expect(provider.note, provider.id).toMatch(/app(lication)?[- ](specific )?password/i)
    }
  })

  it('does not silently invent an id', () => {
    expect(providerById('nope')).toBeNull()
    expect(providerById('')).toBeNull()
  })
})

describe('address to provider', () => {
  it('recognises the domains each provider actually hands out', () => {
    expect(providerForEmail('someone@gmail.com')?.id).toBe('gmail')
    expect(providerForEmail('someone@googlemail.com')?.id).toBe('gmail')
    expect(providerForEmail('someone@hotmail.co.uk')?.id).toBe('microsoft')
    expect(providerForEmail('someone@me.com')?.id).toBe('icloud')
    expect(providerForEmail('someone@proton.me')?.id).toBe('proton')
    expect(providerForEmail('someone@fastmail.fm')?.id).toBe('fastmail')
    expect(providerForEmail('someone@zohomail.com')?.id).toBe('zoho')
  })

  it('matches a hosted tenant on a provider domain', () => {
    expect(providerForEmail('ops@acme.onmicrosoft.com')?.id).toBe('microsoft')
  })

  it('is case- and whitespace-insensitive', () => {
    expect(providerForEmail('Someone@GMAIL.COM')?.id).toBe('gmail')
    expect(providerForEmail('  someone@icloud.com  ')?.id).toBe('icloud')
    expect(providerForEmail('someone@www.gmail.com')?.id).toBe('gmail')
  })

  it('leaves a personal domain to the operator', () => {
    expect(providerForEmail('ops@example.org')).toBeNull()
    expect(providerForEmail('not-an-address')).toBeNull()
    expect(providerForEmail('')).toBeNull()
  })

  it('never selects the catch-all preset on its own', () => {
    for (const address of ['a@gmail.com', 'a@example.org', 'a@proton.me']) {
      expect(providerForEmail(address)?.id).not.toBe('custom')
    }
  })
})

describe('endpoint guessing', () => {
  it('uses the usual imap./smtp. names with TLS ports', () => {
    expect(guessEndpoints('example.org')).toEqual({
      imap: { host: 'imap.example.org', port: 993, secure: true },
      smtp: { host: 'smtp.example.org', port: 465, secure: true }
    })
  })

  it('accepts a leading @ or mixed case from the field', () => {
    expect(guessEndpoints(' @Example.ORG ').imap.host).toBe('imap.example.org')
  })

  it('leaves the hosts empty rather than guessing nonsense', () => {
    expect(guessEndpoints('')).toEqual({
      imap: { host: '', port: 993, secure: true },
      smtp: { host: '', port: 465, secure: true }
    })
  })
})

describe('failure hints', () => {
  it('names an app password when the provider says so', () => {
    expect(mailErrorHint('Please log in with an Application-specific password')).toMatch(/app password/i)
  })

  it('names the retired password sign-in', () => {
    expect(mailErrorHint('Basic authentication is disabled for this mailbox')).toMatch(/OAuth/)
  })

  it('distinguishes rejected credentials from a bad host', () => {
    expect(mailErrorHint('AUTHENTICATIONFAILED Invalid credentials')).toMatch(/full address/)
    expect(mailErrorHint('getaddrinfo ENOTFOUND nope.example')).toMatch(/does not resolve/)
  })

  it('explains port and TLS mismatches', () => {
    expect(mailErrorHint('connect ECONNREFUSED 10.0.0.1:993')).toMatch(/993 and 465 use TLS/)
    expect(mailErrorHint('Error: self signed certificate in certificate chain')).toMatch(/certificate/i)
  })

  it('covers timeouts and unknown mailboxes', () => {
    expect(mailErrorHint('Error: Connection timeout')).toMatch(/did not answer in time/)
    expect(mailErrorHint('No such mailbox')).toMatch(/does not know that mailbox/)
  })

  it('returns nothing it cannot explain, so the raw text stands alone', () => {
    expect(mailErrorHint('')).toBeNull()
    expect(mailErrorHint('something entirely unexpected')).toBeNull()
  })
})
