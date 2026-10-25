/**
 * Resolvers WARDEN will talk DNS-over-HTTPS to.
 *
 * Chromium does the actual resolution: these values only become command-line
 * switches at startup (`--dns-over-https-mode=secure` plus the template), so a
 * change needs a relaunch. Keeping the list here means Policy and the startup
 * path agree on what a valid choice is, and tests can prove a made-up URL never
 * reaches the resolver switch.
 */

export interface DohProvider {
  id: string
  name: string
  /** Template with `{?dns}`; Chromium fills in the base64url-encoded query. */
  template: string
  note: string
}

export const DOH_PROVIDERS: DohProvider[] = [
  {
    id: 'quad9',
    name: 'Quad9',
    template: 'https://dns.quad9.net/dns-query{?dns}',
    note: 'Blocks known malicious domains; no logging of client IPs'
  },
  {
    id: 'cloudflare',
    name: 'Cloudflare',
    template: 'https://cloudflare-dns.com/dns-query{?dns}',
    note: 'Fastest; retains aggregate query data'
  },
  {
    id: 'mullvad',
    name: 'Mullvad',
    template: 'https://dns.mullvad.net/dns-query{?dns}',
    note: 'No logging; operated by the VPN provider'
  },
  {
    id: 'nextdns',
    name: 'NextDNS',
    template: 'https://dns.nextdns.io/dns-query{?dns}',
    note: 'Account-scoped filtering; needs your NextDNS profile for policy'
  },
  {
    id: 'google',
    name: 'Google Public DNS',
    template: 'https://dns.google/dns-query{?dns}',
    note: 'Widely reachable; logs are aggregated, not tied to accounts'
  }
]

export const DEFAULT_DOH_PROVIDER = 'quad9'

/** True only for https templates that are on the known list. */
export function dohTemplateFor(provider: string): string | null {
  const found = DOH_PROVIDERS.find((entry) => entry.id === provider)
  return found ? found.template : null
}

export interface DohSwitches {
  mode: 'secure' | 'off'
  templates: string[]
}

/**
 * Switches for Chromium's resolver. An unknown provider is treated as "off"
 * rather than silently falling back to the system resolver while the UI says
 * encrypted DNS is active.
 */
export function dohSwitches(enabled: boolean, provider: string): DohSwitches {
  const template = enabled ? dohTemplateFor(provider) : null
  if (!template) return { mode: 'off', templates: [] }
  return { mode: 'secure', templates: [template] }
}
