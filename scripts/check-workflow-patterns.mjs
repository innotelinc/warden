#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-workflow-patterns.mjs — fail when a workflow's grep pattern carries a
// backslash that was escaped one time too many.
//
//   node scripts/check-workflow-patterns.mjs
//
// Exits 1 with a GitHub annotation on each finding, 0 when every workflow is
// clean. The reasoning lives in workflow-grep-patterns.mjs; this file only
// walks .github/workflows and reports.
// ═══════════════════════════════════════════════════════════════════════════
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDoubledEscapes } from './workflow-grep-patterns.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflows = join(root, '.github', 'workflows')

const files = readdirSync(workflows)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort()

let findings = 0

for (const name of files) {
  const text = readFileSync(join(workflows, name), 'utf8')
  for (const { line, pattern } of findDoubledEscapes(text)) {
    findings += 1
    const where = `.github/workflows/${name}`
    // An annotation, so the failure points at the line in the diff view.
    console.error(`::error file=${where},line=${line}::grep pattern '${pattern}' has a doubled backslash`)
    console.error(`  ${where}:${line}  '${pattern}'`)
  }
}

if (findings > 0) {
  console.error(`\nworkflow greps: ${findings} doubled escape(s) — such a pattern matches a literal`)
  console.error('backslash instead of the text it meant, and the step passes for the wrong reason.')
  process.exit(1)
}

console.log(`workflow greps: ok (${files.length} workflow(s))`)
