# The ledger and the scopes

Design for the layer that lets WARDEN act on a person's behalf without becoming
a surveillance product. Nothing here is built: this is the contract the OS work
would be held to, written so the first line of code has a shape to fit.

Two artefacts:

- **the ledger** — what the machine remembers about a person's browsing, tasks
  and rhythm, where it lives, and how it is forgotten;
- **the scopes** — who may read that memory and who may act on it, expressed
  per site, per data class, per task, with a default of no.

The browser is the first surface; the same service is meant to back the OS
shell, mail, terminal and whatever ships next.

---

## 1. Principles

1. **Local first, local only by default.** The ledger is a file on the machine.
   Nothing leaves it without a scope that names the destination.
2. **Observe → suggest → act.** Each rung is a separate permission. Autonomy is
   the third rung granted for a task, not a global mode.
3. **Every action is attributable and reversible.** An action without an undo
   handle or a documented irreversibility must be confirmed by a person.
4. **Collect the minimum that makes the task work.** No keystroke logging, no
   form values, no scroll traces, no cross-site identifiers built from content.
5. **A person can read the memory and the rules.** "Why did it do that?" is a
   first-class query, not a support ticket.

---

## 2. The ledger

### 2.1 What is recorded

| Record | Contents | Why |
| --- | --- | --- |
| `Visit` | origin, normalised path, title, enteredAt, leftAt, dwellMs, referrerHost, scrollDepthBucket | the unit of memory; everything else derives from it |
| `PageNote` | a short local summary (≤ 280 chars) and up to 8 extracted entities (product, order id, ticket id) | makes recall and task inference possible without storing pages |
| `Task` | title, status, startedAt, endedAt, site origins involved, evidence visit ids, confidence | "assimilate your tasks" |
| `Intent` | typed request a person or an app made (`book`, `pay`, `reply`, `monitor`), parameters, status | the OS integration point |
| `Preference` | scope of the preference (site / workspace / global), key, value, source (`explicit` \| `inferred`), confidence | adaptive UI, with provenance |
| `Rhythm` | hour-of-day buckets: active, focused, idle, away | quiet hours, when to engage |
| `ActionRecord` | plan id, actor, verb, target, scope id, startedAt, outcome, undo handle | the audit trail for autonomy |

### 2.2 What is never recorded

- keystrokes, clipboard contents, form field values, card numbers, passwords;
- page DOM or screenshots outside an explicit Scry capture the person started;
- TLS secrets, auth tokens, session cookies;
- mail bodies or attachment contents (a mail *summary* is a separate, opt-in
  data class with its own scope);
- anything from a window marked private/cloaked beyond its lifetime — a cloaked
  tab writes nothing to the ledger except an anonymised `Visit` with the host
  omitted when the person turns that off.

### 2.3 Where it lives

One SQLite database per machine, at `userData/ledger.db`, opened only by the
ledger service (never by the renderer, never by a page). Encryption at rest with
a key held in the OS keychain (the `SecretVault` pattern already used for mail
and the Genie key). WAL mode; a single writer; reads through a query API.

```sql
CREATE TABLE visit (
  id INTEGER PRIMARY KEY,
  origin TEXT NOT NULL,            -- scheme://host[:port]
  path TEXT NOT NULL,              -- normalised, query stripped except known id params
  title TEXT,
  entered_at INTEGER NOT NULL,
  left_at INTEGER,
  dwell_ms INTEGER,
  referrer_host TEXT,
  cloaked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX visit_origin_time ON visit(origin, entered_at);

CREATE TABLE note (
  visit_id INTEGER PRIMARY KEY REFERENCES visit(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  entities TEXT NOT NULL           -- JSON array of {kind,value}, capped
);

CREATE TABLE task (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER, ended_at INTEGER, origins TEXT, evidence TEXT, confidence REAL
);

CREATE TABLE scope (
  id TEXT PRIMARY KEY, subject TEXT NOT NULL,        -- genie | executor | app:<id>
  verbs TEXT NOT NULL, target_kind TEXT NOT NULL, target TEXT NOT NULL,
  constraints TEXT, issued_by TEXT NOT NULL, issued_at INTEGER NOT NULL,
  expires_at INTEGER, revoked_at INTEGER
);

CREATE TABLE action (
  id TEXT PRIMARY KEY, plan_id TEXT, scope_id TEXT REFERENCES scope(id),
  verb TEXT, target TEXT, started_at INTEGER, outcome TEXT, undo TEXT
);
```

### 2.4 Write path

