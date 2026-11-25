/**
 * The rail's glyphs, drawn the way the desktop draws them.
 *
 * The shell mirrors the desktop's workspace rail, so the icons have to be the
 * same shapes rather than a store icon set: a terminal is a prompt, Scry is a
 * crosshair, policy is a gear. Stroke-only so one set works on the dark chrome
 * and on the lighter row it sits in when active.
 */

interface GlyphProps {
  size?: number
}

const base = (size: number): { width: number; height: number; viewBox: string; fill: string; stroke: string; strokeWidth: number; strokeLinecap: 'round'; strokeLinejoin: 'round' } => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.7,
  strokeLinecap: 'round',
  strokeLinejoin: 'round'
})

export function IconShield({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M12 3l7 2.6v5.9c0 4.3-2.9 7.2-7 8.5-4.1-1.3-7-4.2-7-8.5V5.6L12 3z" />
    </svg>
  )
}

export function IconTerminal({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </svg>
  )
}

export function IconMail({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3.5 7.5L12 13l8.5-5.5" />
    </svg>
  )
}

export function IconChat({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M20 12.5c0 3.3-3.6 6-8 6-1 0-2-.1-2.9-.4L5 20l1.2-3.1A5.6 5.6 0 014 12.5c0-3.3 3.6-6 8-6s8 2.7 8 6z" />
    </svg>
  )
}

export function IconCrosshair({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      <circle cx="12" cy="12" r="1.6" />
    </svg>
  )
}

export function IconSpark({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M12 3l1.8 4.9L19 9.7l-5.2 1.8L12 16.4l-1.8-4.9L5 9.7l5.2-1.8L12 3z" />
      <path d="M18 16l.9 2.3 2.1.7-2.1.7L18 22l-.9-2.3-2.1-.7 2.1-.7L18 16z" />
    </svg>
  )
}

export function IconGear({ size = 16 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.6V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.6-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.6-1.1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H10a1.7 1.7 0 001-1.6V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.6 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V10a1.7 1.7 0 001.6 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </svg>
  )
}

export function IconLock({ size = 14 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <rect x="4.5" y="10" width="15" height="10" rx="2" />
      <path d="M8 10V7.5a4 4 0 018 0V10" />
    </svg>
  )
}

export function IconCommand({ size = 14 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M6 3.5A2.5 2.5 0 108.5 6v12A2.5 2.5 0 106 15.5h12A2.5 2.5 0 1015.5 18V6A2.5 2.5 0 1018 8.5H6" />
    </svg>
  )
}

export function IconArrowRight({ size = 13 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M4 12h15M14 7l5 5-5 5" />
    </svg>
  )
}

export function IconClose({ size = 12 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function IconGlobe({ size = 13 }: GlyphProps): React.ReactElement {
  return (
    <svg {...base(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
    </svg>
  )
}
