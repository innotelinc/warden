import { useEffect, useState } from 'react'
import { WALKTHROUGH_STEPS } from '@shared/walkthrough'

/**
 * The first-launch tour.
 *
 * It renders over the window chrome while the native page views are suppressed
 * — the renderer cannot draw over them — so it has to be dismissible three
 * ways: Esc, a click on the backdrop, or Skip. However it closes, the caller
 * records that it has been seen.
 */
export function Walkthrough({ onDone }: { onDone: () => void }) {
  const [index, setIndex] = useState(0)
  const last = index === WALKTHROUGH_STEPS.length - 1
  const step = WALKTHROUGH_STEPS[index]

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDone()
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        setIndex((current) => Math.min(WALKTHROUGH_STEPS.length - 1, current + 1))
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        setIndex((current) => Math.max(0, current - 1))
      }
      // Enter advances, and on the last step finishes. A tour whose only way
      // forward is a button at the bottom of a clipped dialog is a dead end.
      if (event.key === 'Enter') {
        event.preventDefault()
        setIndex((current) => {
          if (current >= WALKTHROUGH_STEPS.length - 1) {
            onDone()
            return current
          }
          return current + 1
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onDone])

  if (!step) return null

  return (
    <div className="overlay" onClick={onDone} role="presentation">
      <div
        className="walkthrough"
        role="dialog"
        aria-modal="true"
        aria-label="WARDEN walkthrough"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="walkthrough-head">
          <span className="tag mint">first launch</span>
          <span className="spacer" />
          <span className="faint tiny">
            {index + 1} / {WALKTHROUGH_STEPS.length}
          </span>
        </div>

        <div className="walkthrough-body">
          <h2>{step.title}</h2>
          <p>{step.body}</p>
          {step.where ? (
            <div className="walkthrough-where">
              <kbd>{step.where}</kbd>
            </div>
          ) : null}
        </div>

        <div className="walkthrough-foot">
          <button className="btn" onClick={onDone}>
            Skip
          </button>
          <span className="spacer" />
          <div className="walkthrough-dots">
            {WALKTHROUGH_STEPS.map((entry, position) => (
              <button
                key={entry.id}
                className={`tour-dot ${position === index ? 'on' : ''}`}
                onClick={() => setIndex(position)}
                title={entry.title}
                aria-label={entry.title}
              />
            ))}
          </div>
          <button
            className="btn"
            onClick={() => setIndex((current) => Math.max(0, current - 1))}
            disabled={index === 0}
          >
            Back
          </button>
          <button
            className="btn primary"
            onClick={() => (last ? onDone() : setIndex((current) => current + 1))}
          >
            {last ? 'Start browsing' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
