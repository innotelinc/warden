#!/usr/bin/env node
// A push is addressed by the commit that leaves, not by the branch in the argument: tooling
// that sends HEAD and labels the destination with whatever name it was given reports success
// while another branch's commits land on that name. So compare the two instead of assuming
// they are equal — the push is finished when this passes, not when the push returns.
//
//   npm run check:push -- <branch> [--remote origin]
//
// Exits 0 only when HEAD is that branch's tip and the remote ref is the same commit.
// See "A push is checked against the branch it names" in docs/repo-hooks.md.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const short = (sha) => (sha ? sha.slice(0, 7) : '(none)')

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

function fail(message) {
  console.error(`check-push: ${message}`)
  process.exit(1)
}

const usage = 'usage: npm run check:push -- <branch> [--remote origin]'

let parsed
try {
  parsed = parseArgs({ allowPositionals: true, options: { remote: { type: 'string', default: 'origin' } } })
} catch (error) {
  fail(`${error.message} — ${usage}`)
}

const [branch, ...extra] = parsed.positionals
if (!branch || extra.length) fail(usage)
const remote = parsed.values.remote

const localTip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
if (!localTip) fail(`no local branch ${branch} — a push cannot have sent it`)

const head = git(['rev-parse', 'HEAD'])
if (head !== localTip) {
  const heading = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  fail(`HEAD is ${short(head)} on ${heading}, not ${branch} at ${short(localTip)} — a push sends HEAD`)
}

const listing = git(['ls-remote', '--heads', remote, `refs/heads/${branch}`])
if (listing === null) fail(`could not read ${remote}/refs/heads/${branch}`)
if (!listing) fail(`${remote} has no refs/heads/${branch} — the push landed nowhere`)

const remoteTip = listing.split(/\s+/)[0]
if (remoteTip !== localTip) {
  fail(`${remote}/${branch} is ${short(remoteTip)}, expected ${short(localTip)} (${branch} locally) — a different commit left`)
}

console.log(`check-push: ${remote}/${branch} is ${short(localTip)} — matches ${branch}`)
