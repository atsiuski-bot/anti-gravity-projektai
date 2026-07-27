# WORKZ full sweep — synthesis

**Verdict:** ❌ **AUDIT FAIL — 6 critical findings**  
**Coverage:** deterministic gates, live Firebase parity, candidate-by-candidate JSX accessibility review, and the complete import/export graph are complete.  
**Totals (deduplicated):** 🔴 6 · 🟠 19 · 🟡 25 · ℹ️ 11  
**Audited revision:** `d3879b7f94bd5a17eabde2b2c33ea3ddaebd9b05` on `codex/test`

## Executive conclusion

The application builds, lints, and passes all 860 unique tests. Both live rulesets exactly match the audited local files, all 22 Function names/runtime surfaces match, and 12 declared composite indexes are READY. The dominant risk is not build quality; it is that several trust boundaries remain client-authoritative. A newly authenticated user can establish an admin-trusted profile, a worker can manufacture canonical paid-time rows, owner-writable scope stamps can alter who sees data, and client-controlled attachment URLs can drive Admin-SDK deletion. Separately, the new recovery engine can credit one run above its intended 16-hour ceiling.

The green suite does not contradict these findings: none of R-01–R-14 has an exact exploit-regression oracle (0 fully covered, 9 partial, 5 absent), and the final pass found no automated semantic accessibility gate. Live data also exposes active contract failures: 16 timer-reconciliation permission denials across four accounts and five real missing-index failures. The reconciliation denial is now source-proved: a task-only session query cannot satisfy the private owner/team read rule, so it fails before the task write and leaves partial success. The same migration gap affects deletion cleanup, scoped correction/export, and the worker earnings popup. Local/live rule equality means both the vulnerabilities and these query contracts are active in production.

These are source-proved defects. The critical set was adversarially cross-checked by at least two independent reviewers per finding; most were retained by all three.

## Deterministic gate status

| Gate | Result | Consequence |
|---|---|---|
| Root ESLint | ✅ Pass, zero warnings | Static quality gate is green. |
| Production build / PWA | ✅ Pass | 2,945 modules; largest file 387 KB; PWA manifest/icons/SW present; one ineffective dynamic-import warning. |
| Functions ESLint | ✅ Pass, zero warnings | Server source passes its static gate. |
| Vitest unit suite | ✅ 67 files / 847 tests pass | The 13 conditionally skipped emulator tests run in the separate gate. |
| Firestore emulator suite | ✅ 2 files / 13 tests pass | Combined unique result: 69 files / 860 tests pass. Exact R-01–R-14 exploit coverage is still absent/partial. |
| npm audit | ⚠️ 1 low + 6 moderate root; 8 moderate Functions | No high/critical advisory; Functions Admin SDK chain needs deliberate compatibility work. |
| Composite indexes | 🟠 Incomplete | Local 12 definitions match 12 live READY indexes, but runtime proves a 13th ascending `archived_tasks` index is required. |
| Live rules | ✅ Exact parity | Firestore 776 lines and Storage 39 lines validate and match live content exactly. Critical rule findings are live. |
| Deployed Functions surface | ✅ 22/22 parity | All names are v2 / Node 22 / europe-west1; the API does not expose source bytes. |
| Production signals | 🟠 Active failures | 16 source-explained timer-reconcile denials, 5 missing-index failures, and one unexplained 907-row integrity drop. |

## P0 — critical findings

| ID | Failure mode | System consequence | Effort |
|---|---|---|---|
| R-01 | Self-provisioned admin profile | Full privilege escalation on first profile create | M |
| R-02 | Client URL drives Admin attachment delete | Cross-user irreversible Storage data loss | M |
| R-03 | Recovery clamps two segments separately | One timer run can credit up to 32 h | S |
| R-04 | Unlimited worker-created `work_sessions` | Direct payroll/report/badge fraud | L |
| R-05 | Owner-writable `teamManagerIds` | Oversight evasion and unauthorized disclosure/write scope | M |
| R-06 | Worker-forged approval + reassignment | Manager authority and horizontal task ownership bypass | M |

Full evidence and remedies are in `00-reasoning-confirmed.md`.

## P1 — high / likely findings

| ID | Finding | Effort |
|---|---|---|
| R-07 | Worker can set `isTest` and disappear from reports | S |
| R-08 | Scoped managers can force-end / mutate outside their subtree | M |
| R-09 | Notification recipient/type/provenance/rate controls are insufficient | L |
| R-10 | Broad user-document reads disclose pay rates | L |
| R-11 | At-least-once Functions can double-count achievements / duplicate signup alerts | M |
| R-12 | ADR-0020 multi-document atomic contract is not rule-enforced | L |
| R-13 | Offline command ordering uses wall clock, not monotonic sequence | M |
| R-14 | Canonical session boundaries trust client timestamps | L |
| R-27 | Task-history export executes an N+1 Firestore query pattern | M |
| R-28 | Weekly summary subscribes to the entire work-hours history | M |
| R-35 | Private `work_sessions` read migration breaks reconciliation and task-centric worker/scoped-manager flows | L |
| R-36 | Earnings popup silently prices from zero monthly hours after its denied query | S–M |
| R-37 | Clickable table rows override and invalidate native row semantics | S–M |
| R-38 | Core surfaces systemically violate the binding 44 × 44 px target gate | M |
| T-01 | Core authorization exploits have no exact emulator or Functions regression tests | L |
| T-02 | Functions/Storage runtime paths are outside the quality gate | L |
| T-03 | Timer split-budget/bundle/order/skew edge cases lack exact oracles | M |
| FB-01 | Required ascending scoped `archived_tasks` index is missing | S |
| LIVE-02 | 907 `break_sessions` disappeared in one critical integrity event | S to investigate; remediation depends on intent |

