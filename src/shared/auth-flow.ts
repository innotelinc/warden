/**
 * Recognise a sign-in flow from its URL.
 *
 * WARDEN refuses cookies by default, and an SSO login is exactly the thing that
 * cannot work without them: the identity provider keeps a CSRF token and a
 * session, and the application sets its own session after the callback. The
 * operator already has per-site allowances, but a login spans two hosts, and
 * asking them to work out both is asking them to debug the flow.
 *
 * This identifies the pair so one click can allow exactly those two, and nothing
 * else. Pure and synchronous: no network, no guessing beyond what the redirect
 * URL itself states.
 */

export interface SignInHosts {
  /** The identity provider currently rendering the login. */
  provider: string
  /** The application the flow returns to, when the URL names one. */
  application: string | null
}

/**
 * Paths used by the identity providers WARDEN is likely to meet, plus the
 * application-side start routes (`/api/auth/oidc/start`, `/auth/login`) that
 * an SSO-only control plane opens in a popup before any provider is named.
 */
const AUTH_PATH =
  /\/(application\/o\/authorize|if\/flow|oauth2?|oidc|openid-connect|realms\/[^/]+\/protocol\/openid-connect|saml|saml2|adfs|wsfed|signin-oidc|login|signin|authorize|auth|sso)(\/|$)/i

/** Parameters that carry the application's callback URL, directly or nested. */
const CALLBACK_PARAMS = [
  'redirect_uri',
  'return_url',
  'returnurl',
  'callback',
  'continue',
  'relaystate',
  'redirect'
]

function hostOf(value: string, base?: string): string | null {
  try {
    const url = new URL(value, base)
    if (!/^https?:$/.test(url.protocol)) return null
    const host = url.hostname.toLowerCase()
    return /^[a-z0-9.-]+$/.test(host) ? host : null
  } catch {
    return null
  }
}

/** Collect every callback-looking value, including one level of nesting. */
function callbackValues(url: URL): string[] {
  const found: string[] = []
  for (const key of CALLBACK_PARAMS) {
    const value = url.searchParams.get(key)
    if (!value) continue
    found.push(value)
    // Authentik wraps the original authorize request inside `next=`, so the
    // application's callback is one level deeper.
    try {
      const nested = new URL(value, url)
      for (const innerKey of CALLBACK_PARAMS) {
        const inner = nested.searchParams.get(innerKey)
        if (inner) found.push(inner)
      }
    } catch {
      /* not a URL, ignore */
    }
  }
  return found
}

export function signInHostsFor(rawUrl: string): SignInHosts | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }
  if (!/^https?:$/.test(url.protocol)) return null
  if (!url.hostname) return null

  const provider = url.hostname.toLowerCase()
  const looksLikeAuth =
    AUTH_PATH.test(url.pathname) ||
    url.searchParams.has('redirect_uri') ||
    (url.searchParams.has('client_id') && url.searchParams.has('response_type'))
  if (!looksLikeAuth) return null

  let application: string | null = null
  for (const candidate of callbackValues(url)) {
    const host = hostOf(candidate, url.href)
    if (!host || host === provider || host.endsWith(`.${provider}`)) continue
    application = host
    break
  }

  return { provider, application }
}
