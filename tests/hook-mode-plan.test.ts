import { describe, expect, it } from 'vitest'
import { planHookMode } from '../scripts/hook-mode-plan.mjs'

/** The decision for one hook, in one line. */
const decide = (executable: boolean, recordedMode: string | null, platform = 'linux'): string =>
  planHookMode({ platform, executable, recordedMode }).action

describe('hook mode plan', () => {
  it('leaves alone a hook whose bit matches the record', () => {
    expect(decide(true, '100755')).toBe('none')
  })

  it('restores a lost bit without staging when the record is already correct', () => {
    // The ordinary case: a zip download or an archive restore dropped the bit,
    // git still records 100755, so chmod alone leaves `git status` clean.
    expect(decide(false, '100755')).toBe('chmod')
  })

  it('stages the fix when the repository itself records a plain file', () => {
    // Staging is what stops the mode change trailing every status report.
    expect(decide(false, '100644')).toBe('chmod+stage')
  })

  it('fixes the record alone when the file is executable but recorded plain', () => {
    expect(decide(true, '100644')).toBe('stage')
  })

  it('chmods a hook git does not track yet', () => {
    expect(decide(false, null)).toBe('chmod')
    expect(decide(false, '120000')).toBe('chmod')
  })

  it('does nothing on windows, where git records no execute bit', () => {
    expect(decide(false, '100644', 'win32')).toBe('none')
    expect(decide(false, '100755', 'win32')).toBe('none')
    expect(decide(true, '100644', 'win32')).toBe('none')
  })

  it('never stages and chmods on the same file without a plain record', () => {
    for (const recorded of ['100755', null, '120000']) {
      expect(decide(false, recorded)).not.toBe('chmod+stage')
    }
  })
})
