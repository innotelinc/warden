import { describe, expect, it } from 'vitest'
import { buildPageMenu, isLocalMediaSource, probeMediaScript, type PageMenuInput } from '../src/main/browser/page-menu'

const base: PageMenuInput = {
  canGoBack: true,
  canGoForward: false,
  isEditable: false,
  selectionText: '',
  linkURL: '',
  mediaType: 'none',
  srcURL: '',
  hasMedia: true,
  mediaKind: null
}

const labels = (input: Partial<PageMenuInput>): string[] =>
  buildPageMenu({ ...base, ...input }).flatMap((command) =>
    command.kind === 'command' ? [command.label] : command.kind === 'role' ? [command.role] : []
  )

describe('page context menu', () => {
  it('never lists the same entry twice', () => {
    const commands = buildPageMenu({
      ...base,
      isEditable: true,
      selectionText: 'selected words',
      linkURL: 'https://example.test/a',
      mediaType: 'video',
      srcURL: 'https://cdn.example.test/clip.mp4'
    })
    const keys = commands.flatMap((command) =>
      command.kind === 'separator' ? [] : [command.kind === 'role' ? `role:${command.role}` : `cmd:${command.id}`]
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('leaves no separator dangling at the edges', () => {
    for (const input of [{}, { linkURL: 'https://example.test/a' }, { mediaType: 'video', srcURL: 'https://x/y.mp4' }]) {
      const commands = buildPageMenu({ ...base, ...input })
      expect(commands[0]!.kind).not.toBe('separator')
      expect(commands[commands.length - 1]!.kind).not.toBe('separator')
    }
  })

  it('sends the video under the cursor to Splay', () => {
    const commands = buildPageMenu({
      ...base,
      mediaType: 'video',
      srcURL: 'https://cdn.example.test/clip.mp4',
      hasMedia: true
    })
    const send = commands.find((command) => command.kind === 'command' && command.id === 'send-media')
    expect(send).toMatchObject({ label: 'Send video to Splay', enabled: true, arg: 'https://cdn.example.test/clip.mp4' })
  })

  /**
   * Custom players draw their own chrome over a hidden <video>, so Chromium
   * reports no media element at all. The item still has to be offered, and the
   * page is asked at click time.
   */
  it('still offers the hand-off when the player hid the element', () => {
    expect(labels({ hasMedia: true, mediaType: 'none' })).toContain('Send the video on this page to Splay')
    expect(labels({ hasMedia: false, mediaType: 'none' })).not.toContain('Send the video on this page to Splay')
  })

  it('says so instead of offering a hand-off that cannot work', () => {
    const commands = buildPageMenu({ ...base, mediaType: 'video', srcURL: 'blob:https://site.test/9f1a' })
    expect(commands).toContainEqual({
      kind: 'command',
      id: 'send-media',
      label: 'This video plays only in its page',
      enabled: false
    })
    expect(isLocalMediaSource('blob:https://site.test/x')).toBe(true)
    expect(isLocalMediaSource('mediasource:abc')).toBe(true)
    expect(isLocalMediaSource('https://cdn.example.test/clip.mp4')).toBe(false)
  })

  it('offers the address bar actions before anything else', () => {
    const commands = buildPageMenu(base)
    expect(commands.slice(0, 3)).toEqual([
      { kind: 'command', id: 'back', label: 'Back', enabled: true },
      { kind: 'command', id: 'forward', label: 'Forward', enabled: false },
      { kind: 'command', id: 'reload', label: 'Reload', enabled: true }
    ])
  })

  it('uses the page probe to find media at a point', () => {
    const script = probeMediaScript(120.4, 64.6)
    expect(script).toContain('elementsFromPoint(120, 65)')
    expect(script).toContain("tag !== 'VIDEO'")
  })
})
