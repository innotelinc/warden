/**
 * The WARDEN PIN: a local way into the lock screen.
 *
 * The lock screen could only ever be cleared by Windows — Hello, or the account
 * password through `LogonUser`. Neither exists on a local account that has no
 * Hello enrolment and no password to type, and on the machines where the
 * verifier itself is broken the screen had no way in at all. This PIN belongs
 * to WARDEN: the operator sets it once, it is stored as a salted scrypt hash,
 * and it unlocks this screen without involving the OS account at all.
 *
 * It is a desk lock, not disk encryption: anyone with the Windows account can
 * read WARDEN's data anyway. What it stops is the unattended machine.
 */

/** Short enough to type under pressure, long enough to not be a typo away. */
export const PIN_MIN = 4
export const PIN_MAX = 10

/**
 * `1234` typed on a numeric keypad and `1234` pasted from a note are the same
 * PIN. Whitespace is stripped rather than rejected so a pasted `1 2 3 4` is
 * not a different credential from the one that was saved.
 */
export function normalizePin(value: string): string {
  return value.replace(/\s+/g, '')
}

/**
 * Why this PIN cannot be saved, or `null` when it can.
 *
 * Only digits: the field is a numeric one, and anything else is a keypad
 * problem the operator cannot see while the screen is covered.
 */
export function pinProblem(value: string): string | null {
  const pin = normalizePin(value)
  if (!pin) return 'Enter a PIN.'
  if (!/^\d+$/.test(pin)) return 'A PIN is digits only.'
  if (pin.length < PIN_MIN) return `Use at least ${PIN_MIN} digits.`
  if (pin.length > PIN_MAX) return `Use at most ${PIN_MAX} digits.`
  return null
}
