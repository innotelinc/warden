/**
 * Admin palettes.
 *
 * One list drives both the chooser and the running UI: the renderer writes
 * these tokens onto <html> so a theme change is instant and needs no reload,
 * and the preview swatches can never drift from the real colours because they
 * are read from the same objects.
 */

export type ThemeVars = Record<string, string>

export interface ThemePreset {
  id: string
  name: string
  blurb: string
  vars: ThemeVars
}

const base = {
  '--bg': '#07090c',
  '--bg-deep': '#05070a',
  '--surface': '#0d1117',
  '--surface-2': '#11171f',
  '--surface-3': '#161d27',
  '--line': '#1b2430',
  '--line-soft': '#151d26',
  '--line-bright': '#26323f',
  '--text': '#dbe5f1',
  '--text-dim': '#9caec2',
  '--muted': '#6f8093',
  '--faint': '#4e5d6e',
  '--mint': '#4fe3c1',
  '--mint-dim': '#2c9d88',
  '--violet': '#a78bfa',
  '--amber': '#f5b95b',
  '--red': '#ff6b6b',
  '--sky': '#7dd3fc',
  // Surfaces the accent tokens cannot express. A light palette has to repaint
  // these separately from a page's own background, so they travel with every
  // preset instead of being left as literals in the stylesheet.
  '--chrome': '#0a0e13',
  '--chrome-dim': '#080b0f',
  '--well': '#0c1117',
  '--sunken': '#070a0d',
  '--row-active': '#0e141b',
  '--raised': '#131b24',
  '--line-strong': '#33424f',
  '--scroll': '#232e3b',
  '--text-bright': '#cfe0ee',
  '--mint-soft': '#b9f5e6',
  '--red-soft': '#ffb3b3',
  '--danger-wash': '#1a1216',
  '--panel-from': 'rgba(17, 23, 31, 0.86)',
  '--panel-to': 'rgba(12, 16, 22, 0.86)',
  '--panel-2': '#141a22',
  // Ink printed on an accent fill, and the cloak pill's own gradient: a light
  // palette needs both lighter than the amber it uses for text.
  '--on-danger': '#180505',
  '--cloak-ink': '#0b0e12',
  '--cloak-fill': 'linear-gradient(150deg, #f5b95b, #c98f34)',
  // A fade behind a card's footer, and the scrim behind a modal. Both are
  // painted over content rather than behind it, so a dark literal shows up as a
  // grey smear across a light palette: they travel with the preset instead.
  '--scrim-rgb': '4, 6, 9',
  '--overlay': 'rgba(3, 5, 8, 0.62)',
  // Accent channels, for the rgba() washes and glows in the stylesheet.
  '--mint-rgb': '79, 227, 193',
  '--amber-rgb': '245, 185, 91',
  '--violet-rgb': '167, 139, 250',
  '--red-rgb': '255, 107, 107',
  // Not a custom property: the browser's own controls (scrollbars, form
  // widgets) follow it, and a light palette needs `light` to stop them
  // painting dark chrome inside white surfaces.
  'color-scheme': 'dark'
}

