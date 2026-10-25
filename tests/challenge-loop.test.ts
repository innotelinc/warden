import { describe, expect, it } from 'vitest'
import { detectChallengeLoop, loopKey, type NavigationEvent } from '../src/main/browser/challenge-loop'

/** Fixed clock so the window is exercised without waiting on real time. */
const START = 1_000_000
const at = (seconds: number): number => START + seconds * 1000
const nav = (url: string, seconds: number): NavigationEvent => ({ url, at: at(seconds) })

const amazon = 'https://www.amazon.com/gp/cart/view.html'
const challenge = 'https://www.amazon.com/errors/validateCaptcha'

describe('loopKey', () => {
  it('ignores the fragment and normalises the URL', () => {
    expect(loopKey('https://www.amazon.com/a#one')).toBe('https://www.amazon.com/a')
    expect(loopKey('https://www.amazon.com/a')).toBe('https://www.amazon.com/a')
  })

  it('ignores surfaces that are not part of the web', () => {
    expect(loopKey('warden://newtab')).toBeNull()
    expect(loopKey('about:blank')).toBeNull()
    expect(loopKey('not a url')).toBeNull()
  })
})

describe('detectChallengeLoop', () => {
  it('names the host after the same page loads three times', () => {
    const loop = detectChallengeLoop([nav(amazon, 0), nav(amazon, 3), nav(amazon, 7)], at(8))
    expect(loop).toEqual({ host: 'www.amazon.com', attempts: 3 })
  })

  it('stays silent on two loads', () => {
    expect(detectChallengeLoop([nav(amazon, 0), nav(amazon, 2)], at(3))).toBeNull()
  })

  it('stays silent when the loads are spread across minutes', () => {
    const events = [nav(amazon, 0), nav(amazon, 45), nav(amazon, 90)]
    expect(detectChallengeLoop(events, at(91))).toBeNull()
  })

  it('catches two documents handed back and forth', () => {
    const events = [nav(amazon, 0), nav(challenge, 2), nav(amazon, 4), nav(challenge, 6)]
    expect(detectChallengeLoop(events, at(7))).toEqual({ host: 'www.amazon.com', attempts: 4 })
  })

  it('counts hash differences as the same document', () => {
    const events = [nav(`${amazon}#one`, 0), nav(`${amazon}#two`, 2), nav(`${amazon}#three`, 4)]
    expect(detectChallengeLoop(events, at(5))?.attempts).toBe(3)
  })

  it('leaves a progress through distinct pages alone', () => {
    const events = [
      nav('https://example.com/', 0),
      nav('https://example.com/a', 1),
      nav('https://example.com/b', 2),
      nav('https://example.com/c', 3)
    ]
    expect(detectChallengeLoop(events, at(4))).toBeNull()
  })

  it('judges only loads on the host the tab is on', () => {
    const events = [
      nav('https://news.example/story', 0),
      nav(amazon, 1),
      nav('https://news.example/story', 2),
      nav(amazon, 3)
    ]
    expect(detectChallengeLoop(events, at(4))).toBeNull()
  })

  it('ignores internal pages mixed into the stream', () => {
    const events = [nav('warden://newtab', 0), nav('warden://newtab', 1), nav('warden://newtab', 2)]
    expect(detectChallengeLoop(events, at(3))).toBeNull()
  })
})
