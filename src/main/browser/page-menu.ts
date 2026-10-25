/**
 * The right-click menu for a page tab, as data.
 *
 * Electron needs a template of real MenuItem objects, which cannot be inspected
 * without popping a window up. So the shape is decided here — pure, ordered and
 * de-duplicated — and the tab turns each command into a menu item.
 *
 * Two things this has to get right:
 *
 *   - No repeated entries. A menu that lists "Copy" twice reads like the app
 *     stuttered, and an operator who clicks the wrong twin has no way to know
 *     which one acted.
 *   - The media hand-off has to be honest. Splay opens the source in its own
 *     view, so a `blob:` or `MediaSource` stream — what every custom player
 *     uses — cannot be handed over: the URL only resolves inside the document
 *     that created it. Offering the item anyway produced a black dock that
 *     looked like Splay was broken. It is shown disabled, with the reason,
 *     instead.
 */

export type PageMenuAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'open-link'
  | 'copy-link'
  | 'send-media'
  | 'copy-image'
  | 'copy-image-url'
  | 'scry'
  | 'inspect'

export type PageMenuRole =
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'pasteAndMatchStyle'
  | 'delete'
  | 'selectAll'

export type PageMenuCommand =
  | { kind: 'separator' }
  | { kind: 'role'; role: PageMenuRole }
  | { kind: 'command'; id: PageMenuAction; label: string; enabled: boolean; arg?: string }

export interface PageMenuInput {
  canGoBack: boolean
  canGoForward: boolean
  isEditable: boolean
  selectionText: string
  linkURL: string
  mediaType: string
  srcURL: string
  /** The tab has at least one playable element, found by the page preload. */
  hasMedia: boolean
  /** Kind of the media under the cursor, when the page could name one. */
  mediaKind: 'video' | 'audio' | null
}

/**
 * True when a media URL is bound to the document that created it. Chromium
 * resolves `blob:` and `mediasource:` through the origin that opened them, so a
 * separate viewer gets nothing.
 */
export function isLocalMediaSource(url: string): boolean {
  return /^(blob|mediasource|data):/i.test(url.trim())
}

function dedupe(commands: PageMenuCommand[]): PageMenuCommand[] {
  const seen = new Set<string>()
  const out: PageMenuCommand[] = []
  for (const command of commands) {
    if (command.kind === 'separator') {
      // Collapse runs of separators and drop leading/trailing ones: an empty
      // section should not leave a rule behind.
      if (!out.length || out[out.length - 1]!.kind === 'separator') continue
      out.push(command)
      continue
    }
    const key = command.kind === 'role' ? `role:${command.role}` : `cmd:${command.id}:${command.arg ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(command)
  }
  while (out.length && out[out.length - 1]!.kind === 'separator') out.pop()
  return out
}

export function buildPageMenu(input: PageMenuInput): PageMenuCommand[] {
  const commands: PageMenuCommand[] = [
    { kind: 'command', id: 'back', label: 'Back', enabled: input.canGoBack },
    { kind: 'command', id: 'forward', label: 'Forward', enabled: input.canGoForward },
    { kind: 'command', id: 'reload', label: 'Reload', enabled: true },
    { kind: 'separator' }
  ]

  // Editing roles act on whatever field has focus in the page. Without them a
  // right click could only copy a selection and nothing could be pasted into a
  // form.
  if (input.isEditable) {
    commands.push(
      { kind: 'role', role: 'undo' },
      { kind: 'role', role: 'redo' },
      { kind: 'separator' },
      { kind: 'role', role: 'cut' },
      { kind: 'role', role: 'copy' },
      { kind: 'role', role: 'paste' },
      { kind: 'role', role: 'pasteAndMatchStyle' },
      { kind: 'role', role: 'delete' },
      { kind: 'separator' },
      { kind: 'role', role: 'selectAll' },
      { kind: 'separator' }
    )
  } else if (input.selectionText.trim().length > 0) {
    commands.push({ kind: 'role', role: 'copy' }, { kind: 'role', role: 'selectAll' }, { kind: 'separator' })
  }

  if (input.linkURL) {
    commands.push(
      { kind: 'command', id: 'open-link', label: 'Open link in new tab', enabled: true, arg: input.linkURL },
      { kind: 'command', id: 'copy-link', label: 'Copy link address', enabled: true, arg: input.linkURL },
      { kind: 'separator' }
    )
  }

  const kind = input.mediaKind ?? (input.mediaType === 'video' || input.mediaType === 'audio' ? input.mediaType : null)
  if (kind) {
    const noun = kind === 'audio' ? 'audio' : 'video'
    if (input.srcURL && isLocalMediaSource(input.srcURL)) {
      commands.push({
        kind: 'command',
        id: 'send-media',
        label: `This ${noun} plays only in its page`,
        enabled: false
      })
    } else {
      commands.push({
        kind: 'command',
        id: 'send-media',
        label: input.srcURL ? `Send ${noun} to Splay` : `Send the ${noun} on this page to Splay`,
        enabled: true,
        arg: input.srcURL || undefined
      })
    }
    commands.push({ kind: 'separator' })
  } else if (input.hasMedia) {
    // The player hid the element behind its own overlay, so no element was
    // named. Ask the page at click time rather than making the operator hunt
    // for the coordinates where WARDEN would have noticed.
    commands.push(
      { kind: 'command', id: 'send-media', label: 'Send the video on this page to Splay', enabled: true },
      { kind: 'separator' }
    )
  }

  if (input.mediaType === 'image' && input.srcURL) {
    commands.push(
      { kind: 'command', id: 'copy-image', label: 'Copy image', enabled: true },
      { kind: 'command', id: 'copy-image-url', label: 'Copy image address', enabled: true, arg: input.srcURL },
      { kind: 'separator' }
    )
  }

  commands.push(
    { kind: 'command', id: 'scry', label: 'Scry this page', enabled: true },
    { kind: 'command', id: 'inspect', label: 'Inspect element', enabled: true }
  )

  return dedupe(commands)
}

/**
 * What the page should answer when the menu asks it for the media under the
 * cursor. Runs in the page, so it is plain JavaScript as a string.
 */
export function probeMediaScript(x: number, y: number): string {
  return `(() => {
    const media = (el) => {
      if (!el || !el.tagName) return null;
      const tag = el.tagName.toUpperCase();
      if (tag !== 'VIDEO' && tag !== 'AUDIO') return null;
      return { src: el.currentSrc || el.src || '', kind: tag === 'VIDEO' ? 'video' : 'audio' };
    };
    const stack = (document.elementsFromPoint(${Math.round(x)}, ${Math.round(y)}) || []);
    for (const el of stack) {
      const found = media(el);
      if (found) return found;
    }
    for (const el of document.querySelectorAll('video, audio')) {
      const found = media(el);
      if (found) return found;
    }
    return null;
  })()`
}
