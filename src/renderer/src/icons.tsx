import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Icon({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconShield = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3 5 6v6c0 4.2 3 7.5 7 9 4-1.5 7-4.8 7-9V6l-7-3Z" />
    <path d="m9 12 2 2 4-4" />
  </Icon>
)

export const IconTerminal = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="m7 9 3 3-3 3M13 15h4" />
  </Icon>
)

export const IconMail = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 7 9 6 9-6" />
  </Icon>
)

export const IconChat = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 15a3 3 0 0 1-3 3H8l-4 3v-4.2A3 3 0 0 1 3 15V7a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v8Z" />
    <path d="M8 10h8M8 13.5h5" />
  </Icon>
)

export const IconCrosshair = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="2.2" />
    <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
  </Icon>
)

export const IconGear = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.56 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10 3.04V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1Z" />
  </Icon>
)

export const IconBack = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 5 8 12l7 7" />
  </Icon>
)

export const IconForward = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 5 7 7-7 7" />
  </Icon>
)

export const IconReload = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 11a8 8 0 1 0-2.3 5.7" />
    <path d="M20 4v7h-7" />
  </Icon>
)

export const IconClose = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
)

export const IconPlus = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
)

export const IconStar = ({ filled, ...props }: IconProps & { filled?: boolean }) => (
  <Icon {...props} fill={filled ? 'currentColor' : 'none'}>
    <path d="m12 3.6 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.5 9.8l5.9-.9L12 3.6Z" />
  </Icon>
)

export const IconLock = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10" width="15" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </Icon>
)

export const IconUnlock = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4.5" y="10" width="15" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 7.5-1.8" />
  </Icon>
)

export const IconAlert = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4 3 20h18L12 4Z" />
    <path d="M12 10v4M12 17h.01" />
  </Icon>
)

export const IconPanelRight = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M15 4v16" />
  </Icon>
)

export const IconBug = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 7a4 4 0 0 1 8 0v2a5 5 0 0 1-8 0V7Z" />
    <path d="M6 12H3M21 12h-3M7 17l-2 2M17 17l2 2M12 14v6" />
  </Icon>
)

export const IconFolder = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  </Icon>
)

export const IconDownload = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v10m0 0 4-4m-4 4-4-4" />
    <path d="M4 18h16" />
  </Icon>
)

export const IconSearch = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4 4" />
  </Icon>
)

export const IconTrash = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
  </Icon>
)

export const IconSend = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 3 10.5 13.5M21 3l-6.5 18-4-8-8-4L21 3Z" />
  </Icon>
)

export const IconPlay = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <path d="M8 5.5v13l11-6.5L8 5.5Z" />
  </Icon>
)

export const IconPause = (props: IconProps) => (
  <Icon {...props} fill="currentColor" stroke="none">
    <rect x="7" y="5" width="3.5" height="14" rx="1" />
    <rect x="13.5" y="5" width="3.5" height="14" rx="1" />
  </Icon>
)

export const IconVolume = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 10v4h3l4 3V7L8 10H5Z" />
    <path d="M16 9.5a3.5 3.5 0 0 1 0 5M18.5 7a7 7 0 0 1 0 10" />
  </Icon>
)

export const IconVolumeOff = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 10v4h3l4 3V7L8 10H5Z" />
    <path d="m16 10 4 4m0-4-4 4" />
  </Icon>
)

export const IconMenu = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
)

export const IconArrowRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12h14m0 0-6-6m6 6-6 6" />
  </Icon>
)

export const IconSpark = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" />
  </Icon>
)
