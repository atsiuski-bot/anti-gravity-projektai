# 01 — Remediation of the 2026-09-05 sweep

Worked on 2026-09-06 from the same worktree (`claude/detailed-function-debugging-48954d`).
Every finding below was fixed, verified, or explicitly closed with a reason. Nothing was left
"reported but untouched".

**Gate after the work:** `npm run lint` clean (root + functions) · `npm run build` exit 0 ·
`npm run test:all` exit 0 — **1489 unit + 4 functions suites + 127 emulator tests, 0 failures**
(1433/118 before, so **+56 unit tests and +9 rules tests** were added by this work).
**Live UI check:** signed in as admin through the dev-login panel at `localhost:5183`, exercised
user management, reports, team tasks, task history and the task modal, desktop and 375 px.
**Zero console errors** on a clean tab.

---

## 🔴 R-10 — pay rate was readable by every colleague · FIXED (needs a rules deploy)

**What was wrong.** `users/{uid}` is deliberately readable by every active user — it is the roster
the whole app renders, and `UsersContext` subscribes to the entire collection app-wide. Firestore
cannot project fields out of an allowed document read, so `payRate` (the NET salary tier table,
ADR 0012) sitting on that document was readable by any signed-in worker.

**What changed.** Salary moved to its own document, `users/{uid}/private/payRate`:

| Piece | Change |
|---|---|
| `firestore.rules` | New `match /users/{userId}/private/{docId}`: READ = owner **or** whole-team manager/admin **or** the scoped/senior manager in whose closure the user sits; WRITE = admin only. Branch order is deliberate — self costs no read, `canSeeWholeTeam()` reads only the caller's (cached) doc, `overseesUser()` reads the target's doc last. |
| `src/utils/payRateStore.js` (new) | The storage boundary: `payRateDocRef`, `fetchPayRate`, `fetchPayRates` (best-effort batch), `subscribePayRate`, `savePayRate`, and `effectivePayRate(privateDoc, legacyUser)` — the private document wins, the inline field is the pre-migration fallback. `payRate.js` stays pure maths with no Firebase import. |
| `AuthContext` | Subscribes to the signed-in user's own rate and re-attaches it as `userData.payRate`, so every existing consumer (earnings breakdown, `showEarnings`) is unchanged. Memoised so it returns the projected object **unchanged** when there is nothing to attach — `applyPendingSessionProjection` preserves identity, and a fresh object every render would re-fire every effect keyed on `userData`. |
| `UserManagement` | Fetches the roster's rates separately (admin only — the only role that renders the control), passes the resolved rate into `PayRateButton` and `PayRateModal`, and saves through `savePayRate`, which also clears the legacy inline field so each edit self-migrates one user. |
| `TaskModal` | Fetches the assignee's rate on demand for the multi-tariff picker (one point read per assignee change, manager only). |
| `reportData` | Fetches rates per selected worker, mirroring the existing best-effort recognition fetch. |
| `scripts/migrate-payrate-to-private.cjs` (new) | Bulk backfill: copy → then delete the inline field, per user, dry-run by default, project-guarded, idempotent, and it **skips** a user whose private copy already differs (an admin re-saved it; the newer value wins). |

**Verified.** 9 new emulator cases against the real ruleset (`securityRules.integration.test.js`):
a colleague and an out-of-scope scoped manager are **denied**; the owner, an in-scope scoped
manager, an unscoped manager and an admin are **allowed**; a worker cannot mint themselves a
raise; even an overseeing manager cannot write a rate; an admin can. Plus 19 unit cases on
`payRateStore`. In the live app the editor still opens with each worker's existing tiers through
the legacy fallback (14 of 18 users show a rate set).

**A bug this introduced, caught by running it.** Before the rules are deployed, the own-rate
listener gets `permission-denied` and was writing a durable crash record on every login for every
user. `subscribePayRate` now swallows exactly that code — the same treatment the agent
kill-switch listener already gives its own pre-rollout denial — and logs every other failure.
Confirmed: zero console errors after the fix.

> ### ⚠ HUMAN-ONLY, AND ORDER MATTERS
> 1. `/ship` → merge to `main` → **deploy the rules from an up-to-date `main` checkout**.
>    Until they are live, an admin **saving** a pay rate fails (reading still works via the
>    fallback), so keep this window short.
> 2. Then run the migration dry-run, read it, then `--apply`.
> 3. Re-verify the live ruleset (the CLI path in `06-firebase.md` works while the MCP is down).

---

## 🟠 Fixed

