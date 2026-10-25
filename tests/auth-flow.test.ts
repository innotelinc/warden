import { describe, expect, it } from 'vitest'
import { signInHostsFor } from '../src/shared/auth-flow'

/** The exact shape Authentik emits when an app starts an OIDC login. */
const AUTHENTIK_FLOW =
  'https://auth.cerulean.innotel.us/if/flow/default-authentication-flow/?client_id=e_OcHDay5XrzR1XO9tC287aBJ37gyE3J7QQDw4zYtbE&prompt=login&redirect_uri=https%3A%2F%2Fnas.innotel.us%2Foauth2%2Fcallback&response_type=code&scope=openid+email+profile+groups&state=abc%3A%2F&next=%2Fapplication%2Fo%2Fauthorize%2F%3Fclient_id%3De_OcH%26redirect_uri%3Dhttps%253A%252F%252Fnas.innotel.us%252Foauth2%252Fcallback%26response_type%3Dcode'

describe('signInHostsFor', () => {
  it('reads the provider and application out of an Authentik flow URL', () => {
    expect(signInHostsFor(AUTHENTIK_FLOW)).toEqual({
      provider: 'auth.cerulean.innotel.us',
      application: 'nas.innotel.us'
    })
  })

  it('reads an authorize URL without the flow wrapper', () => {
    expect(
      signInHostsFor(
        'https://auth.cerulean.innotel.us/application/o/authorize/?client_id=x&redirect_uri=https%3A%2F%2Fnas.innotel.us%2Foauth2%2Fcallback&response_type=code'
      )
    ).toEqual({ provider: 'auth.cerulean.innotel.us', application: 'nas.innotel.us' })
  })

  it('recognises a Keycloak login even without a callback', () => {
    expect(
      signInHostsFor(
        'https://sso.example.com/realms/corp/protocol/openid-connect/auth?client_id=app&response_type=code'
      )
    ).toEqual({ provider: 'sso.example.com', application: null })
  })

  it('recognises a plain provider login page', () => {
    expect(signInHostsFor('https://login.example.com/login?next=%2Fhome')).toEqual({
      provider: 'login.example.com',
      application: null
    })
  })

  it('ignores an ordinary page, even with query parameters', () => {
    expect(signInHostsFor('https://www.cnn.com/2026/10/24/politics?utm_source=x')).toBeNull()
    expect(signInHostsFor('https://news.example/article?id=7')).toBeNull()
  })

  it('ignores non-http URLs and junk', () => {
    expect(signInHostsFor('warden://newtab')).toBeNull()
    expect(signInHostsFor('about:blank')).toBeNull()
    expect(signInHostsFor('not a url')).toBeNull()
  })

  /**
   * The control plane opens its own start route in a popup before the provider
   * is named; that popup is where WARDEN has to start allowing cookies, or the
   * state cookie is thrown away before the first redirect.
   */
  it('recognises an application-side OIDC start route', () => {
    expect(signInHostsFor('https://distro.innotel.us/api/auth/oidc/start')).toEqual({
      provider: 'distro.innotel.us',
      application: null
    })
  })

  it('does not mistake an ordinary path that starts with the same letters', () => {
    expect(signInHostsFor('https://example.com/author/jane')).toBeNull()
    expect(signInHostsFor('https://example.com/authors')).toBeNull()
  })

  it('does not report the provider as its own application', () => {
    expect(
      signInHostsFor(
        'https://sso.example.com/oauth2/authorize?client_id=a&response_type=code&redirect_uri=%2Fcallback'
      )
    ).toEqual({ provider: 'sso.example.com', application: null })
  })
})
