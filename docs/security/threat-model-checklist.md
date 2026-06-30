# WORKZ — Threat model & security-test checklist

A standing, Firebase-shaped threat model for WORKZ. Use it as the security lens for
`/security-review`, and run it **before any `firestore.rules` / `storage.rules` /
`functions` change** — those are the security boundary, and their deploy is the irreversible,
human-only step (see [CLAUDE.md](../../CLAUDE.md) "human-only boundary").

It is retargeted to **how WORKZ actually enforces security** — not generic web app advice:

- **Identity** is a Firebase Auth token; `request.auth.uid` is the only trustworthy actor id.
- **Security is the rules, not the client.** `firestore.rules` / `storage.rules` are the
  enforcement surface; client checks are UX, not protection. A capability that is only gated
  in React is **not** gated.
- **Reads are intentionally broad, writes are scoped.** Workers see team-wide data (Reports,
  the shift calendar query whole collections by design). Confidentiality lives on the **write**
  side and on a few read-restricted fields — do **not** assume a private-looking row is
  read-protected unless a rule says so.
- The product runs on **one shared project** (`darbo-planavimas`); there is no staging copy to
  catch a bad rule. Last-write-wins, no version guard.

---

## STRIDE — the six lenses, in WORKZ terms

### S — Spoofing (can someone act as another identity?)
- Every write rule must require `request.auth != null` and key the write to `request.auth.uid`.
- **Provenance pins:** a row that records *whose* time/identity it is must pin that owner so a
  caller can't write a record attributed to someone else — the `userId` pin on `work_hours` /
  `work_sessions` / `break_sessions` (no UPDATE may move `userId`), and `actorId == uid` on
  `decision_log` and `calendar_requests`.
- Self sign-up is **inert until an admin approves** (pending-approval gate) — a fresh account
  cannot act before promotion.

### T — Tampering (can a record be set to an impossible/forged value?)
- **Shape & range validation in rules:** `durationMinutes ∈ [0, 1440]` on session rows, string
  `start`/`end` on `work_hours`, validated **only when present (create) or changed (update)** so
  partial updates and corrupt-row remediation still pass.
- **Privileged fields are not self-writable:** `role`, `payRate.tiers`, `teamManagerIds`,
  `seniorManagerIds`, `isTest` are admin-only; `overseerIds` is **function-only** (no client
  write at all); `isDisabled` gates work and must not be self-cleared.
- Server-derived values (credited `durationMinutes`, Vilnius day bucket, `overseerIds` closure)
  are derived/clamped, never trusted from the client.

### R — Repudiation (can we reconstruct who did what?)
- `decision_log` is the **append-only** audit spine (doc id = idempotency key; `actorType`
  pinned; manager/admin read; admin-only delete). A new audited mutation goes through a
  `defineCommand` command, not an inline `addDoc`.
- Per-session edits keep **mutate-in-place + original snapshot + reason**.
- Code changes carry the `[ai-author] / Reason` commit metadata so a human can `git log
  --grep` and revert.

### I — Information disclosure (what leaks, and to whom?)
- **Read-restricted fields:** `payRate` (NET hourly rates) and anything personal must be
  checked — broad-read collections can still over-expose a sensitive field on the user doc.
- **Secrets:** only service-account JSON / admin/private keys are real secrets. Web
  `apiKey`/`projectId`/`appId`/`authDomain` and the **VAPID public** key are public client
  config and ship in the bundle — no ceremony. `.env.local` is gitignored (public repo: never
  commit it).
- **Never render raw `err.message`** to a user — map to friendly Lithuanian copy so internal
  paths / rule errors don't leak.
- Storage download URLs grant access by possession — don't log or notify them broadly.

### D — Denial of service / durability (can the data be destroyed or run away?)
- The **four-layer durability net** is the answer to "an agent or bug deletes the work-hours":
  PITR + delete-protection (7-day rewind), scheduled backups, rules range-validation, and the
  `dailyIntegrityScan` volume-drop canary. A change near time/session data must not weaken any
  layer.
- **Unbounded queries** are a cost/availability risk — prefer scoped, indexed reads; a missing
  composite index fails the query (and a broad `array-contains` over a whole collection is a
  read-cost surface).