1. **Redact before write.** A single `redact()` runs on every string: emails,
   long digit runs, token-shaped strings, and anything matching a secret
   pattern are replaced with `«redacted»`. This is the same concern the
   repository's secret scanner already encodes; the ledger reuses it.
2. **Normalise URLs.** Query strings are dropped except an allowlist of id
   parameters (`id`, `order`, `ticket`, `q`); fragments are dropped. The OS
   should not need full URLs to remember intent.
3. **Cap.** Notes ≤ 280 chars, entities ≤ 8, tasks per day ≤ 200; older raw
   rows are aggregated and then deleted on the retention schedule.
4. **Never block the page.** Writes are queued and flushed off the UI path,
   exactly as `JsonStore` debounces today.

### 2.5 Retention and forgetting

| Class | Default | Editable |
| --- | --- | --- |
| raw visits | 14 days | yes, 1–365 |
| notes | 90 days | yes |
| tasks & intents | until the task is closed + 90 days | yes |
| preferences & rhythm | until reset | yes |
| action audit | 1 year | no (safety) |

Three forgetting verbs, all real deletions with `VACUUM` afterwards:

- `forget(site)` — every visit, note and derived entity for one origin;
- `forget(day)` — a time range, for the day someone was researching something
  they would rather not keep;
- `forget(all)` — one button in Policy, no confirmation theatre, no backup copy.

### 2.6 Inference

Summaries, entity extraction and task inference run locally, on a queue, when
a person has been idle for a while. A remote model is only ever reached through
a scope that names the provider and the data class, and the UI shows which
pages were sent. The default local pair is a small classifier for "is this a
task?" plus the summariser already used by Scry.

---

## 3. Per-site permission scopes

A scope is a signed, expiring grant: *subject may do verbs on target under
constraints*. Everything else is denied.

### 3.1 Vocabulary

```ts
type Verb = 'observe' | 'read-ledger' | 'suggest' | 'act' | 'delegate' | 'spend' | 'export'
type TargetKind = 'site' | 'data-class' | 'task' | 'workspace'
type DataClass = 'page-text' | 'page-url' | 'mail-summary' | 'mail-body' | 'calendar' | 'clipboard'
type Risk = 0 | 1 | 2 | 3   // observe · local reversible · external side effect · irreversible
```

- `observe` — may see page content while the person is on it. Never persistent.
- `read-ledger` — may query visits/notes/tasks, filtered by the scope's target.
- `suggest` — may put a proposal in front of the person.
- `act` — may perform a step of an approved plan.
- `delegate` — may hand a narrowed scope to a sub-agent; may never widen it.
- `spend` — may consume metered resources (gateway credits, paid APIs).
- `export` — may hand data to a named destination outside the machine.

### 3.2 Risk tiers and who approves

| Tier | Example | Approval |
| --- | --- | --- |
| 0 | read the open page to answer a question | scope needed once per site, granted on first use |
| 1 | reorder the UI, remember a preference, draft a note | automatic once `suggest`/`act` for that workspace exists |
| 2 | submit a form, send mail, post a comment, add to calendar | per-action confirmation unless the task scope pre-approves that step type |
| 3 | pay, delete, change credentials, grant a new scope, export | explicit confirmation every time; never delegated |

The browser already has the interaction for this: the challenge bar explains a
situation and offers one action, and the shield panel shows what was blocked.
Scopes should look the same — one sentence, one primary action, one dismissal
that is remembered.

### 3.3 Resolution

```
effective(subject, verb, target) =
  narrowest grant whose subject matches, whose verb is included,
  whose target covers (target), whose constraints hold now, and which is not revoked
  → then risk-tier approval
  → else deny
```

- **Default deny**, including for Genie. A site the person has not granted is
  invisible to `read-ledger` and `observe` beyond the active tab.
- **Per site by default.** A grant names an origin (`distro.innotel.us`) or a
  registrable domain when the person chooses "all of innotel.us".
