/**
 * When the idle timer may cover the screen.
 *
 * Kept out of the Electron service so the rule can be tested without a
 * display: the timer is the kind of code that quietly stops working when a
 * setting is 0 or the app is already locked.
 */

export const LOCK_TIMEOUTS = [0, 1, 5, 15, 30, 60] as const

export interface LockDecisionInput {
  /** Seconds since the last keyboard or mouse input, system wide. */
  idleSeconds: number
  /** Setting value in minutes; 0 disables the timer. */
  timeoutMinutes: number
  locked: boolean
}

export function shouldAutoLock(input: LockDecisionInput): boolean {
  if (input.locked) return false
  if (!Number.isFinite(input.timeoutMinutes) || input.timeoutMinutes <= 0) return false
  if (!Number.isFinite(input.idleSeconds)) return false
  return input.idleSeconds >= input.timeoutMinutes * 60
}

export function timeoutLabel(minutes: number): string {
  if (!minutes) return 'Never'
  if (minutes === 1) return '1 minute'
  if (minutes === 60) return '1 hour'
  return `${minutes} minutes`
}
