import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Splay's failure modes are native ones — a `WebContentsView` that never paints
 * and a page that keeps its player — so what can be checked here is the wiring
 * that decides them. Each assertion below stands for a symptom the operator
 * reported: blank panes, and a video that "moved" but kept playing.
 */
const read = (path: string): string => readFileSync(path, 'utf8')

describe('the Splay dock', () => {
  it('lets the docked viewer start playing without a second gesture', () => {
    const dock = read('src/main/media/media-dock.ts')
    // `user-gesture-required` refused the viewer's own play() — no programme,
    // no error — and the pane stayed black.
    expect(dock).toContain("autoplayPolicy: 'no-user-gesture-required'")
  })

  it('says so when a source never sends a frame', () => {
    const page = read('src/main/internal-pages.ts')
    expect(page).toContain('No picture yet')
    expect(page).toContain('video.readyState >= 2')
  })

  it('finds the player by any URL it answers to, not one spelling', () => {
    const preload = read('src/preload/page.ts')
    expect(preload).toContain('function mediaUrls(')
    // Registered under currentSrc, src and every <source>.
    expect(preload).toContain('for (const alias of mediaUrls(element)) elementsByUrl.set(alias, element)')
  })

  it('still detaches when the player renamed its source or is the only one', () => {
    const preload = read('src/preload/page.ts')
    expect(preload).toContain('function elementForDetach(')
    expect(preload).toContain('const renamed = all.find')
    // A page with one player leaves no ambiguity to resolve.
    expect(preload).toContain('all.length === 1 ? all[0]! : null')
  })
})
