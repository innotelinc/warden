import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import { simpleParser } from 'mailparser'
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
import { sanitizeMailHtml, textToHtml } from './sanitize'

export interface MailStore {
  accounts: MailAccountPublic[]
  activeAccountId: string | null
  activeFolder: string
}

const COLOR_CYCLE = ['#4fe3c1', '#a78bfa', '#f5b95b', '#7dd3fc', '#f472b6', '#86efac']

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
  private activeFolder = 'INBOX'
  private folderCache = new Map<string, MailFolder[]>()
  private messages: MailSummary[] = []
  private selected: MailBody | null = null
  private busy = false
  private error: string | null = null
  private fraud: FraudAssessment | null = null
  private fraudBusy = false
  private fraudError: string | null = null
  private fraudCache = new Map<number, FraudAssessment>()
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

  private async runFraud(body: MailBody, manual = false): Promise<FraudAssessment | null> {
    if (!this.canCheckFraud()) {
      if (manual) {
        this.fraudError = 'Genie is not configured. Set a gateway key in Policy → Genie.'
        this.onChange()
      }
      return null
    }
    const cached = this.fraudCache.get(body.uid)
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
      const assessment = await this.fraudChecker!(this.fraudInput(body))
      this.fraudCache.set(body.uid, assessment)
      if (this.fraudCache.size > 50) {
        const oldest = this.fraudCache.keys().next()
        if (!oldest.done) this.fraudCache.delete(oldest.value)
      }
      // The operator may have opened another message while Genie was reading.
      if (this.selected?.uid === body.uid) this.fraud = assessment
      return assessment
    } catch (error) {
      if (this.selected?.uid === body.uid) this.fraudError = (error as Error).message
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

  get state() {
    return {
      accounts: this.accounts,
      activeAccountId: this.activeId,
      folders: this.activeId ? (this.folderCache.get(this.activeId) ?? []) : [],
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
      this.error = `IMAP check failed: ${(error as Error).message}`
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
      this.error = `SMTP check failed: ${(error as Error).message}`
      this.onChange()
      throw new Error(this.error)
    }

    this.vault.set(`mail:${id}`, input.password)
    this.store.update((current) => ({ ...current, accounts: [...current.accounts, account], activeAccountId: id }))
    this.activeId = id
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
      this.resetFraud()
    }
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

  async refreshFolders(): Promise<MailFolder[]> {
    if (!this.activeId) return []
    this.busy = true
    this.error = null
    this.onChange()
    try {
      const client = await this.client()
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
      const order = ['\\Inbox', '\\Sent', '\\Drafts', '\\Junk', '\\Trash', '\\Archive']
      folders.sort((a, b) => {
        const ai = a.specialUse ? order.indexOf(a.specialUse) : 99
        const bi = b.specialUse ? order.indexOf(b.specialUse) : 99
        if (ai !== bi) return (ai === -1 ? 98 : ai) - (bi === -1 ? 98 : bi)
        return a.name.localeCompare(b.name)
      })
      this.folderCache.set(this.activeId, folders)
      return folders
    } catch (error) {
      this.error = (error as Error).message
      return []
    } finally {
      this.busy = false
      this.onChange()
    }
  }

  async refreshMessages(limit = 50): Promise<MailSummary[]> {
    if (!this.activeId) return []
    this.busy = true
    this.error = null
    this.onChange()
    const client = await this.client()
    const lock = await client.getMailboxLock(this.activeFolder)
    try {
      const exists = client.mailbox && typeof client.mailbox === 'object' ? client.mailbox.exists : 0
      if (!exists) {
        this.messages = []
        return []
      }
      const from = Math.max(1, exists - limit + 1)
      const fetched = await client.fetchAll(`${from}:${exists}`, {
        envelope: true,
        flags: true,
        bodyStructure: true,
        size: true
      })
      const messages: MailSummary[] = fetched
        .map((message) => {
          const envelope = message.envelope
          return {
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
      this.messages = messages
      return messages
    } catch (error) {
      this.error = (error as Error).message
      return []
    } finally {
      lock.release()
      this.busy = false
      this.onChange()
    }
  }

  async openMessage(uid: number): Promise<MailBody> {
    if (!this.activeId) throw new Error('No mail account selected')
    const client = await this.client()
    const lock = await client.getMailboxLock(this.activeFolder)
    try {
      const download = await client.download(String(uid), undefined, { uid: true })
      const chunks: Buffer[] = []
      if (download.content) {
        for await (const chunk of download.content) chunks.push(Buffer.from(chunk))
      }
      const parsed = await simpleParser(Buffer.concat(chunks))

      const rawHtml = typeof parsed.html === 'string' ? parsed.html : ''
      const sanitized = rawHtml ? sanitizeMailHtml(rawHtml) : { html: textToHtml(parsed.text ?? ''), remoteCount: 0 }

      const body: MailBody = {
        uid,
        subject: parsed.subject ?? '(no subject)',
        from: toAddresses(parsed.from),
        to: toAddresses(parsed.to),
        cc: toAddresses(parsed.cc),
        date: new Date(parsed.date ?? Date.now()).toISOString(),
        text: parsed.text ?? '',
        html: sanitized.html,
        remoteContentCount: sanitized.remoteCount,
        attachments: (parsed.attachments ?? []).map((attachment) => ({
          filename: attachment.filename ?? 'attachment',
          size: attachment.size ?? 0,
          contentType: attachment.contentType ?? 'application/octet-stream'
        }))
      }

      this.selected = body
      // A verdict belongs to the message it was made about: show the cached one
      // for this uid, and otherwise let Genie read it without blocking the open.
      this.fraud = this.fraudCache.get(uid) ?? null
      this.fraudError = null
      if (!this.fraud && this.autoFraud() && this.canCheckFraud()) {
        void this.runFraud(body)
      }
      this.messages = this.messages.map((message) =>
        message.uid === uid ? { ...message, seen: true } : message
      )
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true })
      this.onChange()
      return body
    } finally {
      lock.release()
    }
  }

  async setFlag(uid: number, flag: 'seen' | 'flagged', value: boolean): Promise<void> {
    const client = await this.client()
    const lock = await client.getMailboxLock(this.activeFolder)
    const imapFlag = flag === 'seen' ? '\\Seen' : '\\Flagged'
    try {
      if (value) await client.messageFlagsAdd(String(uid), [imapFlag], { uid: true })
      else await client.messageFlagsRemove(String(uid), [imapFlag], { uid: true })
      this.messages = this.messages.map((message) =>
        message.uid === uid
          ? { ...message, seen: flag === 'seen' ? value : message.seen, flagged: flag === 'flagged' ? value : message.flagged }
          : message
      )
      this.onChange()
    } finally {
      lock.release()
    }
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
