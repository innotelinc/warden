import { app } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { REMOTE_LISTS } from './builtin-lists'
import { parseFilterList, type FilterRule } from './filter-engine'

interface ListCache {
  updatedAt: number
  lists: Record<string, string>
}

const CACHE_FILE = () => path.join(app.getPath('userData'), 'filter-lists.json')

export async function readListCache(): Promise<ListCache | null> {
  try {
    const raw = await fs.readFile(CACHE_FILE(), 'utf8')
    const parsed = JSON.parse(raw) as ListCache
    if (typeof parsed.updatedAt !== 'number' || typeof parsed.lists !== 'object' || !parsed.lists) return null
    return parsed
  } catch {
    return null
  }
}

export function rulesFromCache(cache: ListCache | null): FilterRule[] {
  if (!cache) return []
  const rules: FilterRule[] = []
  for (const text of Object.values(cache.lists)) {
    rules.push(...parseFilterList(text, 'remote'))
  }
  return rules
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'WARDEN filter sync' }
    })
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
    return await response.text()
  } finally {
    clearTimeout(timer)
  }
}

/** Pull the public lists once the user asks for them. Never runs automatically. */
export async function syncLists(): Promise<{ cache: ListCache; rules: number }> {
  const lists: Record<string, string> = {}
  for (const [name, url] of Object.entries(REMOTE_LISTS)) {
    lists[name] = await fetchText(url)
  }
  const cache: ListCache = { updatedAt: Date.now(), lists }
  await fs.mkdir(app.getPath('userData'), { recursive: true })
  await fs.writeFile(CACHE_FILE(), JSON.stringify(cache), 'utf8')
  const parsed = rulesFromCache(cache)
  return { cache, rules: parsed.length }
}
