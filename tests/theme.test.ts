import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../src/shared/defaults'
import { sanitizeSettings } from '../src/shared/settings'
import { DEFAULT_THEME, THEMES, applyTheme, isThemeId, themeFor, themeSwatch } from '../src/shared/themes'

describe('theme presets', () => {
  it('ships distinct palettes with a complete token set', () => {
    expect(THEMES.length).toBeGreaterThan(1)
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length)
    for (const theme of THEMES) {
      expect(Object.keys(theme.vars)).toEqual(expect.arrayContaining(['--bg', '--surface', '--text', '--mint']))
      expect(themeSwatch(theme)).toHaveLength(4)
    }
  })

  it('never reports an unknown id as valid', () => {
    expect(isThemeId('ops')).toBe(true)
    expect(isThemeId('nope')).toBe(false)
    expect(isThemeId(null)).toBe(false)
    expect(themeFor('nope').id).toBe(DEFAULT_THEME)
  })

  it('writes every token onto the target element', () => {
    const applied = new Map<string, string>()
    const target = {
      style: { setProperty: (name: string, value: string) => applied.set(name, value) } as unknown as CSSStyleDeclaration
    }
    const amber = THEMES.find((theme) => theme.id === 'amber')!
    expect(applyTheme('amber', target).id).toBe('amber')
    expect(applied.get('--mint')).toBe(amber.vars['--mint'])
    expect(applied.get('--bg')).toBe(amber.vars['--bg'])
  })
})

describe('settings sanitisation', () => {
  it('falls back to the default theme for junk on disk', () => {
    expect(sanitizeSettings({ theme: 'hotdog' }).theme).toBe(DEFAULT_THEME)
    expect(sanitizeSettings({}).theme).toBe(DEFAULT_SETTINGS.theme)
  })

  it('keeps a known theme', () => {
    expect(sanitizeSettings({ theme: 'ice' }).theme).toBe('ice')
  })
})
