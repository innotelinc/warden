// hook-mode-plan.mjs — what to do about one hook's execute bit.
//
// Split out of install-hooks.mjs so the decision can be tested without git, a
// filesystem or a clone. The installer supplies three facts and performs the
// action; this module owns the reasoning, including the rule that keeps
// `git status` clean:
//
// Restoring a bit the repository records as 100755 makes the working tree match
// HEAD, so nothing is left behind. Restoring one the repository records as
// 100644 would show up as a mode change in every status report from then on, so
// that fix is staged through `git update-index --chmod=+x` instead and becomes
// one deliberate commit.

/** The recorded mode git checks out for an executable file. */
export const EXECUTABLE_MODE = '100755'
/** The recorded mode git checks out for a plain file. */
export const PLAIN_MODE = '100644'

/**
 * @param {{ platform?: string, executable: boolean, recordedMode?: string | null }} input
 *   `executable` is whether the file on disk carries an execute bit right now;
 *   `recordedMode` is the mode git has recorded for it (`git ls-files --stage`),
 *   or null when the path is untracked.
 * @returns {{ action: 'none' | 'chmod' | 'stage' | 'chmod+stage' }}
 */
export function planHookMode({ platform = process.platform, executable, recordedMode = null } = {}) {
  // Windows has no meaningful execute bit and git does not track one there, so
  // neither chmod nor the index can help.
  if (platform === 'win32') return { action: 'none' }

  if (executable) {
    // Nothing to restore; only the record itself can be wrong.
    return recordedMode === PLAIN_MODE ? { action: 'stage' } : { action: 'none' }
  }

  // An untracked hook, or one whose recorded mode is not one we recognise
  // (a symlink, say), gets the bit and nothing else: there is either no record
  // to correct or no basis for concluding the record is wrong.
  if (recordedMode !== PLAIN_MODE) return { action: 'chmod' }
  return { action: 'chmod+stage' }
}
