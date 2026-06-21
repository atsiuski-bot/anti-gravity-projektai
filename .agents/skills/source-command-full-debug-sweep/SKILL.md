---
name: "source-command-full-debug-sweep"
description: "Autonomous whole-project audit of WORKZ. Deterministic gates (lint/build/deps/firebase-rules-diff) run sequentially; the reasoning phases delegate to the triage-sweep Workflow (parallel finders + adversarial verify). Read-only. NOT a replacement for a diff-scoped review or a pre-ship gate."
---

# source-command-full-debug-sweep

Use this skill when the user asks to run the migrated source command `full-debug-sweep`
(or triggers it with "whole-project audit", "full project sweep", "leave it running for a
long debug", "spare no resources"). It is the cross-tool mirror of
[`.claude/commands/full-debug-sweep.md`](../../../.claude/commands/full-debug-sweep.md);
the per-phase detail lives in
[`docs/audits/FULL_SWEEP_PLAN.md`](../../../docs/audits/FULL_SWEEP_PLAN.md).

## Command Template

Autonomous whole-project audit of WORKZ, structured as **two tracks**:

- **Deterministic track** (sequential, cheap): lint, build, deps audit, Firestore/Storage
  rules diff. No LLM judgement — run and parse. WORKZ has **no TypeScript** and **no test
  runner**, so there is no `tsc` and no test step — the *absence* of automated tests is
  recorded as a finding, not silently skipped.
- **Reasoning track** (parallel + verified): delegated to the **`triage-sweep` Workflow**,
  which fans out one read-only finder per dimension, dedups, then has N skeptics
  adversarially verify each finding (strict majority). The verify stage keeps the
  false-positive rate down.

Read-only — changes NOTHING except local findings files under
`docs/audits/full-sweep-<DATE>/`. **NOT** a replacement for a diff-scoped code review or a
pre-ship gate. Cadence: once every 2–4 weeks, or before a large feature series.

> ⚠️ **Cost.** The reasoning track's full verified run is token-heavy (11 finders + up to
> `maxFindings × skeptics` verifier agents). To preview cheaply first, run with
> `findOnly:true`. NEVER auto-escalate scope. The triage-sweep result returns a measured
> `tokens` breakdown (`{ find, verify, total }`); record it.

---

## STEP 0 — Pre-flight

1. **Worktree guard** (`git branch --show-current`): if `main` → **STOP** ("create a
   worktree first"). If not `claude/*` → WARN + continue.
2. **HEAD SHA snapshot** (`git rev-parse HEAD`) — record in the README (resume protocol).
3. **Output dir**: `DATE=$(date -u +%Y-%m-%d); mkdir -p docs/audits/full-sweep-$DATE`.
   If it already exists and no `--date=` arg was passed → RESUME mode.
4. **README.md skeleton**: Git SHA · branch · worktree path · node/npm · started ts.

> No `.env` guard is needed — WORKZ has no test runner, so there is no test-env Firebase
> collision. Leave `.env` in place.

---

## STEP 1 — Deterministic track (sequential, Bash, fail-soft per step)

1. **Lint** — `npm run lint 2>&1 | tee docs/audits/full-sweep-$DATE/02-lint-raw.txt` →
   `02-lint.md`. (`--max-warnings 0`: any warning is a 🟠.)
2. **Build** — `npm run build` → `05-build.md` (+ copy the dist manifest for the perf
   dimension). Non-zero exit → 🔴.
3. **Deps** — `npm outdated`, `npm audit --json` → `19-deps.md`.
4. **Firebase rules diff** — `firestore.rules` + `storage.rules` only (no
   `firestore.indexes.json`, no Cloud Functions). Note any pending deploy
   (`DEPLOY_FIRESTORE_RULES.md`) → `06-firebase.md`.
5. **Test-coverage gate** — no test script / no test files: record the standing finding
   "zero automated test coverage" in `04-tests.md`.

---

## STEP 2 — Reasoning track (delegate to the triage-sweep Workflow)

```
Workflow({ name: 'triage-sweep' })                       # all 11 dimensions, full verify
Workflow({ name: 'triage-sweep', args: { findOnly: true } })   # cheap preview, no verify
```

The 11 dimensions: discipline · timetracking · crashsafety · session-color · security ·
firebase-coupling · ux-a11y · i18n-brand · perf · docsdrift · deadcode.

Capture `confirmed` findings into `00-reasoning-confirmed.md`; if capped
(`counts.deduped > maxFindings`), note the remainder. Record the `tokens` breakdown.

---

## STEP 3 — Synthesis

Aggregate the deterministic findings + the triage-sweep confirmed findings into
`00-SYNTHESIS.md`: group by severity, dedup across tracks, tag each with an effort
estimate. Update the README with finished ts + totals.

---

## STEP 4 — Report

```
═══ FULL SWEEP COMPLETE ═══
Duration: <hh:mm>   Output: docs/audits/full-sweep-<DATE>/
Deterministic: lint <n> · build <ok?> · deps <n> · rules <n>   (tests: none)
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
3. **Cost discipline.** Run the reasoning track ONCE (all dimensions, verified). Use
   `findOnly` for a preview; never loop it.
4. **Record HEAD SHA** for the resume protocol; resume via the `--date=YYYY-MM-DD` arg.

---

## Notes

- **Why two tracks:** deterministic gates (lint/build/deps/rules) have no LLM value — run
  and parse them. The reasoning dimensions go through `triage-sweep`, whose
  adversarial-verify stage filters the noise and runs in parallel.
- **What WORKZ does NOT have:** no TypeScript (no `tsc`), no test runner (no vitest), no
  Cloud Functions, no RTDB, no `firestore.indexes.json`. The missing index file makes
  every compound query a runtime `FAILED_PRECONDITION` risk — the `firebase-coupling`
  dimension hunts those.
- **[FULL_SWEEP_PLAN.md](../../../docs/audits/FULL_SWEEP_PLAN.md)** is the per-phase detail
  reference; this skill and the command are the condensed form.
