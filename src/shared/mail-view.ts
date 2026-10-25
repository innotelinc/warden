/**
 * The parts of the mail view that can be reasoned about without a connection:
 * how an address reads, how a unified mailbox is assembled, and what Reply and
 * Forward put in front of the operator.
 *
 * Kept out of the service and the component so the merge order and the subject
 * prefixes are tested rather than eyeballed.
 */
import type { MailAddress, MailBody, MailSummary } from './types'

/**
 * The account entry that stands for every mailbox at once.
 *
 * Not an account id: nothing is ever saved under it, and a message is always
 * opened through the mailbox it actually came from.
 */
export const UNIFIED_MAILBOX_ID = '__unified__'

export function isUnifiedMailbox(id: string | null | undefined): boolean {
  return id === UNIFIED_MAILBOX_ID
}

/**
 * One readable form for an address.
 *
 * The name alone hides the address, which is the part an operator checks on a
 * suspicious message, and the address alone hides who sent it. Both, when both
 * exist.
 */
export function addressLabel(entry: MailAddress): string {
  if (entry.name && entry.address) return `${entry.name} <${entry.address}>`
  return entry.name || entry.address
}

export function addressLine(list: MailAddress[]): string {
  return list.map(addressLabel).filter(Boolean).join(', ')
}

/**
 * Merge per-mailbox lists into one, newest first.
 *
 * UIDs are per mailbox, so `uid` alone would collide between accounts; the key
 * is the pair. Ordering falls back to the original position for equal dates so
 * a refresh does not reshuffle rows that did not change.
 */
export function mergeMailboxLists(lists: MailSummary[][]): MailSummary[] {
  const seen = new Set<string>()
  const merged: (MailSummary & { _order: number })[] = []
  let order = 0
  for (const list of lists) {
    for (const message of list) {
      const key = `${message.accountId}:${message.uid}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push({ ...message, _order: order++ })
    }
  }
  merged.sort((a, b) => {
    const at = Date.parse(a.date)
    const bt = Date.parse(b.date)
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
    return a._order - b._order
  })
  return merged.map(({ _order, ...message }) => message)
}

/**
 * A filename that cannot escape the folder it is written into.
 *
 * Attachments carry whatever the sender put in `Content-Disposition`, so path
 * separators, drive colons and control characters are replaced rather than
 * trusted; a name that is only dots or whitespace gets a fallback.
 */
export function safeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    // Leading dots would make a hidden file; Windows silently drops a trailing
    // dot or space, which turns `invoice.pdf.` into something else entirely.
    .replace(/^\.+/, '')
    .replace(/[.\s]+$/, '')
    .trim()
  return cleaned || 'attachment'
}

export interface ComposeSeed {
  to: string
  subject: string
  text: string
}

/** Quoted body for a reply: the original is shown, not re-fetched. */
function quote(body: MailBody): string {
  const when = new Date(body.date).toLocaleString()
  const from = addressLine(body.from) || 'the sender'
  const quoted = body.text
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `\n\nOn ${when}, ${from} wrote:\n${quoted}`
}

function withPrefix(prefix: string, subject: string): string {
  const trimmed = subject.trim() || '(no subject)'
  return new RegExp(`^${prefix}`, 'i').test(trimmed) ? trimmed : `${prefix}${trimmed}`
}

export function replySeed(body: MailBody): ComposeSeed {
  return {
    to: body.from[0]?.address ?? '',
    subject: withPrefix('Re: ', body.subject),
    text: quote(body)
  }
}

export function forwardSeed(body: MailBody): ComposeSeed {
  return {
    to: '',
    subject: withPrefix('Fwd: ', body.subject),
    text: quote(body)
  }
}
