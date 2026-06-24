# Fixes applied — 2026-06-24 (post-sweep remediation)

After the read-only sweep, every finding was **independently re-verified** against current
source (adversarial, refute-by-default — workflow `wf_f3e34101-910`, 17 verifiers, 16 real /
1 refuted / 0 errored), then the confirmed ones were fixed **one by one**. The re-verify
materially *corrected* several findings (real contrast cause, exact failing lines).

**Gate after all fixes:** lint ✅ (0 warnings) · build ✅ · vitest ✅ 428/428 · `firestore.rules`
validates ✅ (Firebase MCP). Client-only except L2 (see below).

| # | Finding | Verdict | Action | File |
|---|---|---|---|---|
| **C1** | endLegacySession swallows critical failure | real/high | `logError(err,{source:'endLegacySession',userId,type})` in catch (matches sibling endSession) | `sessionActions.js` |
| **C2** | manager orphan-recovery missing | real/high | mounted `useOrphanedTaskRecovery(ownTasks)` + `useOrphanedSessionRecovery(currentUser)` in ManagerView (ownTasks = manager's own, not team) | `ManagerView.jsx` |
| **M1** | Reports date filter local-midnight vs UTC | real/med | Vilnius-anchored half-open `[start, end)` via `vilniusWallClockToISO`+`addDaysToDateString`; `> end`→`>= end` | `Reports.jsx` |
| **M2** | grouped-view key raw UTC date | real/low | `split('T')[0]` → `getLithuanianDateString(dateStr)` | `Reports.jsx` |
| **M3** | updateUserWorkStatus failure unlogged | real/med | added `logError(err,{source:'taskActions.updateUserWorkStatus',userId})` (kept non-fatal) | `taskActions.js` |
| **M4** | doResume race-guard fails OPEN | real/low | fail **closed**: set `userStartedAnotherTask=true` + `logError` on guard-fetch throw | `sessionActions.js` |
| **M5** | bespoke `<button>`s in popup | real/med | both → canonical `<Button variant="secondary"/"danger">` | `TaskTimeLimitPopup.jsx` |
| **M6** | bespoke session-toggle buttons (3 timers) | real/low | **DEFERRED — see below** | BreakTimer/CallTimer/QuickWorkTimer |
| **M7** | raw red-600 vs feedback-danger | real/low | button + header gradient → `feedback-danger`/`-hover` tokens (visual no-op) | `TaskTimeLimitPopup.jsx` |
| **L1** | raw border-red-200 | real/low | → `border-session-quickWork-soft` (same value, token-sourced) | `QuickWorkDescribePrompt.jsx` |
| **L2** | error_logs create unbounded | real/low | added size-clamp shape guards (above client clamps) + self/null userId pin | `firestore.rules` ⚠️ **needs human deploy** |
| **U1** | sub-labels opacity-70 < AA | real/med | removed `opacity-70` ×2 (accent-on-surface already ≥4.5:1) | `ActiveWorkSessions.jsx` |
| **U2** | notif copy opacity-80 < AA | real/med | removed `opacity-80` on the **2** genuinely-failing warning lines (996,1157); the other 4 cited lines PASS, left as-is | `ManagerNotifications.jsx` |
| **U3** | timeline table text-xs | **REFUTED** | no change (12px caption is allowed; no AA fail) | — |
| **U4** | confirmed label green-600 on sunken | real/med | `text-feedback-success` → `text-feedback-success-text` (green-700, 4.56:1) ×2 | `DailyStatistics.jsx` |
| **U5** | comment timestamp ink-muted on sunken = 4.39:1 | real/low | `text-xs text-ink-muted` → `text-caption text-ink` (~9:1) | `TaskDetailsModals.jsx` |
| **U6** | drill-down 42px tap target | real/low | `before:-inset-y-[9px]` → `[10px]` = exactly 44px | `AllUsersCalendar.jsx` |

## ⚠️ L2 — human-only deploy step

`firestore.rules` now has the `error_logs` create shape guard, but the **repo is ahead of
the live ruleset** until deployed. Deploy is human-only, **post-merge from an up-to-date main
checkout**, then re-verify the live rules via the Firebase MCP (not the deploy log):

```
firebase deploy --only firestore:rules --project darbo-planavimas --account audrius@medievalclub.org
```

The guard bounds sit **above** the client clamps (`errorLog.js`: message≤2000, stack/
componentStack≤8000; url/userAgent were unbounded), so every legitimate append still passes;
the `userId == null || == auth.uid` branch is kept so the earliest pre-auth crash reports
(which write `userId:null`) are never dropped. Validated OK via `firebase_validate_security_rules`.

## M6 — deferred (recommend a dedicated `SessionToggleButton`)

M6 is **confirmed real but is a design-system refactor, not a bug** (pure styling duplication;
no functional/contrast/a11y defect — severity LOW). The three timer toggles each carry 3 states
(disabled/active/resting) × 2 shapes (compact icon-only = *accent-fill + shell-ring*; labeled =
*surface-bg + accent-text + soft-border*) × per-session color (break/call/quickWork), and the
desktop variants don't fit the canonical `Button`'s icon+children shape. Extending `Button` to
absorb all of this would bloat its API for a narrow case; a *partial* migration (compact only)
would leave the desktop pair diverged — **more** inconsistency, not less.

**Recommendation:** introduce a dedicated `SessionToggleButton` component encapsulating the
session-toggle affordance, then migrate all six call sites, with 360 px visual QA across each
session × shape × state. This is the signature whole-screen-session-color UI (DESIGN_SYSTEM §4),
so it warrants its own focused change rather than being bundled with 15 unrelated fixes. Not
started — left as the single open item.
