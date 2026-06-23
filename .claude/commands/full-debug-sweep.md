---
description: Autonomous whole-project audit of WORKZ. Deterministic gates (lint/build/vitest/deps/firebase-rules+index-diff/functions-lint) run sequentially; the reasoning phases delegate to the triage-sweep Workflow (parallel finders + adversarial verify). Read-only. NOT a replacement for a diff-scoped review (/debug) or a pre-ship gate (/ship).
allowed-tools: Bash, Grep, Read, Glob, Write, Agent, Workflow
---

Autonomous whole-project audit of WORKZ, structured as **two tracks**:

- **Deterministic track** (sequential, cheap): lint, build, **vitest suite**, deps audit,
  Firestore/Storage rules + index diff, Cloud Functions lint. No LLM judgement — run and
  parse. (WORKZ has **no TypeScript**, so there is no `tsc` typecheck step; but it **does**
  run a **vitest** test suite — failing or missing-coverage tests are recorded as findings.)
- **Reasoning track** (parallel + verified): delegated to the **`triage-sweep`
  Workflow**, which fans out one read-only finder per dimension, dedups, then has N
  skeptics adversarially verify each finding (strict majority). The verify stage is
  what keeps the false-positive rate down — a flat sequential sweep with no
  verification is noise-heavy.

Read-only — changes NOTHING except local findings files under
`docs/audits/full-sweep-<DATE>/`. **NOT** a replacement for a diff-scoped code review
or a pre-ship gate. Cadence: once every 2–4 weeks, or before a large feature series.

> ⚠️ **Cost.** The reasoning track's full verified run is token-heavy (11 finders +
> up to `maxFindings × skeptics` verifier agents). That is the deliberate, infrequent,
> opt-in cost of a full audit. To preview cheaply first, run the reasoning track with
> `findOnly:true` (finders only, no verify fan-out). NEVER auto-escalate scope —
> scoping / `findOnly` is the default discipline.
>
> The cost is measured, not guessed: the triage-sweep result returns a `tokens`
> breakdown (`{ find, verify, total }` output tokens) and logs per-phase spend live.
> Record it (below). If the run was launched with a `+Nk` budget target, the workflow
> also caps the verify fan-out to fit the remaining budget — a guard against a scope
> blow-up after the find phase is measured.

Triggers (run even if the user did not type `/full-debug-sweep`): "whole-project audit",
"full project sweep", "leave it running for a long debug", "spare no resources".

---

## STEP 0 — Pre-flight

