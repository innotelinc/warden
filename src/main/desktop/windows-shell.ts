/**
 * The parts of WARDEN that only exist on Windows.
 *
 * The taskbar's own menu — the jump list — is how Windows operators start an
 * app they already keep pinned: right-click the icon and ask for what they
 * want. A jump-list task is not a message to the running app; Windows launches
 * the executable again with the switch the task carries. So the switch names
 * live here beside the menu that emits them, and the main process turns them
 * into tabs instead of a second window.
 *
 * Kept free of Electron calls so the command-line decision can be tested
 * without a window: `jumpListTasks` is the only part that touches the process,
 * and only to name its own executable.
 */

/** Ask the running instance for a tab. */
export const JUMP_TAB = '--warden-tab'
/** Ask the running instance for a tab that keeps nothing. */
export const JUMP_PRIVATE_TAB = '--warden-private-tab'

export type ShellAction = 'new-tab' | 'new-private-tab' | null

/**
 * What a command line asks for.
 *
 * The private switch wins when both appear: it is the stronger promise, and a
 * tab that was meant to leave nothing behind must not be the shared one.
 */
export function shellAction(argv: readonly string[]): ShellAction {
  if (argv.includes(JUMP_PRIVATE_TAB)) return 'new-private-tab'
  if (argv.includes(JUMP_TAB)) return 'new-tab'
  return null
}

/** The taskbar entries, in the order Windows lists them. */
export function jumpListTasks(): Electron.JumpListItem[] {
  return [
    {
      type: 'task',
      title: 'New tab',
      description: 'Open a tab in WARDEN',
      program: process.execPath,
      args: JUMP_TAB,
      iconPath: process.execPath,
      iconIndex: 0
    },
    {
      type: 'task',
      title: 'New private tab',
      description: 'Open a tab that writes nothing to disk',
      program: process.execPath,
      args: JUMP_PRIVATE_TAB,
      iconPath: process.execPath,
      iconIndex: 0
    }
  ]
}
