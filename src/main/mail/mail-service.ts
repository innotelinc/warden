import { app } from 'electron'
import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  FraudAssessment,
  FraudInput,
  MailAccountInput,
  MailAccountPublic,
  MailAddress,
  MailBody,
  MailFolder,
  MailSummary,
  SendMailInput
} from '@shared/types'
import { makeId, type JsonStore } from '../store/json-store'
import type { SecretVault } from '../security/vault'
import { mailErrorHint } from '@shared/mail-setup'
import { isUnifiedMailbox, mergeMailboxLists, safeFilename, UNIFIED_MAILBOX_ID } from '@shared/mail-view'
import { sanitizeMailHtml, textToHtml } from './sanitize'

export interface MailStore {
  accounts: MailAccountPublic[]
  activeAccountId: string | null
  activeFolder: string
}

const COLOR_CYCLE = ['#4fe3c1', '#a78bfa', '#f5b95b', '#7dd3fc', '#f472b6', '#86efac']

/**
 * Where a saved file goes, without ever overwriting one already there.
 *
 * Same folder the browser's own downloads use, and the same habit: a stamped
 * prefix rather than a dialog, so two files called `invoice.pdf` both survive.
 */
async function downloadTarget(name: string): Promise<string> {
  const dir = app.getPath('downloads')
  await fs.mkdir(dir, { recursive: true })
  return path.join(dir, `${Date.now().toString(36)}-${safeFilename(name)}`)
}

/** Inbox first, then the rest in an order that does not depend on the provider. */
function sortFolders(folders: MailFolder[]): MailFolder[] {
  const order = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive']
  return folders.sort((a, b) => {
    const ai = a.specialUse ? order.indexOf(a.specialUse) : 99
    const bi = b.specialUse ? order.indexOf(b.specialUse) : 99
    if (ai !== bi) return (ai === -1 ? 98 : ai) - (bi === -1 ? 98 : bi)
    return a.name.localeCompare(b.name)
  })
}

function toAddresses(value: unknown): MailAddress[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : [value]
  return list
    .map((entry) => {
      if (typeof entry === 'string') return { name: '', address: entry }
      const record = entry as { name?: string; address?: string }
      return { name: record.name ?? '', address: record.address ?? '' }
    })
    .filter((entry) => Boolean(entry.address))
}