| # | Finding | Fix |
|---|---|---|
| 2 | Period summary and AI report under-counted hours vs the CSV and DailyStatistics | `computeWorkerStats` now adds a finished plain task's own `manualMinutes`, with guards mirroring `aggregateDaily` exactly (quick-work/system/`timeChanged` excluded; `deletedAt` accepted — the hours were still worked). Counted as task time in the where-did-the-time-go split so it describes the same total. The fixture that **locked the omission in** (asserting 14 h while holding 190 unbooked minutes) was corrected, and 7 discriminating cases added — including a manual-only day, which used to vanish from `activeDays` entirely. A new cross-aggregation test in `reportAggregate.test.js` pins the daily log, the CSV `Viso` row and the headline total to each other. |
| 5, 6 | `browserslist` (HIGH ×2) and `fast-uri` (HIGH ×4) | Lockfile-only `npm audit fix`. Root advisories **9 → 5**, and **both HIGHs are gone**. `package.json` untouched. |
| 7 | `useRevisionedTaskRecovery` unguarded | The two gates extracted as pure exported predicates — `taskRunAwaitingRecovery` (pre-boot) and `canRecoverConfirmedRun` (server confirmation) — and pinned by 15 cases, including the two production incidents: crediting a stretch the server already closed, and stopping a timer running on the worker's other device. |
| 8, 9 | `useRevisionedSecondaryRecovery` / elapsed hooks | **Closed on inspection, not by writing tests.** Their substantive logic is already covered elsewhere: the secondary hook's credit-instant policy is `resolvePreBootBeat`, tested in `useOrphanedSessionRecovery.test.js`; the plan builders are covered by `timerTransitionPlan.test.js` and the emulator engine suite. What remained untested was effect wiring, which cannot be reached without a rendering harness this repo deliberately does not have. |
| 10 | `CLAUDE.md` advertised a `/deploy-netlify` that deploys **GODSGLOOM** | Replaced with the real command list plus an explicit warning that WORKZ has no deploy command. |
| 11 | The sweep tool could not launch its own workflow, and mislabelled unverified findings | `.gitattributes` pins `.claude/workflows/*.js` and `.claude/commands/*.md` to `eol=lf` (the CRLF checkout is what the Workflow runner refused). `triage-sweep.js` now returns an **`unverified`** bucket for findings no skeptic decided, instead of filing them as false positives — the defect that mislabelled 16 findings, four of them real. |

## 🟡 Fixed

- **Design system.** Two bespoke icon buttons in `TaskModal` now use `IconButton`; `IconButton`
  itself switched from `clsx` to `cn` (tailwind-merge), like every other canonical component, so a
  caller's `rounded-full` genuinely overrides `rounded-control` — verified live: `border-radius:
  9999px`, 44×44 px, canonical focus ring. Eleven break figures in `DailyStatistics` moved from
  `feedback.warning` to `session.break.accent`; the one genuine anomaly warning was left alone.
  `TaskHistory`'s date-range trigger and both sort buttons now meet the 44 px floor — measured live
  at exactly 44 px (they were ~32 px).
- **Dead code removed:** `parseTimeToHours`, `isTaskTimerAnomalous` + its constants, `archiveTask`
  (archiving moved server-side in `59a18c6`), and the whole `taskCompletionActions` module with its
  test — its only caller, the task checkbox, was deleted in `8bcf78b`. Git history was checked for
  each before removal.
- **PII in the console:** a new `devLog` helper (a dead branch in production) replaces 12 shipped
  `console.log` calls, two of which printed the signed-in user's e-mail on every login. The
  `migrateDB` traces stay — that tool is already DEV-gated and its output is its interface.
- **`AuditDashboard`** now leads with Lithuanian copy and renders the scan's own message only as an
  explicitly-labelled technical detail.
- **`qs`** (the one advisory that actually runs in production, under Express in
  `firebase-functions`) fixed in the functions lockfile: **8 → 7**.
- **Docs:** `DEPLOY_FIRESTORE_RULES.md`'s security-model section rewritten to describe the ruleset
  that actually exists (hierarchy, time integrity, server-owned data, and the new private
  subcollection); `DESIGN_SYSTEM.md`'s "~150 sub-12px uses" corrected to **zero, migration
  complete**, and its "call state is blue in some places" note updated to record that drift as fixed
  while naming the break-token drift it did not catch; `tokens.md`'s config sample relabelled as a
  light-theme value table (the real config is CSS-variable-backed, which is what makes dark mode
  possible); the July R-04 roadmap carries a superseded banner, since the timer engine it calls
  dormant has been on for everyone since 2026-07-29.

## Closed with a reason, not changed

- **`sessionAdmin` dynamic-import warning.** The comment at `taskActions.js:863` already documents
  why it is dynamic: `sessionAdmin` statically imports `taskActions`, so making it static creates a
  real cycle. Leaving the Vite warning is the correct trade; the intent is documented where a
  future reader will look.
- **`useUndescribedQuickWork`'s second listener.** The Firestore SDK shares one listen target
  between identical queries, so this costs no extra reads. Collapsing it would mean hoisting the
  worker's task subscription into the app shell — a restructure of the timer hot path for no saving.
  Documented in the hook.
- **`uuid` / `@google-cloud/storage` moderates (both trees).** `npm audit`'s only "fix" is
  `firebase-admin@10.3.0`, a four-major **downgrade**. Already an accepted register entry.
- **ESLint 8 end-of-life.** A flat-config migration is its own change, not a line in a remediation.
