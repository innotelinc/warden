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
  '--sky': '#7dd3fc'
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
