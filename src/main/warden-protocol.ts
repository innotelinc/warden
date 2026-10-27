/**
 * WARDEN's own scheme, on every session that opens one.
 *
 * `protocol.handle` binds a scheme to a single session, and WARDEN does not run
 * its pages in the default one: a browsing tab gets `warden-browse`, a cloak tab
 * gets its own throwaway partition, and Splay's viewer runs in the session of
 * the tab it came from. A handler registered once on the module-level
 * `protocol` therefore answers for the app window and for nothing else, which is
 * how the media dock ended up with a blank pane — its viewer could not resolve
 * `warden://viewer`.
 *
 * The handler is set once, early, and every session that matters is registered
 * on demand. Registration is idempotent per session, so a caller can ask as
 * often as it likes without stacking handlers.
 */
import type { Session } from 'electron'

type WardenHandler = (request: Request) => Promise<Response>

let handler: WardenHandler | null = null
const registered = new WeakSet<Session>()

/** Called once, as soon as the handler exists. */
export function setWardenHandler(fn: WardenHandler): void {
  handler = fn
}

/** Make `ses` able to resolve `warden://`. Safe to call on every use. */
export function ensureWardenProtocol(ses: Session | null | undefined): boolean {
  if (!ses || !handler) return false
  if (registered.has(ses)) return true
  try {
    ses.protocol.handle('warden', handler)
  } catch {
    // A session that refuses the scheme (already gone, or not a real session)
    // simply keeps its previous behaviour.
    return false
  }
  registered.add(ses)
  return true
}