- **Task scopes narrow and expire.** Starting a task ("book the cheapest
  direct flight on Friday") asks for `act:site` for those origins for the
  duration of the plan, plus `spend` if a model must be called.
- **Delegation only narrows.** A plan stage may hand a sub-agent a scope with
  fewer verbs, a subset of targets and a shorter expiry. The child's actions
  are attributed to the parent plan id.
- **Constraints** carry the limits that matter: expiry, max actions, allowed
  hours, allowed hours off (quiet), dollar/credit budget, and whether the agent
  may act while the person is away (`never` by default).

### 3.4 What the person sees

- **First use of a site:** "Genie would like to read pages on
  `distro.innotel.us` while you are on them." Allow once, allow for this site,
  deny.
- **Before a risky step:** the step, the target, the effect, and the undo. Two
  buttons, never a checkbox buried in settings.
- **While a plan runs:** a strip with the plan, the current step, what it has
  done, and one Stop. Agent tabs are visually distinct from the person's tabs.
- **Afterwards:** an audit entry with the plan, the pages read, the actions
  taken, and what can be undone.

### 3.5 Service shape

```ts
interface Ledger {
  record(event: LedgerEvent): void              // fire-and-forget, redacted, queued
  query(q: LedgerQuery, scope: ScopeId): Promise<LedgerRow[]>
  forget(target: ForgetTarget): Promise<void>
}

interface ScopeBroker {
  request(req: ScopeRequest): Promise<Scope | null>   // may raise a UI prompt
  check(scope: ScopeId, action: Action): Promise<'allow' | 'confirm' | 'deny'>
  revoke(id: ScopeId): void
  list(filter?: { subject?: string; site?: string }): Scope[]
}
```

Both live in the main/service process. The renderer and pages never import
them; the OS shell talks to the same service over IPC. Genie's tools are
gated in one place — the tool runner asks `check()` before every effect and the
ledger only answers queries it was scoped for.

---

## 4. Threat model

| Threat | Mitigation |
| --- | --- |
| **Prompt injection** from page text instructing the agent | page content is data, never instructions: the planner sees it inside a delimited, untrusted block; tools check scopes, not prose; every effect is confirmed by tier |
| **Exfiltration** through the agent's own network calls | `export` is its own verb naming a destination; the executor has no egress except the plan's approved origins |
| **Inference leakage** (summaries leaking a private page into a shared task) | notes inherit the visit's site; queries filter by scope; tasks never aggregate across sites unless granted |
| **Scope escalation** via delegation | child scopes are intersected with the parent's; `delegate` cannot appear in a child |
| **Shared machine** | ledger key in the OS keychain; lock screen clears agent sessions; "forget all" is a real delete |
| **Remote model logging** | provider named in the scope; payload preview before first send; no content sent for sites without `observe` |
| **Poisoned memory** (a wrong preference learned once) | every inferred preference is a proposal with provenance, visible and revertible; explicit preferences always win |
| **Backup/sync leakage** | no sync in v1; any future sync encrypts end-to-end with a device key and needs `export` |

---

## 5. Delivery plan

| Phase | Scope | Acceptance |
| --- | --- | --- |
| **P0 — remember** | ledger service, redaction, retention, Policy page listing sites, forget buttons | no page is written before the person sees the store; forget actually zeroes the rows; a cloaked tab leaves nothing with content |
| **P1 — suggest** | task inference from visits, "pick up where you left off", adaptive workspace suggestion | suggestions explain their evidence; dismissals are remembered; zero network egress by default |
| **P2 — act, supervised** | plan runner, per-step confirmation at tier 2, undo handles for mail/calendar/forms | a five-step task completes with a human approval per risky step; Stop halts within one step; every action has an audit row |
| **P3 — driver mode (5.0)** | self-directed plans for a single task on granted sites, approvals only at tier 2+, bubbling to the person at a threshold | approvals per task trend down while undo stays flat; the browser can always be taken back by closing the agent tab |

Metrics that decide whether autonomy is real: time-to-task, approvals per
task, false-action rate, undo rate, and how often the person takes the wheel
back. A falling approval count with a rising undo count is not autonomy; it is
guessing.

---

## 6. Anti-goals

- No cloud index of a person's browsing.
- No ad or "insights" profiling, ever; the ledger is not a data product.
- No reading of password fields or card numbers, at any tier.
- No cross-device sync without an explicit, encrypted, `export`-scoped action.
- No silent adaptation: every interface change the agent makes has a why and a
  revert.

---

## 7. Open questions for the owner

1. Retention defaults: 14 days of raw visits is conservative; is 30 the better
   default for an operations browser?
2. Rhythm learning and "nap times": is that a local heuristic (idle windows) or
   an explicit schedule the person sets? Explicit is safer and simpler.
3. Remote inference: which providers are allowed by default, and does the
   gateway's data-retention policy permit page text at all?
4. Does the OS layer own the ledger, with the browser as a client, or does the
   browser own it and the OS reads? The former is cleaner once more than one app
   needs it.
5. Per-app consent: should third-party apps see the ledger through scopes, or
   only through intents the person explicitly starts?