/** Links in the plain-text body, deduplicated: what the analyst has to judge. */
function extractLinks(text: string): string[] {
  const found = text.match(/https?:\/\/[^\s<>"')\]]+/gi) ?? []
  return [...new Set(found)].slice(0, 20)
}

/**
 * A failed verification the operator can act on.
 *
 * "IMAP check failed: Invalid credentials" tells someone nothing; the hint names
 * the mistake — host, port and TLS disagreeing, the account password where an
 * app password is required, or a network path that is blocked — and the raw
 * server text stays attached for an administrator.
 */
function describeCheckFailure(stage: 'IMAP' | 'SMTP', error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const hint = mailErrorHint(raw)
  return hint ? `${stage} check failed: ${hint} (${raw})` : `${stage} check failed: ${raw}`
}

function countAttachments(structure: unknown): boolean {
  const node = structure as { childNodes?: unknown[]; disposition?: string; parameters?: Record<string, string> } | null
  if (!node) return false
  if (node.disposition === 'attachment') return true
  if (!Array.isArray(node.childNodes)) return false
  return node.childNodes.some((child) => countAttachments(child))
}

export class MailService {
  private clients = new Map<string, ImapFlow>()
  private activeId: string | null = null
  /** Every account's copy of the active folder, merged into one list. */
  private unified = false
  private activeFolder = 'INBOX'
  private folderCache = new Map<string, MailFolder[]>()
  private messages: MailSummary[] = []
  private selected: MailBody | null = null
  /**
   * The open message exactly as it arrived, kept so an attachment or the whole
   * message can be written to disk without a second IMAP fetch.
   */
  private openRaw: {
    accountId: string
    uid: number
    subject: string
    raw: Buffer
    attachments: { filename: string; contentType: string; content: Buffer }[]
  } | null = null
  private busy = false
  private error: string | null = null
  private fraud: FraudAssessment | null = null
  private fraudBusy = false
  private fraudError: string | null = null
  /** Keyed by `accountId:uid`: uids repeat across mailboxes. */
  private fraudCache = new Map<string, FraudAssessment>()
  private fraudChecker: ((input: FraudInput) => Promise<FraudAssessment>) | null = null
  private fraudAvailable: (() => boolean) | null = null

  constructor(
    private readonly store: JsonStore<MailStore>,
    private readonly vault: SecretVault,
    private readonly onChange: () => void,
    /** Policy: should an opened message be read by Genie without being asked? */
    private readonly autoFraud: () => boolean = () => false
  ) {}

  /**
   * Genie is built after the mail service, and its gateway can be unset for the
   * whole session: the checker is attached when it exists, not assumed.
   */
  setFraudChecker(
    checker: (input: FraudInput) => Promise<FraudAssessment>,
    available: () => boolean = () => true
  ): void {
    this.fraudChecker = checker
    this.fraudAvailable = available
  }

  /**
   * Genie's read on the selected message.
   *
   * `manual` distinguishes a click from the automatic pass: an operator who
   * asked deserves to be told why nothing happened, while automatic checks stay
   * quiet until a gateway key exists.
   */
  async checkSelected(): Promise<FraudAssessment | null> {
    if (!this.selected) return null
    return this.runFraud(this.selected, true)
  }

  private canCheckFraud(): boolean {
    return Boolean(this.fraudChecker) && (this.fraudAvailable?.() ?? true)
  }

  private resetFraud(): void {
    this.fraud = null
    this.fraudError = null
    this.fraudBusy = false
    this.fraudCache.clear()
  }

  /** UIDs are per mailbox, so a verdict is keyed by the mailbox too. */
  private fraudKey(message: { accountId: string; uid: number }): string {
    return `${message.accountId}:${message.uid}`
  }

  private async runFraud(body: MailBody, manual = false): Promise<FraudAssessment | null> {
    if (!this.canCheckFraud()) {
      if (manual) {
        this.fraudError = 'Genie is not configured. Set a gateway key in Policy → Genie.'
        this.onChange()
      }
      return null
    }
    const cached = this.fraudCache.get(this.fraudKey(body))
    if (cached && !manual) {
      this.fraud = cached
      this.onChange()
      return cached
    }
    if (this.fraudBusy) return null

    this.fraudBusy = true
    this.fraudError = null
    this.onChange()
    try {
      const assessment = { ...(await this.fraudChecker!(this.fraudInput(body))), accountId: body.accountId }
      this.fraudCache.set(this.fraudKey(body), assessment)
      if (this.fraudCache.size > 50) {
        const oldest = this.fraudCache.keys().next()
        if (!oldest.done) this.fraudCache.delete(oldest.value)
      }
      // The operator may have opened another message while Genie was reading.
      if (this.selected && this.fraudKey(this.selected) === this.fraudKey(body)) this.fraud = assessment
      return assessment
    } catch (error) {
      if (this.selected && this.fraudKey(this.selected) === this.fraudKey(body)) {
        this.fraudError = (error as Error).message
      }
      return null
    } finally {
      this.fraudBusy = false
      this.onChange()
    }
  }

  private fraudInput(body: MailBody): FraudInput {
    return {
      uid: body.uid,
      subject: body.subject,
      from: body.from.map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address)),
      to: body.to.map((entry) => entry.address),
      date: body.date,
      text: body.text.slice(0, 8000),
      links: extractLinks(body.text)
    }
  }

  get accounts(): MailAccountPublic[] {
    return this.store.get().accounts
  }

  /**
   * One folder list for every account.
   *
   * Providers disagree about paths, so folders are merged by path and their
   * counts added: INBOX is INBOX everywhere, which is the case that matters.
   */
  private unifiedFolders(): MailFolder[] {
    const byPath = new Map<string, MailFolder>()
    for (const account of this.accounts) {
      for (const folder of this.folderCache.get(account.id) ?? []) {
        const existing = byPath.get(folder.path)
        if (existing) {
          existing.unread += folder.unread
          existing.total += folder.total
        } else {
          byPath.set(folder.path, { ...folder })
        }
      }
    }
    return sortFolders([...byPath.values()])
  }

  get state() {
    return {
      accounts: this.accounts,
      activeAccountId: this.unified ? UNIFIED_MAILBOX_ID : this.activeId,
      unified: this.unified,
      folders: this.unified
        ? this.unifiedFolders()
        : this.activeId
          ? (this.folderCache.get(this.activeId) ?? [])
          : [],
      activeFolder: this.activeFolder,
      messages: this.messages,
      selected: this.selected,
      busy: this.busy,
      error: this.error,
      fraud: this.fraud,
      fraudBusy: this.fraudBusy,
      fraudError: this.fraudError
    }
  }

  load(): void {
    this.activeId = this.store.get().activeAccountId ?? this.accounts[0]?.id ?? null
    this.activeFolder = this.store.get().activeFolder || 'INBOX'
  }

  async selectAccount(id: string): Promise<void> {
    if (isUnifiedMailbox(id)) {
      this.unified = true
      this.activeFolder = 'INBOX'
      this.messages = []
      this.selected = null
      this.openRaw = null
      this.resetFraud()
      this.onChange()
      await this.refreshFolders()
      return
    }
    this.unified = false
    this.activeId = id
    this.activeFolder = 'INBOX'
    this.messages = []
    this.selected = null
    this.resetFraud()
    this.store.update((current) => ({ ...current, activeAccountId: id, activeFolder: 'INBOX' }))
    this.onChange()
    await this.refreshFolders()
  }

  async selectFolder(path: string): Promise<void> {
    this.activeFolder = path
    this.selected = null
    this.openRaw = null
    this.resetFraud()
    this.store.update((current) => ({ ...current, activeFolder: path }))
    this.onChange()
    await this.refreshMessages()
  }

  async addAccount(input: MailAccountInput): Promise<MailAccountPublic> {
    const id = makeId('mail')
    const account: MailAccountPublic = {
      id,
      label: input.label || input.email,
      email: input.email,
      imap: input.imap,
      smtp: input.smtp,
      color: COLOR_CYCLE[this.accounts.length % COLOR_CYCLE.length] ?? '#4fe3c1',
      hasPassword: true,
      lastError: null
    }

    this.busy = true
    this.error = null
    this.onChange()

    const client = new ImapFlow({
      host: input.imap.host,
      port: input.imap.port,
      secure: input.imap.secure,
      auth: { user: input.imap.user || input.email, pass: input.password },
      logger: false,
      tls: { rejectUnauthorized: true }
    })

    try {
      await client.connect()
      await client.logout()
    } catch (error) {
      this.busy = false
      this.error = describeCheckFailure('IMAP', error)
      this.onChange()
      throw new Error(this.error)
    }

    try {
      const transport = nodemailer.createTransport({
        host: input.smtp.host,
        port: input.smtp.port,
        secure: input.smtp.secure,
        auth: { user: input.smtp.user || input.email, pass: input.password }
      })
      await transport.verify()
    } catch (error) {
      this.busy = false
      this.error = describeCheckFailure('SMTP', error)
      this.onChange()
      throw new Error(this.error)
    }

    this.vault.set(`mail:${id}`, input.password)
    this.store.update((current) => ({ ...current, accounts: [...current.accounts, account], activeAccountId: id }))
    this.activeId = id
    this.unified = false
    this.busy = false
    this.onChange()
    await this.refreshFolders()
    return account
  }

  async removeAccount(id: string): Promise<void> {
    const client = this.clients.get(id)
    if (client) {
      try {
        await client.logout()
      } catch {
        /* already closed */
      }
      this.clients.delete(id)
    }
    this.vault.delete(`mail:${id}`)
    this.folderCache.delete(id)
    this.store.update((current) => ({
      ...current,
      accounts: current.accounts.filter((account) => account.id !== id),
      activeAccountId: current.activeAccountId === id ? null : current.activeAccountId
    }))
    if (this.activeId === id) {
      this.activeId = this.store.get().accounts[0]?.id ?? null
      this.messages = []
      this.selected = null
      this.openRaw = null
      this.resetFraud()
    }
    // A unified view with nothing left in it is just an empty screen.
    if (this.unified && !this.accounts.length) this.unified = false
    this.onChange()
  }

  private async client(id?: string): Promise<ImapFlow> {
    const accountId = id ?? this.activeId
    const account = this.accounts.find((entry) => entry.id === accountId)
    if (!account) throw new Error('No mail account selected')
    const password = this.vault.get(`mail:${account.id}`)
    if (!password) throw new Error('Mail password is not available in the OS keychain')

    const existing = this.clients.get(account.id)
    if (existing?.usable) return existing
    if (existing) {
      try {
        await existing.logout()
      } catch {
        /* ignore */
      }
      this.clients.delete(account.id)
    }

    const client = new ImapFlow({
      host: account.imap.host,
      port: account.imap.port,
      secure: account.imap.secure,
      auth: { user: account.imap.user || account.email, pass: password },
      logger: false,
      tls: { rejectUnauthorized: true }
    })
    client.on('error', (error: Error) => {
      this.error = `IMAP: ${error.message}`
      this.clients.delete(account.id)
      this.onChange()
    })
    await client.connect()
    this.clients.set(account.id, client)
    return client
  }

  /** List one account's folders and cache them under its id. */
  private async listFolders(accountId: string): Promise<MailFolder[]> {
    const client = await this.client(accountId)
    const listed = await client.list()
    const folders: MailFolder[] = []
    for (const mailbox of listed.slice(0, 60)) {
      let unread = 0
      let total = 0
      try {
        const status = await client.status(mailbox.path, { messages: true, unseen: true })
        if (status) {
          unread = status.unseen ?? 0
          total = status.messages ?? 0
        }
      } catch {
        /* some servers refuse STATUS on certain mailboxes */
      }
      folders.push({
        path: mailbox.path,
        name: mailbox.name || mailbox.path,
        specialUse: mailbox.specialUse ?? null,
        unread,
        total
      })
    }
    const sorted = sortFolders(folders)
    this.folderCache.set(accountId, sorted)
    return sorted
  }

  async refreshFolders(): Promise<MailFolder[]> {
    const activeId = this.activeId
    if (!this.unified && !activeId) return []
    this.busy = true
    this.error = null
    this.onChange()
    try {
      if (this.unified) {
        // One account failing (a rejected password, a host that is down) must
        // not hide the mailboxes that did answer.
        const failures: string[] = []
        for (const account of this.accounts) {
          try {
            await this.listFolders(account.id)
          } catch (error) {
            failures.push(`${account.label}: ${(error as Error).message}`)
          }
        }
        this.error = failures.length ? failures.join(' · ') : null
        return this.unifiedFolders()
      }
      if (!activeId) return []
      return await this.listFolders(activeId)
    } catch (error) {
      this.error = (error as Error).message
      return []
    } finally {
      this.busy = false
      this.onChange()
    }
  }

  /** The last `limit` messages of one mailbox, newest first. */
  private async fetchMessages(accountId: string, folder: string, limit: number): Promise<MailSummary[]> {
    const client = await this.client(accountId)
    const lock = await client.getMailboxLock(folder)
    try {
      const exists = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.exists : 0
      if (!exists) return []
      const from = Math.max(1, exists - limit + 1)
      const fetched = await client.fetchAll(`${from}:${exists}`, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        size: true
      })
      return fetched
        .map((message) => {
          const envelope = message.envelope
          return {
            accountId,
            uid: message.uid,
            subject: envelope?.subject || '(no subject)',
            from: toAddresses(envelope?.from),
            to: toAddresses(envelope?.to),
            date: new Date(envelope?.date ?? Date.now()).toISOString(),
            seen: message.flags?.has('\\Seen') ?? false,
            flagged: message.flags?.has('\\Flagged') ?? false,
            hasAttachments: countAttachments(message.bodyStructure),
            preview: '',
            size: message.size ?? 0
          }
        })
        .reverse()
    } finally {
      lock.release()
    }
  }

  async refreshMessages(limit = 50): Promise<MailSummary[]> {
    const activeId = this.activeId
    if (!this.unified && !activeId) return []
    this.busy = true
    this.error = null
    this.onChange()
    try {
      if (this.unified) {
        const lists: MailSummary[][] = []
        const failures: string[] = []
        for (const account of this.accounts) {
          // Providers name folders differently; an account that has no such
          // folder is skipped rather than reported as a failure.
          const known = this.folderCache.get(account.id)
          if (known?.length && !known.some((folder) => folder.path === this.activeFolder)) continue
          try {
            lists.push(await this.fetchMessages(account.id, this.activeFolder, limit))
          } catch (error) {
            // One mailbox refusing must not blank the others; say which failed.
            failures.push(`${account.label}: ${(error as Error).message}`)
          }
        }
        this.messages = mergeMailboxLists(lists)
        this.error = failures.length ? failures.join(' · ') : null
        return this.messages
      }
      if (!activeId) return []
      this.messages = await this.fetchMessages(activeId, this.activeFolder, limit)
      return this.messages
    } catch (error) {
      this.error = (error as Error).message
      return []
    } finally {
      this.busy = false
      this.onChange()
    }
  }

  async openMessage(uid: number, accountId?: string): Promise<MailBody> {
    const target = accountId ?? this.activeId
    if (!target) throw new Error('No mail account selected')
    const client = await this.client(target)
    const lock = await client.getMailboxLock(this.activeFolder)
    try {
      const download = await client.download(String(uid), undefined, { uid: true })
      const chunks: Buffer[] = []
      if (download.content) {
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk))
      }
      const raw = Buffer.concat(chunks)
      const parsed = await simpleParser(raw)

      const rawHtml = typeof parsed.html === 'string' ? parsed.html : ''
      const sanitized = rawHtml ? sanitizeMailHtml(rawHtml) : { html: textToHtml(parsed.text ?? ''), remoteCount: 0 }

      const summary = this.messages.find((message) => message.accountId === target && message.uid === uid)
      const body: MailBody = {
        accountId: target,
        uid,
        subject: parsed.subject ?? '(no subject)',
        from: toAddresses(parsed.from),
        to: toAddresses(parsed.to),
        cc: toAddresses(parsed.cc),
        date: new Date(parsed.date ?? Date.now()).toISOString(),
        text: parsed.text ?? '',
        // Opening a message marks it seen; the toggle shows what it is now.
        seen: true,
        flagged: summary?.flagged ?? false,
        html: sanitized.html,
        remoteContentCount: sanitized.remoteCount,
        attachments: (parsed.attachments ?? []).map((attachment) => ({
          filename: attachment.filename ?? 'attachment',
          size: attachment.size ?? 0,
          contentType: attachment.contentType ?? 'application/octet-stream'
        }))
      }

      this.selected = body
      this.openRaw = {
        accountId: target,
        uid,
        subject: body.subject,
        raw,
        attachments: (parsed.attachments ?? []).map((attachment) => ({
          filename: attachment.filename ?? 'attachment',
          contentType: attachment.contentType ?? 'application/octet-stream',
          content: Buffer.isBuffer(attachment.content)
            ? attachment.content
            : Buffer.from(attachment.content ?? '')
        }))
      }
      // A verdict belongs to the message it was made about: show the cached one
      // for this message, and otherwise let Genie read it without blocking.
      this.fraud = this.fraudCache.get(this.fraudKey(body)) ?? null
      this.fraudError = null
      if (!this.fraud && this.autoFraud() && this.canCheckFraud()) {
        void this.runFraud(body)
      }
      this.messages = this.messages.map((message) =>
        message.accountId === target && message.uid === uid ? { ...message, seen: true } : message
      )
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
      this.onChange()
      return body
    } finally {
      lock.release()
    }
  }

  async setFlag(uid: number, flag: 'seen' | 'flagged', value: boolean, accountId?: string): Promise<void> {
    const target = accountId ?? this.activeId
    if (!target) throw new Error('No mail account selected')
    const client = await this.client(target)
    const lock = await client.getMailboxLock(this.activeFolder)
    const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged'
    try {
      if (value) await client.messageFlagsAdd(String(uid), [imapFlag], { uid: true })
      else await client.messageFlagsRemove(String(uid), [imapFlag], { uid: true })
      this.messages = this.messages.map((message) =>
        message.accountId === target && message.uid === uid
          ? { ...message, seen: flag === 'seen' ? value : message.seen, flagged: flag === 'flagged' ? value : message.flagged }
          : message
      )
      if (this.selected?.accountId === target && this.selected.uid === uid) {
        this.selected = {
          ...this.selected,
          seen: flag === 'seen' ? value : this.selected.seen,
          flagged: flag === 'flagged' ? value : this.selected.flagged
        }
      }
      this.onChange()
    } finally {
      lock.release()
    }
  }

  /**
   * Delete one message, through the mailbox it belongs to.
   *
   * A server with a Trash folder gets a move, which is what every mail client
   * does and what the operator can undo; one without gets a real delete.
   */
  async deleteMessage(uid: number, accountId?: string): Promise<void> {
    const target = accountId ?? this.activeId
    if (!target) throw new Error('No mail account selected')
    const client = await this.client(target)
    const trash = (this.folderCache.get(target) ?? []).find((folder) => folder.specialUse === '\\Trash')
    const lock = await client.getMailboxLock(this.activeFolder)
    try {
      if (trash && trash.path !== this.activeFolder) {
        await client.messageMove(String(uid), trash.path, { uid: true })
      } else {
        await client.messageDelete(String(uid), { uid: true })
      }
      this.messages = this.messages.filter((message) => !(message.accountId === target && message.uid === uid))
      if (this.selected?.accountId === target && this.selected.uid === uid) {
        this.selected = null
        this.openRaw = null
        this.resetFraud()
      }
      this.error = null
      this.onChange()
    } finally {
      lock.release()
    }
  }

  /**
   * Write one attachment of the open message into the Downloads folder.
   *
   * The bytes come from the message already in memory, so this is the operator
   * saving a file they just chose to open — no page, no network, and not gated
   * by the page-download policy.
   */
  async downloadAttachment(index: number): Promise<{ path: string }> {
    const open = this.openRaw
    if (!open) throw new Error('Open a message before saving an attachment.')
    const attachment = open.attachments[index]
    if (!attachment) throw new Error('That attachment is no longer on screen.')
    const target = await downloadTarget(attachment.filename)
    await fs.writeFile(target, attachment.content)
    return { path: target }
  }

  /** Save the open message as .eml: the source, headers and all. */
  async saveMessage(): Promise<{ path: string }> {
    const open = this.openRaw
    if (!open) throw new Error('No message is open.')
    const target = await downloadTarget(`${open.subject || 'message'}.eml`)
    await fs.writeFile(target, open.raw)
    return { path: target }
  }

  async send(input: SendMailInput): Promise<void> {
    const account = this.accounts.find((entry) => entry.id === input.accountId)
    if (!account) throw new Error('No mail account selected')
    const password = this.vault.get(`mail:${account.id}`)
    if (!password) throw new Error('Mail password is not available in the OS keychain')

    const transport = nodemailer.createTransport({
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.secure,
      auth: { user: account.smtp.user || account.email, pass: password }
    })

    await transport.sendMail({
      from: account.email,
      to: input.to,
      cc: input.cc || undefined,
      subject: input.subject,
      text: input.text
    })
  }

  async close(): Promise<void> {
    for (const [id, client] of this.clients) {
      try {
        await client.logout()
      } catch {
        /* ignore */
      }
      this.clients.delete(id)
    }
  }
}
