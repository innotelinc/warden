import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { docHtml, docUrl, isDocPath, readDoc, resolveDocPath } from '../src/main/browser/local-doc'

const scratch = mkdtempSync(path.join(tmpdir(), 'warden-doc-'))
const markdown = path.join(scratch, 'LOCAL_MODELS.md')
writeFileSync(markdown, '# Local models\n\n- qwen2.5\n- llama3\n\n<script>alert(1)</script>\n')
const binary = path.join(scratch, 'installer.exe')
writeFileSync(binary, 'MZ')

afterAll(() => rmSync(scratch, { recursive: true, force: true }))

describe('local document reader', () => {
  it('accepts text-shaped extensions only', () => {
    expect(isDocPath('LOCAL_MODELS.md')).toBe(true)
    expect(isDocPath('C:\\work\\notes.txt')).toBe(true)
    expect(isDocPath('notes.YAML')).toBe(true)
    expect(isDocPath('installer.exe')).toBe(false)
    expect(isDocPath('photo.png')).toBe(false)
    expect(isDocPath('')).toBe(false)
  })

  it('resolves a real file and refuses what it must not read', () => {
    expect(resolveDocPath(markdown)).toBe(markdown)
    expect(resolveDocPath(binary)).toBeNull()
    expect(resolveDocPath(path.join(scratch, 'missing.md'))).toBeNull()
    expect(resolveDocPath(scratch)).toBeNull()
    expect(resolveDocPath('nothing-here.md')).toBeNull()
  })

  it('accepts the file:// URL another browser would copy', () => {
    expect(resolveDocPath(`file://${markdown}`)).toBe(markdown)
  })

  it('renders the file as escaped text, never as markup', () => {
    const doc = readDoc(markdown)
    expect(doc).not.toBeNull()
    expect(doc!.html).toContain('LOCAL_MODELS.md')
    expect(doc!.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(doc!.html).not.toContain('<script>alert(1)</script>')
    expect(doc!.html).toContain('local file · read only')
  })

  it('ships a document with no script or network origin allowed', () => {
    const html = docHtml('/tmp/notes.md', 'hello')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toContain('<script')
    expect(html).not.toContain('src=')
  })

  it('round-trips the path through the internal URL', () => {
    const url = docUrl('C:\\work\\LOCAL_MODELS.md')
    const parsed = new URL(url)
    expect(parsed.protocol).toBe('warden:')
    expect(parsed.hostname).toBe('doc')
    expect(parsed.searchParams.get('path')).toBe('C:\\work\\LOCAL_MODELS.md')
  })
})