export const THEMES: ThemePreset[] = [
  {
    id: 'ops',
    name: 'Operations',
    blurb: 'Mint on near-black. The default watch-floor palette.',
    vars: base
  },
  {
    id: 'amber',
    name: 'Amber console',
    blurb: 'Warm amber accents, easy on the eyes for long sessions.',
    vars: {
      ...base,
      '--bg': '#0b0906',
      '--bg-deep': '#080604',
      '--surface': '#15110b',
      '--surface-2': '#1b1610',
      '--surface-3': '#221c14',
      '--line': '#2e2618',
      '--line-soft': '#241e13',
      '--line-bright': '#3d3221',
      '--text': '#f2e7d5',
      '--text-dim': '#c6b598',
      '--muted': '#96866c',
      '--faint': '#6d6151',
      '--mint': '#f5b95b',
      '--mint-dim': '#b8873a',
      '--sky': '#8fc9e8'
    }
  },
  {
    id: 'violet',
    name: 'Signal violet',
    blurb: 'Purple accent, cooler surfaces. Good for packet-level triage.',
    vars: {
      ...base,
      '--bg': '#08070e',
      '--bg-deep': '#06050b',
      '--surface': '#100e18',
      '--surface-2': '#151320',
      '--surface-3': '#1b1828',
      '--line': '#241f36',
      '--line-soft': '#1c1829',
      '--line-bright': '#332c4a',
      '--text': '#e6e2f5',
      '--text-dim': '#b3accd',
      '--muted': '#857fa3',
      '--faint': '#5f5a79',
      '--mint': '#a78bfa',
      '--mint-dim': '#7c62c9',
      '--sky': '#8ab4ff'
    }
  },
  {
    id: 'ice',
    name: 'Cold storage',
    blurb: 'Ice blue on slate. High separation for evidence review.',
    vars: {
      ...base,
      '--bg': '#060a0e',
      '--bg-deep': '#04070a',
      '--surface': '#0c141b',
      '--surface-2': '#101a23',
      '--surface-3': '#15212c',
      '--line': '#1d2c39',
      '--line-soft': '#16232e',
      '--line-bright': '#2a3f52',
      '--text': '#dceaf6',
      '--text-dim': '#a2bacd',
      '--muted': '#7591a6',
      '--faint': '#546c7e',
      '--mint': '#7dd3fc',
      '--mint-dim': '#3f9cc9',
      '--violet': '#9fb8ff'
    }
  },
  {
    id: 'mono',
    name: 'Monochrome',
    blurb: 'No colour signal at all except status red. For screenshots and print.',
    vars: {
      ...base,
      '--bg': '#0a0a0b',
      '--bg-deep': '#070708',
      '--surface': '#131315',
      '--surface-2': '#181819',
      '--surface-3': '#1f1f21',
      '--line': '#2a2a2d',
      '--line-soft': '#212123',
      '--line-bright': '#3a3a3e',
      '--text': '#ededf0',
      '--text-dim': '#b4b4ba',
      '--muted': '#87878e',
      '--faint': '#616167',
      '--mint': '#e6e6ea',
      '--mint-dim': '#9a9aa2',
      '--violet': '#c9c9d1',
      '--amber': '#d6d6dc',
      '--sky': '#a9a9b2'
    }
  },
  {
    id: 'light',
    name: 'Daylight',
    blurb: 'The same mint signal on paper white. For bright rooms and shared screens.',
    vars: {
      ...base,
      'color-scheme': 'light',
      '--bg': '#f3f5f8',
      '--bg-deep': '#e7ebf0',
      '--surface': '#ffffff',
      '--surface-2': '#f8fafb',
      '--surface-3': '#ebeff4',
      '--line': '#c6cfda',
      '--line-soft': '#e0e5eb',
      '--line-bright': '#b0bcc9',
      '--line-strong': '#93a2b3',
      '--text': '#15202b',
      '--text-dim': '#41505f',
      '--text-bright': '#0a1219',
      '--muted': '#57677a',
      '--faint': '#67768a',
      // The accents keep their hue but darken to hold contrast on white: the
      // dark palette's mint is a glow, and a glow is not readable as a link.
      '--mint': '#0c7059',
      '--mint-dim': '#187a63',
      '--mint-soft': '#07544a',
      '--violet': '#6242d8',
      '--amber': '#8a4f0c',
      '--red': '#c02b2b',
      '--red-soft': '#9e2323',
      '--danger-wash': '#fbe9e9',
      '--sky': '#1c6c96',
      '--chrome': '#ffffff',
      '--chrome-dim': '#eef1f5',
      '--well': '#ffffff',
      '--sunken': '#eef1f5',
      '--row-active': '#e6ecf3',
      '--raised': '#e1e7ee',
      '--scroll': '#b7c3d0',
      '--on-danger': '#ffffff',
      '--cloak-ink': '#2a1602',
      '--cloak-fill': 'linear-gradient(150deg, #d9a352, #b5813a)',
      '--panel-from': 'rgba(255, 255, 255, 0.94)',
      '--panel-to': 'rgba(248, 250, 251, 0.94)',
      '--panel-2': '#edf1f6',
      '--scrim-rgb': '255, 255, 255',
      '--overlay': 'rgba(23, 34, 51, 0.28)',
      '--mint-rgb': '12, 112, 89',
      '--amber-rgb': '138, 79, 12',
      '--violet-rgb': '98, 66, 216',
      '--red-rgb': '192, 43, 43'
    }
  }
]

export const DEFAULT_THEME = 'ops'

export function isThemeId(value: unknown): value is string {
  return typeof value === 'string' && THEMES.some((theme) => theme.id === value)
}

export function themeFor(value: unknown): ThemePreset {
  return THEMES.find((theme) => theme.id === value) ?? THEMES[0]!
}

/** Write a preset onto an element; returns the preset that was actually used. */
export function applyTheme(value: unknown, target: { style: CSSStyleDeclaration }): ThemePreset {
  const preset = themeFor(value)
  for (const [token, color] of Object.entries(preset.vars)) {
    target.style.setProperty(token, color)
  }
  return preset
}

/** Four representative colours for the chooser preview. */
export function themeSwatch(theme: ThemePreset): string[] {
  return [theme.vars['--bg'] ?? '#000', theme.vars['--surface-2'] ?? '#111', theme.vars['--mint'] ?? '#fff', theme.vars['--text'] ?? '#eee']
}
