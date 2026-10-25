import { describe, expect, it } from 'vitest'
import {
  addressLabel,
  addressLine,
  forwardSeed,
  isUnifiedMailbox,
  mergeMailboxLists,
  replySeed,
  safeFilename,
  UNIFIED_MAILBOX_ID
} from '../src/shared/mail-view'
import type { MailBody, MailSummary } from '../src/shared/types'

const summary = (accountId: string, uid: number, date: string, subject = `s${uid}`): MailSummary => ({
  accountId,
  uid,
  subject,
  from: [{ name: '', address: 'sender@example.net' }],
  to: [{ name: '', address: 'ops@example.net' }],
  date,
  seen: false,
  flagged: false,
  hasAttachments: false,
  preview: '',
  size: 0
})

const body = (overrides: Partial<MailBody> = {}): MailBody => ({
  accountId: 'a1',
  uid: 7,
  subject: 'Quarterly review',
  from: [{ name: 'Dana Reed', address: 'dana@example.net' }],
  to: [{ name: '', address: 'ops@example.net' }],
  cc: [],
  date: '2026-10-24T09:30:00.000Z',
  text: 'line one\nline two',
  seen: true,
  flagged: false,
  html: null,
  remoteContentCount: 0,
  attachments: [],
  ...overrides
})

describe('address labels', () => {
  /** The name alone hides the address, which is the part worth checking. */
  it('shows name and address when both exist', () => {
    expect(addressLabel({ name: 'Dana Reed', address: 'dana@example.net' })).toBe('Dana Reed <dana@example.net>')
    expect(addressLabel({ name: '', address: 'dana@example.net' })).toBe('dana@example.net')
    expect(addressLabel({ name: 'Dana', address: '' })).toBe('Dana')
  })

  it('joins a list without empty entries', () => {
    expect(addressLine([{ name: '', address: 'a@x.test' }, { name: '', address: '' }, { name: 'B', address: 'b@x.test' }])).toBe(
      'a@x.test, B <b@x.test>'
    )
  })
})

describe('unified mailbox', () => {
  it('is a view, not an account id', () => {
    expect(UNIFIED_MAILBOX_ID).toBe('__unified__')
    expect(isUnifiedMailbox('__unified__')).toBe(true)
    expect(isUnifiedMailbox('mail_abc')).toBe(false)
    expect(isUnifiedMailbox(null)).toBe(false)
  })

  it('merges accounts newest first', () => {
    const merged = mergeMailboxLists([
      [summary('a1', 4, '2026-10-20T10:00:00.000Z'), summary('a1', 3, '2026-10-18T10:00:00.000Z')],
      [summary('a2', 9, '2026-10-21T10:00:00.000Z'), summary('a2', 8, '2026-10-19T10:00:00.000Z')]
    ])
    expect(merged.map((message) => `${message.accountId}:${message.uid}`)).toEqual(['a2:9', 'a1:4', 'a2:8', 'a1:3'])
  })

  /**
   * UIDs are per mailbox: the same number in two accounts is two messages, and
   * collapsing them would quietly drop mail.
   */
  it('keeps equal uids from different mailboxes apart', () => {
    const merged = mergeMailboxLists([
      [summary('a1', 1, '2026-10-20T10:00:00.000Z', 'first')],
      [summary('a2', 1, '2026-10-21T10:00:00.000Z', 'second')]
    ])
    expect(merged).toHaveLength(2)
    expect(merged.map((message) => message.subject)).toEqual(['second', 'first'])
  })

  it('does not duplicate a message listed twice', () => {
    const one = summary('a1', 2, '2026-10-20T10:00:00.000Z')
    expect(mergeMailboxLists([[one], [one]])).toHaveLength(1)
  })

  it('falls back to the feed order for dates it cannot parse', () => {
    const merged = mergeMailboxLists([
      [summary('a1', 1, 'not a date', 'one'), summary('a2', 2, 'not a date', 'two')]
    ])
    expect(merged.map((message) => message.subject)).toEqual(['one', 'two'])
  })
})

describe('saving attachments', () => {
  /**
   * The name comes from the sender, so it is data, not a path: a traversal or a
   * reserved character must not escape the Downloads folder.
   */
  it('strips anything that could leave the download folder', () => {
    expect(safeFilename('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(safeFilename('C:\\Users\\ops\\invoice.pdf')).toBe('C__Users_ops_invoice.pdf')
    expect(safeFilename('report:final?.pdf')).toBe('report_final_.pdf')
    expect(safeFilename('bad\u0000name.txt')).toBe('bad_name.txt')
  })

  it('keeps ordinary names intact and never returns an empty one', () => {
    expect(safeFilename('quarterly report.pdf')).toBe('quarterly report.pdf')
    expect(safeFilename('invoice.pdf.')).toBe('invoice.pdf')
    expect(safeFilename('...')).toBe('attachment')
    expect(safeFilename('   ')).toBe('attachment')
  })
})

describe('reply and forward', () => {
  it('replies to the sender with a quoted body', () => {
    const seed = replySeed(body())
    expect(seed.to).toBe('dana@example.net')
    expect(seed.subject).toBe('Re: Quarterly review')
    expect(seed.text).toContain('On ')
    expect(seed.text).toContain('> line one')
    expect(seed.text).toContain('> line two')
    expect(seed.text).toContain('Dana Reed <dana@example.net> wrote:')
  })

  it('never doubles a prefix it already has', () => {
    expect(replySeed(body({ subject: 'Re: Quarterly review' })).subject).toBe('Re: Quarterly review')
    expect(forwardSeed(body({ subject: 'Fwd: Quarterly review' })).subject).toBe('Fwd: Quarterly review')
  })

  it('forwards to nobody in particular, with the original quoted', () => {
    const seed = forwardSeed(body())
    expect(seed.to).toBe('')
    expect(seed.subject).toBe('Fwd: Quarterly review')
    expect(seed.text).toContain('> line one')
  })

  it('still produces a subject when the message had none', () => {
    expect(replySeed(body({ subject: '   ' })).subject).toBe('Re: (no subject)')
  })
})
