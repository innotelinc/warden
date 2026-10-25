import { describe, expect, it } from 'vitest'
import { DOH_PROVIDERS, dohSwitches, dohTemplateFor } from '../src/shared/dns'
import { egressLabel, normalizeProxy, proxyRule } from '../src/shared/network'
import {
  cameraPlan,
  isCameraMode,
  isVoiceMode,
  transformsCamera,
  transformsVoice,
  voicePlan
} from '../src/shared/sensors'

describe('encrypted DNS', () => {
  it('turns a known provider into a secure resolver switch', () => {
    const switches = dohSwitches(true, 'quad9')
    expect(switches.mode).toBe('secure')
    expect(switches.templates[0]).toContain('dns.quad9.net')
    expect(switches.templates[0]).toContain('{?dns}')
  })

  it('refuses a made-up provider instead of falling back quietly', () => {
    expect(dohSwitches(true, 'not-a-resolver')).toEqual({ mode: 'off', templates: [] })
    expect(dohTemplateFor('https://evil.example/dns-query')).toBeNull()
  })

  it('stays off when the feature is disabled', () => {
    expect(dohSwitches(false, 'cloudflare').mode).toBe('off')
  })

  it('offers only https templates', () => {
    for (const provider of DOH_PROVIDERS) {
      expect(provider.template.startsWith('https://')).toBe(true)
    }
  })
})

describe('proxy egress', () => {
  it('builds a socks5 rule only from a complete endpoint', () => {
    expect(
      proxyRule({ mode: 'socks5', host: '127.0.0.1', port: 1080, bypass: '<local>' })
    ).toEqual({ kind: 'proxy', rule: 'socks5://127.0.0.1:1080' })
    expect(proxyRule({ mode: 'socks5', host: '', port: 1080, bypass: '<local>' })).toEqual({
      kind: 'direct',
      reason: 'unconfigured'
    })
    expect(proxyRule({ mode: 'off', host: '127.0.0.1', port: 1080, bypass: '<local>' })).toEqual({
      kind: 'direct',
      reason: 'disabled'
    })
  })

  it('strips schemes and paths from a pasted endpoint', () => {
    expect(normalizeProxy({ mode: 'https', host: 'https://proxy.corp.example:8443/x', port: 8443 })).toMatchObject({
      host: 'proxy.corp.example',
      port: 8443
    })
    expect(normalizeProxy({ mode: 'https', host: 'bad host', port: 70000 })).toMatchObject({
      host: '',
      port: 0
    })
  })

  it('labels what is actually happening', () => {
    expect(egressLabel({ mode: 'socks5', host: '10.0.0.5', port: 1080, bypass: '<local>' })).toContain(
      'socks5://10.0.0.5:1080'
    )
    expect(egressLabel({ mode: 'socks5', host: '', port: 0, bypass: '<local>' })).toBe(
      'no endpoint configured'
    )
  })
})

describe('sensor treatment', () => {
  it('scales the blur and block size with strength', () => {
    expect(cameraPlan('soften', 0).blur).toBe(2)
    expect(cameraPlan('soften', 100).blur).toBeGreaterThan(20)
    expect(cameraPlan('pixelate', 100).block).toBeGreaterThan(cameraPlan('pixelate', 20).block)
    expect(cameraPlan('portrait', 50).vignette).toBe(true)
    expect(cameraPlan('soften', 50).vignette).toBe(false)
  })

  it('maps voice modes to filter and ring settings', () => {
    expect(voicePlan('off')).toEqual({ lowpass: 0, highpass: 0, ringHz: 0, ringDepth: 0 })
    expect(voicePlan('deep').lowpass).toBeGreaterThan(0)
    expect(voicePlan('bright').highpass).toBeGreaterThan(0)
    expect(voicePlan('robot').ringHz).toBeGreaterThan(0)
  })

  it('treats blocked sensors as stronger than a treatment', () => {
    const base = {
      cameraMode: 'pixelate' as const,
      cameraStrength: 50,
      voiceMode: 'robot' as const,
      cameraBlocked: false,
      microphoneBlocked: false
    }

    expect(transformsCamera(base)).toBe(true)
    expect(transformsCamera({ ...base, cameraBlocked: true })).toBe(false)
    expect(transformsVoice({ ...base, voiceMode: 'off' })).toBe(false)
    expect(transformsVoice({ ...base, microphoneBlocked: true })).toBe(false)
  })

  it('validates modes coming from settings', () => {
    expect(isCameraMode('silhouette')).toBe(true)
    expect(isCameraMode('deepfake')).toBe(false)
    expect(isVoiceMode('robot')).toBe(true)
    expect(isVoiceMode('chipmunk')).toBe(false)
  })
})
