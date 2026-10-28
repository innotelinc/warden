import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * Fullscreen is decided in three places and none of them can be exercised
 * headlessly: the page emits the request, the window owns the screen, and the
 * renderer owns the rectangle a native tab view occupies. A page's own
 * fullscreen button used to do nothing because only the first of the three was
 * true, so what is checked here is that all three still line up.
 */
const read = (path: string): string => readFileSync(path, 'utf8')

describe('video fullscreen', () => {
  it('hears the page ask for it, on the tab that asked', () => {
    const tabs = read('src/main/browser/tabs.ts')
    expect(tabs).toContain("wc.on('enter-html-full-screen'")
    expect(tabs).toContain('this.hooks.onFullscreen(tab.id, true)')
    expect(tabs).toContain("wc.on('leave-html-full-screen'")
    expect(tabs).toContain('this.hooks.onFullscreen(tab.id, false)')
    // A closed tab must not leave the window fullscreen.
    expect(tabs).toContain('this.hooks.onFullscreen(tab.id, false)')
  })

  it('takes the window with it, and gives it back', () => {
    const index = read('src/main/index.ts')
    expect(index).toContain('browserWindow.setFullScreen(true)')
    expect(index).toContain('browserWindow.setFullScreen(false)')
    // Only a window WARDEN took fullscreen is given back; F11 was the
    // operator's decision, not the page's.
    expect(index).toContain('fullscreenByPage')
    expect(index).toContain('document.exitFullscreen')
  })

  it('reports which tab has the screen', () => {
    const types = read('src/shared/types.ts')
    expect(types).toContain('fullscreenTabId: string | null')
    const index = read('src/main/index.ts')
    expect(index).toContain('fullscreenTabId: fullscreenTabId && tabs.getWebContents(fullscreenTabId)')
  })

  it('gives the tab every pixel, which is what hides the chrome', () => {
    const app = read('src/renderer/src/App.tsx')
    expect(app).toContain('const htmlFullscreen = Boolean(')
    expect(app).toContain('if (htmlFullscreen) {')
    expect(app).toContain('height: rect.height }')
    expect(app).toContain('mediaBounds: [],')
  })
})
