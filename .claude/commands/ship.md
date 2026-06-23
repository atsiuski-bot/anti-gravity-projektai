---
description: One-command ship for WORKZ. Commit the current branch → pull/merge origin/main → run the lint+build+test quality gate → fast-forward push to origin/main (which auto-deploys via Cloudflare Pages). Worktree-safe (never checks out main). STOPS on merge conflicts or a failing gate — never force-pushes, never auto-resolves conflicts, never opens a PR. Run ONLY on the explicit /ship command — it ships to PRODUCTION.
allowed-tools: Bash, Read, Grep, Glob
---

# /ship — commit · merge · push → prod

Take the work on the current branch and ship it to `origin/main` in one shot. A push to
`main` is auto-deployed by **Cloudflare Pages** (`anti-gravity-projektai.pages.dev`) — and
in parallel by Netlify `workztest1` — so **this command deploys to production.**

`/ship` is itself the human-initiated trigger CLAUDE.md requires: deploy is never autonomous,
but a human typing `/ship` *is* the authorization. Because of that, do **not** add an extra
interactive "are you sure?" — the quality gate and the conflict-stop are the safeguards.
Print a one-line "about to push" summary, then push.

## Why this shape

- **Worktree-safe.** WORKZ work happens in worktrees under `.claude/worktrees/`; `main` is
  usually checked out in the primary repo, so `git checkout main` here would fail. We never
  switch to main — we fast-forward the *remote* main to the current branch tip with
  `git push origin HEAD:main`. Updating only the remote ref is safe and triggers the deploy.
