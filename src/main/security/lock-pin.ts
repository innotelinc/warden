/**
 * Store and check the WARDEN PIN.
 *
 * The PIN never reaches disk in a readable form: it is salted and run through
 * scrypt, and only `scrypt$<salt>$<key>` is persisted. Verification recomputes
 * the key and compares it in constant time, so a wrong PIN cannot be narrowed
 * down by timing the answer.
 *
 * Nothing here can unlock anything by itself: a malformed or unreadable record
 * fails closed, exactly like an unreadable Hello container.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { normalizePin } from '@shared/lock-pin'

const scryptAsync = promisify(scrypt)
const SCHEME = 'scrypt'
const SALT_BYTES = 16
const KEY_BYTES = 32

/** Salted scrypt of a PIN, in the only shape `verifyPin` accepts. */
export async function hashPin(pin: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const key = (await scryptAsync(normalizePin(pin), salt, KEY_BYTES)) as Buffer
  return `${SCHEME}$${salt.toString('hex')}$${key.toString('hex')}`
}

/**
 * Does `pin` match `stored`? Anything unexpected — a blank pin, a record from
 * another scheme, a truncated salt — resolves false rather than throwing.
 */
export async function verifyPin(pin: string, stored: string | null): Promise<boolean> {
  if (typeof pin !== 'string' || !pin || !stored) return false
  const [scheme, saltHex, keyHex] = stored.split('$')
  if (scheme !== SCHEME || !saltHex || !keyHex) return false

  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  if (salt.length !== SALT_BYTES || expected.length !== KEY_BYTES) return false

  let actual: Buffer
  try {
    actual = (await scryptAsync(normalizePin(pin), salt, expected.length)) as Buffer
  } catch {
    return false
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
