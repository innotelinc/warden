import { readFileSync } from 'node:fs'
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

  it('gives every preset the same tokens, so no palette can fall back silently', () => {
    const reference = Object.keys(THEMES[0]!.vars).sort()
    for (const theme of THEMES) {
      expect(Object.keys(theme.vars).sort(), theme.id).toEqual(reference)
    }
  })

  it('leaves the default palette and default setting as they were', () => {
    expect(DEFAULT_THEME).toBe('ops')
    expect(DEFAULT_SETTINGS.theme).toBe('ops')
    const ops = themeFor('ops')
    expect(ops.vars['--bg']).toBe('#07090c')
    expect(ops.vars['--mint']).toBe('#4fe3c1')
    expect(ops.vars['color-scheme']).toBe('dark')
  })

  it('ships a light palette that is actually light', () => {
    const light = THEMES.find((theme) => theme.id === 'light')
    expect(light, 'light preset').toBeDefined()
    const channel = (value: string): number => Number.parseInt(value.slice(1, 3), 16)
    const luminance = (value: string): number => {
      const hex = value.replace('#', '')
      const [r, g, b] = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
      return (0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255
    }
    expect(luminance(light!.vars['--bg']!)).toBeGreaterThan(0.85)
    expect(luminance(light!.vars['--text']!)).toBeLessThan(0.25)
    // Dark text on a light surface: the inverse of the default palette.
    expect(luminance(light!.vars['--text']!)).toBeLessThan(luminance(light!.vars['--bg']!))
    expect(light!.vars['color-scheme']).toBe('light')
    expect(channel(light!.vars['--mint']!)).toBeLessThan(128)
  })

  /**
   * The light palette is tuned by measurement, not by eye: there is no browser
   * in which to look at it, so these ratios are the review. WCAG AA for body
   * text is 4.5:1, and `--faint` carries 10px mono hints.
   */
  it('keeps the light palette readable on white', () => {
    const light = themeFor('light')
    const rgb = (value: string): number[] => {
      const hex = value.replace('#', '')
      return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16))
    }
    const channel = (c: number): number => {
      const s = c / 255
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    }
    const luminance = (value: number[]): number =>
      0.2126 * channel(value[0]!) + 0.7152 * channel(value[1]!) + 0.0722 * channel(value[2]!)
    const contrast = (fg: string, bg: string): number => {
      const [a, b] = [luminance(rgb(fg)), luminance(rgb(bg))]
      const [hi, lo] = a > b ? [a, b] : [b, a]
      return (hi + 0.05) / (lo + 0.05)
    }
    /** A translucent wash flattened onto the token that sits behind it. */
    const wash = (rgbToken: string, alpha: number, underToken: string): string => {
      const [r, g, b] = light.vars[rgbToken]!.split(',').map((part) => Number(part.trim()))
      const base = rgb(light.vars[underToken]!)
      return `#${[r!, g!, b!]
        .map((c, index) => Math.round(c * alpha + base[index]! * (1 - alpha)).toString(16).padStart(2, '0'))
        .join('')}`
    }

    const pairs: [string, string, string, number][] = [
      ['body', '--text', '--bg', 7],
      ['secondary', '--text-dim', '--surface', 4.5],
      ['label', '--muted', '--surface', 4.5],
      ['hint', '--faint', '--surface', 4.5],
      ['link', '--mint', '--surface', 4.5],
      ['accent', '--amber', '--surface', 4.5],
      ['danger', '--red', '--surface', 4.5]
    ]
    for (const [name, fg, bg, minimum] of pairs) {
      expect(contrast(light.vars[fg]!, light.vars[bg]!), `${name} on ${bg}`).toBeGreaterThanOrEqual(minimum)
    }

    // The two places where a colour sits on its own wash rather than a surface.
    expect(contrast(light.vars['--amber']!, wash('--amber-rgb', 0.13, '--bg')!), 'challenge bar host').toBeGreaterThanOrEqual(
      4.5
    )
    expect(contrast(light.vars['--mint-soft']!, wash('--mint-rgb', 0.18, '--surface')!), 'primary button').toBeGreaterThanOrEqual(
      4.5
    )
  })

  it('defines every token the stylesheet asks for', () => {
    const css = readFileSync(new URL('../src/renderer/src/theme.css', import.meta.url), 'utf8')
    const defined = new Set([
      ...Object.keys(themeFor(DEFAULT_THEME).vars),
      ...[...css.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)].map((match) => match[1]!)
    ])
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/gi)].map((match) => match[1]!)
    expect(used.length).toBeGreaterThan(100)
    for (const name of used) {
      expect(defined.has(name), `${name} is used but never defined`).toBe(true)
    }
  })

  /**
   * A background painted from a literal instead of a token is invisible in one
   * palette and wrong in the other: the close chip shipped as an opaque
   * `rgba(11, 16, 22, 0.9)` pill, which rendered as a filled black square the
   * moment the palette went light. Token defaults in :root are exempt — they
   * are the dark palette's own values, overwritten by every preset.
   */
  it('paints no background from a hardcoded dark literal', () => {
    const css = readFileSync(new URL('../src/renderer/src/theme.css', import.meta.url), 'utf8')
    const body = css.replace(/:root\s*\{[^}]*\}/g, '')
    const dark = [...body.matchAll(/background(?:-color)?\s*:\s*([^;}]+)/gi)]
      .map((match) => match[1]!.trim())
      .filter((value) => {
        const literal = value.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/)
        if (!literal) return false
        return Math.max(Number(literal[1]), Number(literal[2]), Number(literal[3])) <= 40
      })
    expect(dark, `backgrounds that stay dark in every theme:\n${dark.join('\n')}`).toEqual([])
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
