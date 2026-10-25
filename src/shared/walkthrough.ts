/**
 * The first-launch walkthrough.
 *
 * WARDEN refuses things most browsers allow, so a first run that says nothing
 * looks broken: no cookies, an encrypted resolver, a splash instead of a
 * homepage. This is the one place that explains the posture, points at the
 * switches, and hands over the shortcuts worth knowing.
 *
 * Shown once — `walkthroughSeen` in settings is the gate — and reachable again
 * from the command palette, so it can never ambush an operator twice.
 *
 * The steps live in shared/ so the renderer and the tests read one list: a step
 * that no longer matches the product fails a test instead of shipping stale.
 */

export interface WalkthroughStep {
  id: string
  title: string
  body: string
  /** Where the thing lives, shown as a locator line. */
  where?: string
}

export const WALKTHROUGH_STEPS: readonly WalkthroughStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to WARDEN',
    body: 'A browser that refuses by default: no cookies unless a site is allowed, trackers and ads filtered, DNS encrypted, and every tab held in memory only. Nothing here asks for an account, and nothing is written to disk behind your back.',
    where: 'the shield beside the address bar shows what a page tried to load'
  },
  {
    id: 'switches',
    title: 'Three switches, one click each',
    body: 'Privacy suspends the stack for the current host (amber means suspended), cookies allow or revoke that host in memory, and genie turns the automatic fraud read of opened mail on or off. Each reflects live state, and each is also in the shield panel.',
    where: 'address bar → privacy · cookies · genie'
  },
  {
    id: 'cloak',
    title: 'The cape on every tab is Cloak',
    body: 'Cloak on means that tab has its own throwaway session, discarded when it closes. Turn it off to share the browsing session, or on again for isolation. Switching reloads the page in a new tab, because a session cannot change under a live document.',
    where: 'the cape at the right edge of each tab'
  },
  {
    id: 'workspaces',
    title: 'One window, six workspaces',
    body: 'Browse for the web, Trench for a real PTY and ssh, Relay for IMAP/SMTP mail, Concourse for messaging services, Scry for recon, and Policy for every switch in the product. Each service runs in its own isolated session.',
    where: 'Ctrl+1 … Ctrl+6'
  },
  {
    id: 'genie',
    title: 'Genie reads, it does not act',
    body: 'The assistant can look at the page in front of you, this session’s counters and the last Scry capture — nothing else, and it cannot change a setting or run a command. With the genie switch on, opened mail is read for fraud and phishing, and the verdict sits under the headers.',
    where: 'Genie key: Policy → Genie, or INNOTEL_GATEWAY_KEY'
  },
  {
    id: 'scry',
    title: 'Scry takes a site apart',
    body: 'Capture the page as the browser sees it: technology stack, tracker hosts, request mix, missing security headers and cookies. From there, clone it for study or innovate on it — all in a workspace you can close without touching the live tab.',
    where: 'Ctrl+Shift+S, or the crosshair in the toolbar'
  },
  {
    id: 'keyboard',
    title: 'The keyboard does the rest',
    body: 'Palette for every action, address bar, find in page, the Trench drawer, the Splay media dock, and the lock screen that drops the window behind your Windows password when you walk away.',
    where: 'Ctrl+K · Ctrl+L · Ctrl+F · Ctrl+` · Ctrl+J · Ctrl+\\'
  },
  {
    id: 'yours',
    title: 'Every default is yours to change',
    body: 'The allowlist, compatibility list, filters, resolver, tunnel endpoint, sensor treatment, cloak default and lock timeout all live in Policy. No telemetry leaves the app. Run this walkthrough again any time from the palette.',
    where: 'Ctrl+K → “Show the walkthrough”'
  }
]

/** The tour is due only before it has ever been finished or skipped. */
export function walkthroughDue(seen: boolean | undefined): boolean {
  return seen !== true
}