- **Integrate before shipping.** We merge `origin/main` into the branch first, so any
  conflict surfaces *on the branch* (where it's safe to stop), and the subsequent push is a
  clean fast-forward.
- **Gate before prod.** `npm run lint` (zero warnings) + `npm run build` + `npm test` must pass
  before the push — per CLAUDE.md's quality gate plus the time-credit test gate
  ([ADR 0013](../../docs/adr/0013-test-gate-for-time-credit.md)). A broken build or a regressed
  ghost-time path must never reach `main`.

---

## Procedure

Run these with the **Bash tool** (Git Bash). Each STOP means: report clearly and do not
continue — no push happens.

### 1 — Pre-flight guards

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo "branch: $BRANCH"
git rev-parse -q --verify MERGE_HEAD && echo "MERGE-IN-PROGRESS" || echo "clean-merge-state"
```

- If `BRANCH` is `HEAD` (detached) → **STOP**: "Detached HEAD — checkout a branch first."
- If `MERGE_HEAD` exists (a merge is half-done from a previous run) → **STOP**: list the
  conflicted files (`git diff --name-only --diff-filter=U`) and tell the user to resolve +
  `git commit`, or `git merge --abort`, then re-run `/ship`. **Do not** `git add -A` over an
  unresolved merge — that would commit conflict markers.

### 2 — Fetch latest main

```bash
git fetch origin main
```

### 3 — Commit current work (with mandatory metadata)

```bash
git add -A
```

- If there is nothing staged **and** `git rev-list --count origin/main..HEAD` is `0` →
  **STOP**: "Nothing to ship — branch is already even with origin/main." (Done, success.)
- If there is nothing staged but the branch is *ahead* of main → skip the commit, go to
  step 4 to ship the existing commits.
- Otherwise compose a commit. Read the staged diff (`git diff --cached --stat` and the
  relevant hunks) and write an accurate **Conventional Commits** subject. Every commit MUST
  carry the WORKZ metadata block (CLAUDE.md). `Reason:` is English, persisted.

```bash
git commit -F - <<'EOF'
type(scope): imperative summary of what changed

Optional body explaining the why if the subject isn't enough.

[ai-author: claude-opus-4-8]
Reason: <one line — why this change is correct / what rule or goal it serves>
EOF
```

> Use the running model's id in `[ai-author: ...]` (e.g. `claude-opus-4-8`).

### 4 — Integrate origin/main into the branch

```bash
git merge --no-edit origin/main
```

- **On merge conflict → STOP.** Do **not** abort, do **not** resolve. Report:
  - the conflicted files: `git diff --name-only --diff-filter=U`
  - instruction: resolve the markers, `git add` them, `git commit`, then re-run `/ship`
    — or `git merge --abort` to back out entirely.
  This mirrors `/sujunk`: never auto-resolve a conflict.
- (If `BRANCH` is already `main`, this is the normal "merge in upstream" step — same rules.)

### 5 — Quality gate (lint + build + test) — required before any push

```bash
npm run lint
```
- Non-zero exit → **STOP**: "Lint failed — not shipping." Show the failing output.

```bash
npm run build
```
- Non-zero exit → **STOP**: "Build failed — not shipping." Show the failing output.

**Test gate** ([ADR 0013](../../docs/adr/0013-test-gate-for-time-credit.md)) — covers the
stateful time-credit / ghost-time paths. First confirm the runner is resolvable, so a missing
`vitest` is a *clear, actionable stop* rather than a spurious red (a worktree has no local
`node_modules`; it resolves the runner from the primary checkout's, the same as lint/build):

```bash
node -e "require.resolve('vitest/package.json')" >/dev/null 2>&1 && echo RUNNER_OK || echo RUNNER_MISSING
```

- `RUNNER_OK` → run the suite:
  ```bash
  npm test
  ```
  Non-zero exit → **STOP**: "Tests failed — not shipping." Show the failing output.
- `RUNNER_MISSING` → **STOP**: "Test runner not installed in this worktree's module-resolution
  path — not shipping without the test gate. Run `npm install` here (or refresh the primary
  checkout's `node_modules` so worktrees resolve `vitest` from the parent, like lint/build),
  then re-run `/ship`." Do **not** skip the gate and push.

### 6 — Ship (fast-forward push to remote main)

```bash
echo "Shipping $BRANCH → origin/main (Cloudflare will auto-deploy)"
git push origin HEAD:main
```

- This is a **fast-forward** because step 4 merged `origin/main` into the branch. **Never**
  use `--force` / `--force-with-lease` here.
- **If the push is rejected as non-fast-forward** (someone pushed to main between step 2 and
  now): re-run steps 2 → 4 → 5 (fetch, merge, re-gate) **once**, then retry the push. If it
  still fails → STOP and report; do not loop.

### 7 — Sync local main (best-effort)

```bash
[ "$BRANCH" != "main" ] && git fetch origin main:main || true
```

- This keeps the local `main` ref current so `/prune-worktrees` later recognises this branch
  as merged. **Fail-soft:** if `main` is checked out in another worktree, git refuses to
  update the ref — that's expected and harmless; note it and move on. The ship already
  succeeded (origin/main advanced).

### 8 — Report

State plainly:
- the commit SHA(s) now on `origin/main`,
- that `origin/main` advanced and **Cloudflare Pages auto-deploy has been triggered**,
- where to watch it (Cloudflare Pages dashboard for `anti-gravity-projektai` /
  `anti-gravity-projektai.pages.dev`).

---

## What `/ship` does NOT do

- **No PR.** It pushes straight to `main` by design. If you want review, open a PR manually
  instead of running `/ship`.
- **No force-push, no history rewrite.** Only fast-forward pushes to `main`.
- **No conflict auto-resolve.** Conflicts always stop the command.
- **No Firestore/Storage rules deploy.** `firestore.rules` / `storage.rules` ship via a
  separate, human-run `firebase deploy --only firestore:rules` (see the deploy runbook and
  CLAUDE.md) — a code push to main does not deploy rules.
- **No composite-index deploy.** `firestore.indexes.json` is **not** shipped by a code push.
  If this change added a compound query (`where`+`orderBy`, two `where`, or `collectionGroup`)
  that needs a new index, the index must be deployed separately
  (`firebase deploy --only firestore:indexes`, human-run) **before** the query runs in prod —
  otherwise it fails at runtime with `FAILED_PRECONDITION` even though the code shipped clean.
- **No Cloud Functions deploy.** The `functions/` subtree (callables `parseTaskDraft`,
  `runRecurringTasksNow`, FCM senders, Storage cleanup) deploys via a separate, human-run
  `firebase deploy --only functions` — a code push to main runs only the **client** on
  Cloudflare; an undeployed functions change leaves stale code in prod. Verify the live runtime
  via the Firebase MCP, not the deploy log.
- **No silent test skip.** The test gate (step 5) is part of the gate now; if the runner is
  unavailable it STOPs with remediation rather than pushing untested ([ADR 0013](../../docs/adr/0013-test-gate-for-time-credit.md)).

> **Before `/ship`, consider `/debug`.** `/ship` is a fail-fast lint+build+test gate on the
> *code*; it does not reason about **blast radius** — a new index/callable/rule the push
> won't deploy, a rules-field the write will be rejected for, a session-color or design-system
> regression. `/debug` is the diff-scoped change-impact sweep that surfaces exactly those
> deploy-coupling gaps before they reach prod. Run `/debug`, clear the 🔴s, then `/ship`.
