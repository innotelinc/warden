import { describe, expect, it } from 'vitest'
import { buildChromeMenu } from '../src/main/chrome-menu'

type Flags = Parameters<typeof buildChromeMenu>[0]['editFlags']

const flags = (overrides: Partial<Flags> = {}): Flags =>
  ({
    canUndo: false,
    canRedo: false,
    canCut: false,
    canCopy: false,
    canPaste: true,
    canDelete: false,
    canSelectAll: true,
    canEditRichly: false,
    ...overrides
  }) as Flags

const roles = (template: ReturnType<typeof buildChromeMenu>): string[] =>
  template.map((item) => item.role ?? item.type ?? '')

describe('chrome context menu', () => {
  it('offers paste in an editable field such as the address bar', () => {
    const menu = buildChromeMenu({ isEditable: true, selectionText: '', editFlags: flags() })
    expect(roles(menu)).toEqual(
      expect.arrayContaining(['undo', 'redo', 'cut', 'copy', 'paste', 'pasteAndMatchStyle', 'delete', 'selectAll'])
    )
    const paste = menu.find((item) => item.role === 'paste')
    expect(paste?.enabled).toBe(true)
  })

  it('disables paste when the clipboard cannot be used', () => {
    const menu = buildChromeMenu({
      isEditable: true,
      selectionText: '',
      editFlags: flags({ canPaste: false })
    })
    expect(menu.find((item) => item.role === 'paste')?.enabled).toBe(false)
    expect(menu.find((item) => item.role === 'pasteAndMatchStyle')?.enabled).toBe(false)
  })

  it('mirrors selection state in cut and copy', () => {
    const empty = buildChromeMenu({ isEditable: true, selectionText: '', editFlags: flags() })
    expect(empty.find((item) => item.role === 'copy')?.enabled).toBe(false)
    expect(empty.find((item) => item.role === 'cut')?.enabled).toBe(false)

    const selected = buildChromeMenu({
      isEditable: true,
      selectionText: 'https://example.test',
      editFlags: flags({ canCopy: true, canCut: true })
    })
    expect(selected.find((item) => item.role === 'copy')?.enabled).toBe(true)
    expect(selected.find((item) => item.role === 'cut')?.enabled).toBe(true)
  })

  it('offers only copy for a read-only selection', () => {
    const menu = buildChromeMenu({
      isEditable: false,
      selectionText: 'blocked 412 requests',
      editFlags: flags({ canCopy: true })
    })
    expect(roles(menu)).toEqual(['copy', 'selectAll'])
    expect(menu.some((item) => item.role === 'paste')).toBe(false)
  })

  it('shows nothing over empty chrome', () => {
    expect(buildChromeMenu({ isEditable: false, selectionText: '', editFlags: flags() })).toEqual([])
    expect(buildChromeMenu({ isEditable: false, selectionText: '   ', editFlags: flags() })).toEqual([])
  })
})
