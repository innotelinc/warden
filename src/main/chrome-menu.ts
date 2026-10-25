import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

/**
 * The context menu for WARDEN's own interface (address bar, find field, search
 * boxes in the workspaces).
 *
 * Page tabs have had a menu since the beginning; the chrome did not, so right
 * clicking the address bar did nothing at all and a URL could not be pasted
 * with the mouse. The roles are the same ones the application menu registers,
 * so a menu item and Ctrl+V do exactly the same thing.
 *
 * The shape is pure and returned as a template so it can be tested without a
 * window: an empty array means "show no menu".
 */
export function buildChromeMenu(
  params: Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags'>
): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  const editable = params.isEditable

  if (editable) {
    return [
      { role: 'undo', enabled: flags.canUndo },
      { role: 'redo', enabled: flags.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: flags.canCut },
      { role: 'copy', enabled: flags.canCopy },
      { role: 'paste', enabled: flags.canPaste },
      { role: 'pasteAndMatchStyle', enabled: flags.canPaste },
      { role: 'delete', enabled: flags.canDelete },
      { type: 'separator' },
      { role: 'selectAll', enabled: flags.canSelectAll }
    ]
  }

  if ((params.selectionText ?? '').trim().length > 0) {
    return [{ role: 'copy', enabled: flags.canCopy }, { role: 'selectAll', enabled: flags.canSelectAll }]
  }

  return []
}
