import type { OperatorButton } from '../operator/surfaces'

/**
 * A grid of services that open in WARDEN's own surface.
 *
 * The tile is a button, not a link: a link would leave the app, and leaving the
 * app is the behaviour this whole surface exists to remove.
 */
export function ServiceGrid({
  entries,
  onOpen,
  disabled
}: {
  entries: readonly OperatorButton[]
  onOpen: (url: string) => void
  disabled?: boolean
}): React.ReactElement {
  return (
    <div className="grid service-grid">
      {entries.map((entry) => (
        <button
          key={entry.id}
          className="service"
          onClick={() => onOpen(entry.url)}
          disabled={disabled}
          title={entry.url}
        >
          <span className="glyph" style={{ background: entry.color }} aria-hidden="true">
            {entry.glyph}
          </span>
          <span className="name">{entry.name}</span>
        </button>
      ))}
    </div>
  )
}
