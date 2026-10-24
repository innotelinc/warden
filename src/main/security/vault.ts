import { safeStorage } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Mail passwords never touch the settings file. They are encrypted with the
 * OS keychain (DPAPI on Windows, Keychain on macOS, libsecret on Linux) and
 * written to a separate 0600 file. If the platform has no encryption backend
 * WARDEN refuses to persist rather than silently storing plaintext.
 */
export class SecretVault {
  private cache = new Map<string, string>()
  private dirty = false
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly filePath: string) {}

  get available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, string>
      for (const [key, blob] of Object.entries(parsed)) {
        try {
          this.cache.set(key, safeStorage.decryptString(Buffer.from(blob, 'base64')))
        } catch {
          /* a secret we cannot decrypt is a secret we drop */
        }
      }
    } catch {
      /* first run */
    }
  }

  get(key: string): string | null {
    return this.cache.get(key) ?? null
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  set(key: string, value: string): void {
    if (!this.available) {
      throw new Error('OS encryption is unavailable; WARDEN will not store this password on disk.')
    }
    this.cache.set(key, value)
    this.dirty = true
    this.scheduleFlush()
  }

  delete(key: string): void {
    this.cache.delete(key)
    this.dirty = true
    this.scheduleFlush()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, 300)
  }

  async flush(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const payload: Record<string, string> = {}
    for (const [key, value] of this.cache) {
      payload[key] = safeStorage.encryptString(value).toString('base64')
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      await fs.writeFile(temp, JSON.stringify(payload), { encoding: 'utf8', mode: 0o600 })
      await fs.rename(temp, this.filePath)
    } catch {
      /* best effort */
    }
  }
}