## P2 — bounded risks and maintenance debt

| Area | Findings | Effort |
|---|---|---|
| Timer engine | Timestamp-derived call/quick ledger IDs; unbounded terminal outbox | S–M |
| Storage | Completion photos omitted from cleanup/orphan handling | S–M |
| UI contract | Native select in a modal; label terminology drift; informal “tęsk/Pradėk”; wrong header z-token; two local color literals | S |
| Docs/brand | Five sources say WORKZ publicly instead of Gildija; stale theme comments; stale sweep topology/workflow; ADR-0015 still says unwired Phase 1 | S–M |
| Performance | `ActiveWorkSessions` O(users × tasks); unbounded calendar/work-hours subscriptions; duplicated users listener; ineffective timer dynamic import | S–M |
| PWA reliability | SW update Promise is unhandled and its hourly interval is never cleared | S |
| Accessibility | Active control glyphs fall below 3:1; ARIA tabs/radios omit composite keyboard behavior; lint/tests have no semantic a11y gate | M |
| Render efficiency | `DailyStatistics` rebuilds unread scheduled-task state and rerenders on every task snapshot | S |
| Dead surface | One orphan icon barrel plus a bounded tree-shakeable set of zero-consumer exports | S cleanup |
| Runtime contracts | Additional delete/confirm/complete permission failures and missing-document races need operation-level context | M investigation |
| Dependencies | Root and Functions moderate advisory chains; deliberate SDK/toolchain refresh needed | M–L |

## Recommended repair sequence

1. **Turn each P0 into a failing regression test first.** Use Firestore emulator cases for profile creation, worker ledger creation, scope-stamp mutation, and task approval/reassignment; add a Functions test for foreign attachment paths; add the 15 h + 15 h recovery unit case. Keep both `npm test` and `npm run test:firestore` mandatory.
2. **Close identity and deletion boundaries.** Fix R-01 and R-02 before broader refactoring because they enable total privilege escalation and irreversible cross-user data loss.
3. **Make credited time server-authoritative.** Fix R-04 and R-03, then bind command/run/ledger effects (R-12) and harden timestamp/order semantics (R-13/R-14).
4. **Restore scope and workflow ownership.** Fix R-05/R-06, then extend the same overseer predicate to R-08 and pin `isTest`.
5. **Repair the active runtime contracts.** Centralize role-aware private-session queries; move reconciliation/delete cascade to an idempotent server path; correct the earnings query/error state; add the missing ascending index; reconcile the July 1 bulk deletion with the cleanup/backups audit trail.
6. **Harden outbound and derived effects.** Restrict notification delivery, add event-id idempotency, and close Storage orphan paths.
7. **Finish the lower-risk UI/docs/performance/dependency pass**, then run all deterministic gates again.

Any rules/Functions deployment remains human-only and must happen only after the fixes are reviewed, shipped, merged, and the main checkout is fully updated. This audit did not deploy anything.

## Verification required after fixes

- `npm run lint`
- `npm test`
- `npm run test:firestore`
- `npm run build`
- `npm --prefix functions run lint`
- Root and Functions `npm audit`
- Authenticated Firestore-emulator role matrix for private session queries, reconciliation equality, hard-delete cleanup, and the earnings-tier boundary
- Rendered accessibility checks for table semantics, target sizing, non-text contrast, and tab/radio keyboard behavior
- Live rules/Functions/index verification against `darbo-planavimas` from an explicitly pinned Firebase environment
- Production smoke of worker statistics and timer reconciliation, followed by a clean `error_logs` window
- Targeted mobile visual QA at ~360 px for the affected modal/session surfaces

## Scope and mutation statement

No application source, rules, Functions, commits, branches, production data, or deployments were changed. The sweep added only files under this audit directory; build/emulator commands regenerated ignored local outputs/logs. The Firebase MCP read context was switched to WORKZ / `darbo-planavimas` and verified before live reads.

The resume HEAD matched the original SHA before every resumed analysis block. The final repeat of `git status` was rejected by the desktop usage quota after evidence collection, so the mutation statement is based on the verified resume guard, shared-agent read-only scopes, and constrained audit-only edit history rather than a final shell snapshot.
