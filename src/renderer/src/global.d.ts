import type { WardenApi } from '@shared/types'

declare global {
  interface Window {
    warden: WardenApi
  }
}

export {}