1. **Worktree guard** (`git branch --show-current`): if `main` → **STOP** ("create a
   worktree first; do not sweep from main"). If not `claude/*` → WARN + continue.
2. **HEAD SHA snapshot** (`git rev-parse HEAD`) — record in the README (resume protocol).
3. **Output dir**: `DATE=$(date -u +%Y-%m-%d); mkdir -p docs/audits/full-sweep-$DATE`.
   If it already exists and no `--date=` arg was passed → RESUME mode.
4. **README.md skeleton** with: Git SHA · branch · worktree path · node/npm version ·
   started ts.

> `.env` does NOT need quarantining — the vitest suite is **pure unit tests** of `src/utils/*`
> (time math, session/report logic) that never touch a live Firebase, so there is no test-env
> Firebase collision to guard against. Leave `.env` in place.

---

## STEP 1 — Deterministic track (sequential, Bash, fail-soft per step)

Run in order; a failure in one step does NOT stop the others. Parse each into a findings
file per the [FULL_SWEEP_PLAN.md](../../docs/audits/FULL_SWEEP_PLAN.md) template.

1. **Lint** — `npm run lint 2>&1 | tee docs/audits/full-sweep-$DATE/02-lint-raw.txt` →
   `02-lint.md`. (`eslint . --ext js,jsx --max-warnings 0` — any warning fails CI, so
   every warning is a 🟠.)
2. **Build** — `npm run build 2>&1 | tee build-raw.txt` → `05-build.md`. Non-zero exit →
   🔴 "build broken". Copy `dist/.vite/manifest.json` to `05-build-stats.json` and flag
   oversized chunks / unoptimized assets / PWA-precache bloat for the perf dimension.
3. **Deps** — `npm outdated`, `npm audit --json` at the root → `19-deps.md`. WORKZ now also
   has a **`functions/` subtree** (Cloud Functions, its own `package.json`) — run
   `npm --prefix functions run lint` and record its result too.
4. **Firebase deterministic diff** — `firestore.rules`, `storage.rules`, **and
   `firestore.indexes.json`** (the repo now ships ~11 composite indexes) + the **`functions/`**
   subtree. Check rules + index freshness vs the live project via the Firebase MCP reads
   (`firestore_get_security_rules`, `firestore_list_indexes`, `functions_list_functions`) and
   the EU-region/`darbo-planavimas` project context → `06-firebase.md`. A local index or
   function not yet deployed is a latent prod outage (a compound query hits
   `FAILED_PRECONDITION`; a stale callable runs old code). Deploy itself is human-only. (Rules
   privilege-escalation + coupling *reasoning* belongs to the reasoning track, not here.)
5. **Test gate** — WORKZ runs a **vitest** suite (`npm test` → `vitest run`, ~20+ co-located
   `*.test.js` files). Run it → `04-tests.md`. Any failing test → 🔴 with the test name. Then
   record the **coverage gaps** as findings: time-tracking / session / crash-safety paths
   without a guarding suite are 🟠 "unguarded against regression" — the absence is named
   per-module, not as a blanket "no tests" (that is no longer true).

---

## STEP 2 — Reasoning track (delegate to the triage-sweep Workflow)

Run the `triage-sweep` Workflow with all dimensions and verification on:

```
Workflow({ name: 'triage-sweep' })          # all 11 dimensions, full adversarial verify
```

Optionally first, for a cheap preview before paying for verification:

```
Workflow({ name: 'triage-sweep', args: { findOnly: true } })   # finders only, no verify
```

The 11 dimensions cover every reasoning phase of the plan:

| triage dimension | plan phase(s) |
|---|---|
| discipline | static patterns · convention discipline |
| timetracking | time-math & session-duration integrity |
| crashsafety | crash log + orphaned-session recovery |
| session-color | signature whole-screen session color invariant |
| security | firestore/storage rules privilege + secrets |
| firebase-coupling | rules ↔ queries · missing composite indexes · storage paths |
| ux-a11y | UX / WCAG 2.1 AA / dual-density |
| i18n-brand | Lithuanian "Jūs" copy voice + retired-brand check |
| perf | performance / onSnapshot listener leaks |
| docsdrift | documentation drift |
| deadcode | dead code & orphan rules |

Capture the workflow's `confirmed` findings (false positives already filtered) into
`docs/audits/full-sweep-$DATE/00-reasoning-confirmed.md`. If the result was capped
(`counts.deduped > maxFindings`), note the uncovered remainder. Also record the result's
`tokens` breakdown (`{ find, verify, total }`) — the measured reasoning-track cost — in
the README and the STEP 4 report, so future runs are sized from real numbers.

> A PWA-artifact check (manifest + service worker present in `dist/`) and a browser
> smoke pass stay optional deterministic add-ons: run them as plain Agent/Bash steps if
> `dist/` and a dev server are available, otherwise write a SKIPPED note with the reason.

---

## STEP 3 — Synthesis

Aggregate the deterministic findings files + the triage-sweep confirmed findings into
`00-SYNTHESIS.md`: group by severity, dedup across tracks, tag each with an effort
estimate. Update the README with finished ts + totals.

---

## STEP 4 — Report

```
═══ FULL SWEEP COMPLETE ═══
Duration: <hh:mm>   Output: docs/audits/full-sweep-<DATE>/
Deterministic: lint <n> · build <ok?> · vitest <pass/fail> · deps <n> · rules+indexes <n> · fns-lint <ok?>
Reasoning (verified): 🔴 X · 🟠 Y · 🟡 Z   (false positives filtered: <n>)
Reasoning cost (measured): ~<tokens.total> output tok  (find <tokens.find> · verify <tokens.verify>)
Read 00-SYNTHESIS.md for the prioritized fix list. The sweep changed nothing.
```

---

## Critical rules

1. **READ-ONLY.** Only write to `docs/audits/full-sweep-$DATE/`. No code edits, no
   commit/push/branch/reset/restore, no prod writes, no Firebase deploy.
2. **Fail-soft.** A single step/dimension failure → mark `⚠️ PARTIAL`, log the error
   excerpt, continue. Never abort the whole sweep.
3. **Cost discipline.** The reasoning track is the expensive part. Run it ONCE (all
   dimensions, verified). Use `findOnly` for a preview; never loop it.
4. **Record HEAD SHA** for the resume protocol; resume via the `--date=YYYY-MM-DD` arg.

---

## Notes

- **Why two tracks:** deterministic gates (lint/build/deps/rules) have no LLM value — run
  and parse them. The reasoning dimensions go through `triage-sweep`, whose
  adversarial-verify stage filters the noise and runs in parallel.
- **What WORKZ does / does NOT have** (so the dimensions stay accurate): **no TypeScript**
  (so no `tsc` typecheck — JS only) and **no RTDB**. It **does** have a **vitest** suite, a
  **`firestore.indexes.json`** (~11 composite indexes), and a **`functions/` Cloud Functions
  subtree** (callables `parseTaskDraft`, `runRecurringTasksNow`, plus FCM push senders +
  Storage cleanup). The `firebase-coupling` dimension hunts compound queries whose composite
  index is missing/undeployed (runtime `FAILED_PRECONDITION`) and callables/functions changed
  but not yet deployed (stale prod code) — both human-only deploys.
- **[FULL_SWEEP_PLAN.md](../../docs/audits/FULL_SWEEP_PLAN.md)** is the per-phase detail
  reference (what each deterministic step parses; each dimension's checklist).
  triage-sweep's inline dimension prompts are the condensed form; the plan is the long form.
