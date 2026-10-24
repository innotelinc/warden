import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Small atomic JSON store. Writes go to a temp file then rename, so a crash
 * never leaves a half-written settings/history file behind.
 */
export class JsonStore<T> {
  private value: T
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly fallback: T,
    private readonly sanitize?: (value: unknown) => T
  ) {
    this.value = fallback
  }

  get(): T {
    return this.value
  }

  async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.value = this.sanitize ? this.sanitize(parsed) : (parsed as T)
    } catch {
      this.value = this.sanitize ? this.sanitize(this.fallback) : this.fallback
    }
    this.loaded = true
    return this.value
  }

  set(value: T): void {
    this.value = value
    this.scheduleSave()
  }

  update(mutator: (current: T) => T): T {
    this.value = mutator(this.value)
    this.scheduleSave()
    return this.value
  }

  private scheduleSave(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, 250)
  }

  async flush(): Promise<void> {
    if (!this.loaded) return
    const target = this.filePath
    const payload = JSON.stringify(this.value, null, 2)
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(target), { recursive: true })
        const temp = `${target}.${process.pid}.tmp`
        await fs.writeFile(temp, payload, 'utf8')
        await fs.rename(temp, target)
      } catch {
        /* persistence is best-effort; never crash the browser over it */
      }
    })
    return this.writing
  }

  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    await this.flush()
  }
}

export function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