### E — Elevation of privilege (the highest-risk class for WORKZ)
- **IDOR / ownership:** for every private surface (`tasks`, `archived_tasks`, `deleted_tasks`,
  `work_sessions`, `break_sessions`, `work_hours`, `calendar_requests`), confirm a non-owner,
  non-admin, out-of-scope user can neither read-where-restricted nor **write**. The write rule
  is `isAdmin() || owner || isNamedTaskOverseer() || uid in overseerIds/teamManagerIds`.
- **Self-escalation:** a user must not be able to grant themselves `role:'admin'`, a richer
  `payRate`, membership in `overseerIds`, or clear their own `isDisabled`.
- **Scope-boundary writes:** a scoped/senior manager writes only within their `overseerIds`
  closure. (Known sharp edge: a manager finishing their **own** out-of-scope task must fall
  back gracefully on `permission-denied`, not hard-fail — see the finish-fallback fix.)
- **`.get()`-on-both-sides traps:** rules that read a field which legacy docs may **lack**
  (e.g. the historical `isDisabled` dot-access bug) must default safely, or they lock out valid
  users / let invalid ones through.
- **Business-logic races:** rapid session toggles go through the per-user `sessionLock`;
  server closers are **idempotent** (deterministic ids + `create()`) so client and server can't
  double-credit; the boot orphan-recovery decision is **latched** so midnight can't re-finalize
  a live session.

---

## Pre-change security-test checklist

Run this list against any change that touches rules, Cloud Functions, auth, a private
collection, or time/session math. Default each item to **NEEDS WORK** until checked.

1. **AuthN present** — every write rule requires `request.auth != null` and keys to `uid`.
2. **Ownership / IDOR** — a non-owner, non-admin, out-of-scope user is denied read (where
   restricted) **and** write on every private collection touched. The `userId`/`actorId`
   owner pin survives UPDATE (can't be reassigned).
3. **Privilege fields** — `role`, `payRate`, `teamManagerIds`/`seniorManagerIds`,
   `overseerIds` (function-only), `isTest`, `isDisabled`: each is writable only by the right
   principal; no self-escalation path.
4. **Scope boundary** — scoped/senior manager writes stay inside the `overseerIds` closure;
   reads are *intentionally* broad (don't tighten reads expecting confidentiality that the
   design doesn't promise, and don't loosen a genuinely restricted field).
5. **Shape & range validation** — `durationMinutes ∈ [0,1440]`, string `start`/`end`,
   validated on create + **on change only**, so partial updates / remediation still pass.
6. **Append-only / immutable** — `decision_log` append-only + `actorId == uid`;
   `integrity_reports` client-immutable; archive/delete transitions can't be forged.
7. **Business-logic & races** — double-credit guard (paused clears `timerStartedAt`),
   per-user session lock, idempotent server closers, 16h / Vilnius-day clamps intact; any
   time/session-math change ships **with a test** (ADR 0013 gate).
8. **File upload (Storage)** — path keyed to `uid`, content-type + size bounded, auth required;
   download URLs not leaked.
9. **Cloud Functions** — callables verify `context.auth` + role; scheduled jobs use the system
   actor; secrets from env (never committed); least privilege; the deployed runtime/region
   matches the repo (verify **live** via the Firebase MCP, not the deploy log).
10. **Secrets & error hygiene** — no real secret in the bundle, logs, or commits; public config
    is fine; raw `err.message` is never shown to a user (mapped to Lithuanian copy).

---

## How this ties into the deploy boundary

A rules/functions change is **not done when the code is written** — it is done when it is
**merged to main, deployed by the founder from an up-to-date main checkout, and re-verified
live** via the Firebase MCP (`firebase_get_security_rules` / `functions_list_functions`).
Never deploy rules/functions from a worktree pre-merge. This checklist is the gate that runs
*before* that human step, so the one irreversible action is taken on a reviewed change.

<!-- DECISION 2026-06-30: Adopted a Firebase-retargeted STRIDE threat model + 10-item
security-test checklist (cherry-picked from the agency-agents security-architect agent, then
rewritten for Firestore-rules-as-security + Cloud Functions). Adopted as a doc folded into the
/security-review lens, NOT as a standing agent persona, per the curated-setup ethos. -->
