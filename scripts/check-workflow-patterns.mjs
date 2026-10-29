#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// check-workflow-patterns.mjs — fail when a grep pattern carries a backslash
// that was escaped one time too many.
//
//   node scripts/check-workflow-patterns.mjs
//
// Two sets of files are scanned, for one reason: both are shell.
//
//   .github/workflows/*.yml|yaml   a step's `run:` block is bash
//   tracked *.sh and .githooks/*   committed shell, incl. the repo's hooks
//
// The hooks matter most. A guard pattern that matches a literal backslash
// instead of the text it names never fires, so the attribution rule or the
// secret scan it implements silently stops working while every commit it
// should have blocked lands green.
//
// The shell set comes from the index (`git ls-files`), the same way the
// `bash -n` job picks its files, so what is checked is what a clone gets.
//
// Exits 1 with a GitHub annotation on each finding, 0 when everything is clean.
// The reasoning lives in workflow-grep-patterns.mjs; this file only collects
// the files and reports.
// ═══════════════════════════════════════════════════════════════════════════
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { findDoubledEscapesIn } from './workflow-grep-patterns.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Workflows, read from disk: they are few and they are the main target. */
function workflowPaths() {
  const directory = join(root, '.github', 'workflows')
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => `.github/workflows/${name}`)
}

/** Tracked shell scripts and hooks, read from the index. */
function shellPaths() {
  const listed = execFileSync('git', ['ls-files', '-z', '--', '*.sh', '.githooks/*'], {
    cwd: root,
    encoding: 'utf8'
  })
  return [...new Set(listed.split('\0').filter(Boolean))].sort()
}

const workflows = workflowPaths()

let shell
try {
  shell = shellPaths()
} catch (error) {
  // Failing closed: an empty list here would report "clean" for files it never
  // opened, which is the exact class of silent pass this check exists to stop.
  console.error(`::error::could not list tracked shell scripts — ${error.message}`)
  process.exit(1)
}

const scanned = []
for (const path of [...workflows, ...shell]) {
  // A path can be in the index and absent from the worktree (a staged
  // deletion). Skip it rather than crash; CI checks out a clean tree anyway.
  if (!existsSync(join(root, path))) continue
  scanned.push({ path, text: readFileSync(join(root, path), 'utf8') })
}

const findings = findDoubledEscapesIn(scanned)

for (const { path, line, pattern } of findings) {
  // An annotation, so the failure points at the line in the diff view.
  console.error(`::error file=${path},line=${line}::grep pattern '${pattern}' has a doubled backslash`)
  console.error(`  ${path}:${line}  '${pattern}'`)
}

if (findings.length > 0) {
  console.error(`\nescaped greps: ${findings.length} doubled escape(s) — such a pattern matches a literal`)
  console.error('backslash instead of the text it meant, and the step passes for the wrong reason.')
  process.exit(1)
}

console.log(`escaped greps: ok (${workflows.length} workflow(s), ${shell.length} shell script(s))`)
