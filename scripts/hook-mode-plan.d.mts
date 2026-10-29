export declare const EXECUTABLE_MODE: '100755'
export declare const PLAIN_MODE: '100644'

export type HookModeAction = 'none' | 'chmod' | 'stage' | 'chmod+stage'

export interface HookModeInput {
  platform?: string
  executable: boolean
  recordedMode?: string | null
}

export declare function planHookMode(input?: HookModeInput): { action: HookModeAction }
