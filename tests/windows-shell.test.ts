import { describe, expect, it } from 'vitest'
import {
  JUMP_PRIVATE_TAB,
  JUMP_TAB,
  jumpListTasks,
  shellAction
} from '../src/main/desktop/windows-shell'

/**
 * The taskbar menu is the Windows feature: right-click the icon, ask for a tab.
 * Windows answers by launching the executable with a switch, so the command line
 * is the whole interface — and a second launch must not become a second app.
 */
describe('the Windows taskbar menu', () => {
  it('offers a tab and a private tab', () => {
    const tasks = jumpListTasks()
    const titles = tasks.map((task) => (task as { title?: string }).title)
    expect(titles).toEqual(['New tab', 'New private tab'])
    const args = tasks.map((task) => (task as { args?: string }).args)
    expect(args).toEqual([JUMP_TAB, JUMP_PRIVATE_TAB])
  })

  it('names an executable for every entry', () => {
    for (const task of jumpListTasks()) {
      expect((task as { program?: string }).program).toBeTruthy()
    }
  })

  it('reads the switch a launch carries', () => {
    expect(shellAction(['WARDEN.exe'])).toBe(null)
    expect(shellAction(['WARDEN.exe', '--some-other-switch'])).toBe(null)
    expect(shellAction(['WARDEN.exe', JUMP_TAB])).toBe('new-tab')
    expect(shellAction(['WARDEN.exe', JUMP_PRIVATE_TAB])).toBe('new-private-tab')
  })

  it('prefers the private tab when both switches appear', () => {
    expect(shellAction([JUMP_TAB, JUMP_PRIVATE_TAB])).toBe('new-private-tab')
  })
})
