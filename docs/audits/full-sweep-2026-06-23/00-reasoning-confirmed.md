# Reasoning track — confirmed findings (triage-sweep)

**Status:** ✅ COMPLETE
**Workflow:** wf_f6c2b005-e9a · 131 agents · 131 
**Counts:** raw 90 → deduped 90 → verified 40 → **confirmed 20** (false positives filtered: 20)
**Reasoning cost (measured):** find 132680 + verify 398256 = **530936 output tokens**

> Severity labels below are triage-sweep's own (high/medium/low). The synthesis (`00-SYNTHESIS.md`) re-maps them onto the sweep's 🔴/🟠/🟡 rubric with judgment — several "high" discipline items are 🟡 pattern-violations in that rubric, while some time/security items are 🟠.

Each finding passed a strict majority of adversarial skeptics (votesReal/votesTotal). The condensed confirming rationale is included.


## timetracking (3)

### 1. archiveOldTasks: UTC date extracted from ISO timestamp compared against Vilnius date string
- **Severity (triage):** 🟠 / high · **Votes:** 3/3
- **Location:** `src/utils/automationUtils.js:153-154`
- **Detail:** Line 153 extracts the calendar date from a stored ISO timestamp with `relevantDate.split('T')[0]`, which yields the UTC date (e.g. '2025-06-22' for '2025-06-22T22:30:00Z'). Line 154 compares this against `cutOffStr` which is a Vilnius local date string produced by `getLithuanianDateString`. In summer (UTC+3) any task confirmed between 21:00 and 00:00 Vilnius time will have a UTC date one day earlier than the corresponding Vilnius date; the UTC date string sorts BEFORE `cutOffStr`, so the task is archived on the WRONG day (one day too early). A task confirmed at 23:00 Vilnius on day D will be archived during the automation run on day D rather than day D+1. The fix is to bucket `relevantDate` through `getLithuanianDateString(new Date(relevantDate))` before the string comparison, identical to what `checkAndPromoteTasks` already does at line 40 for deadlines.
- **Why confirmed:** Confirmed real after reading src/utils/automationUtils.js and src/utils/timeUtils.js.

Line 153 `const dateStr = relevantDate.split('T')[0];` extracts the UTC calendar date from a stored ISO timestamp (confirmedAt/deletedAt/updatedAt are persisted as UTC ISO strings — see line 61 `new Date().toISOString()`). Line 154 then compares this UTC date string against `cutOffStr`, which is built from `getLithuanianDateString(now)` (lines 142-145) — a Vilnius-local date string. Comparing a UTC-derived date against a Vilnius-derived date is the defect.

The divergence is genuine: in summer (UTC+3) an instant like '2025-06-22T22:30:00Z' is 2025-06-23 01:30 in Vilnius, so its true Vilnius work-day is 06-23 but `.split('T')[0]` yields '2025-06-22'. The UTC date sorts BEFORE the Vilnius cutoff, so the task is archived one cycle too early. (The claim's example timestamp is internally consistent and the  […]

### 2. calendarNotifications.js weekId computed in browser-local time, not Europe/Vilnius
- **Severity (triage):** 🟡 / medium · **Votes:** 2/3
- **Location:** `src/utils/calendarNotifications.js:11-12`
- **Detail:** `startOfWeek(now, { weekStartsOn: 1 })` and `format(weekStart, 'yyyy-MM-dd')` come from date-fns and operate entirely in the browser's local timezone, not Europe/Vilnius. When a worker on a non-Vilnius device (e.g. UTC+0 in winter, or a device with an incorrect clock) logs a calendar change on a Sunday evening Vilnius time that is still Sunday UTC, `weekStart` resolves to the correct Monday. But on a UTC+0 browser at e.g. 23:30 Monday Vilnius (22:30 UTC Monday), `startOfWeek` correctly gives Monday. The real risk is the reverse: a UTC-offset browser where the local clock is one day ahead — the weekId written by `logCalendarChange` (worker side, line 12) will disagree with the weekId used to QUERY notifications in `ManagerNotifications.jsx` line 54 (manager side), because both independently call `startOfWeek(new Date(), ...)` and each will resolve to a different YYYY-MM-DD string when the browsers straddle a week boundary in their local clocks. This creates silent notification loss: a calendar change logged at 23:50 Sunday local-time on a UTC+2 browser becomes week W, while a manager viewing on a UTC+0 browser at the same wall-clock moment computes week W-1 and the notification document never appears. The shared weekId should be computed with `getLithuanianDateString` + Monday-of-week arithmetic (as the rest of the codebase does) to guarantee both sides agree.
- **Why confirmed:** Verified in source on BOTH sides. Writer src/utils/calendarNotifications.js:8-12: `now = getLithuanianNow()` which is literally `new Date()` (timeUtils.js:180-182, NO timezone applied), then `weekStart = startOfWeek(now,{weekStartsOn:1})` and `weekId = format(weekStart,'yyyy-MM-dd')` — both date-fns, browser-local time. Reader src/components/ManagerNotifications.jsx:52-58: identical `new Date()` → `startOfWeek` → `format(...,'yyyy-MM-dd')`, used to `query(... where('weekStart','==', weekId))`. The shared cross-device document key `${uid}_${weekId}` is thus derived independently from each device's LOCAL clock, not Europe/Vilnius. Near the Monday week boundary, two devices in different timezones (or a device with a skewed clock) resolve different YYYY-MM-DD strings: a change logged on a UTC+3 worker device just after local Monday midnight is keyed week W, while a UTC+0 manager at the same  […]

### 3. ManagerNotifications.jsx weekId also uses browser-local date-fns, not Europe/Vilnius
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/ManagerNotifications.jsx:52-54`
- **Detail:** Same root cause as the calendarNotifications.js finding: `startOfWeek(new Date(), { weekStartsOn: 1 })` at line 53 and `format(weekStart, 'yyyy-MM-dd')` at line 54 are browser-local. This is the query side of the calendar notification lookup. If the manager's browser local timezone differs from the worker's (or from Europe/Vilnius), their `weekId` string will disagree with the one written by `logCalendarChange`, causing calendar-change notifications to go invisible to managers whose browsers compute a different week boundary date.
- **Why confirmed:** CONFIRMED real. At src/components/ManagerNotifications.jsx:52-54 the manager-side calendar-notification listener builds its query key with `const now = new Date(); const weekStart = startOfWeek(now, { weekStartsOn: 1 }); const weekId = format(weekStart, 'yyyy-MM-dd')` — all browser-local, no Europe/Vilnius normalization. This is the read side of the join: it queries `where('weekStart', '==', weekId)` against the `calendar_notifications` collection.

The write side, src/utils/calendarNotifications.js:11-12 (`logCalendarChange`), computes the matching `weekId` with the SAME browser-local logic. Its `now = getLithuanianNow()` is NOT a timezone conversion — getLithuanianNow() in src/utils/timeUtils.js:180-182 literally `return new Date();` (a no-op wrapper, despite its name and the comment claiming it 'ensures operations can be performed in Lithuanian context'). So both writer and reader der […]

## crashsafety (2)

### 4. startTask and resumeTask throw without calling logError — failures never reach the durable ring buffer
- **Severity (triage):** 🟠 / high · **Votes:** 3/3
- **Location:** `src/utils/taskActions.js:73-76`
- **Detail:** startTask (lines 73-76) and resumeTask (lines 215-218) both catch Firestore errors with only console.error then rethrow. Unlike startSession (which calls logError before rethrowing at line 188-189) and endSession (which calls logError at line 393), these two functions never call logError. The callers (TaskTimerControls.handleStart/handleResume) also only console.error the rethrown error (lines 111, 177). A Firestore permission error or network failure that aborts a task start — leaving timerStatus still 'running' on the old task and the user doc in a stale state — writes nothing to the localStorage ring buffer or the remote error_logs collection, making the failure invisible to remote diagnostics.
- **Why confirmed:** Verified against source at src/utils/taskActions.js. All factual claims hold: startTask (lines 73-76) and resumeTask (lines 215-218) catch Firestore errors with only console.error then `throw err`, never calling logError. By contrast, startSession (src/utils/sessionActions.js) calls logError at line 188 before rethrowing (line 189), and endSession calls logError at line 393 — both with explicit comments (lines 185-189, 391-393) stating the exact rationale the claim invokes: "every caller only console.errors the rethrow, so without this a Firestore/permission/network failure ... would never reach the ring buffer or remote error_logs." The callers in src/components/TaskTimerControls.jsx — handleStart (line 111) and handleResume (line 177) — only console.error the rethrown error, revert optimistic UI, and show a Lithuanian toast; neither calls logError. So a permission/network failure that  […]

### 5. pauseTask catch block does not call logError — ghost-time-causing pause failures are invisible in the durable log
- **Severity (triage):** 🟠 / high · **Votes:** 2/3
- **Location:** `src/utils/taskActions.js:165-170`
- **Detail:** pauseTask's outer catch (line 165-170) only does console.error and rethrows; it never calls logError. This is the function responsible for stopping the ghost-time accumulation: if a pause fails mid-flight (Firestore offline, rules rejection, network error) the task stays timerStatus:'running' with the original timerStartedAt, and subsequent calls will compute the entire gap as elapsed work. Because the failure is not written to the localStorage ring buffer or error_logs, a support investigation has no record of it. The work_session sub-write DOES call logError on failure (line 158), but the critical task-doc update failure does not.
- **Why confirmed:** Verified against src/utils/taskActions.js:165-170 and the call sites. The outer catch in pauseTask does only `console.error("Error pausing task:", err)` + `throw err` (finally just clears pauseInFlight) — it never calls logError. The asymmetry the claim names is real and confirmed: the non-critical work_sessions sub-write has its own `.catch(logErr => logError(logErr, {source:'writeFail:pauseTask.workSession'}))` at line 158, but the critical task-doc updateDoc (lines 120-126, which sets timerStatus:'paused' and clears timerStartedAt — the write that actually stops ghost-time accrual) has no logError on failure. So whether a pause failure lands in the durable sinks (errorLog.js localStorage ring buffer + Firestore error_logs) depends entirely on the caller. Tracing callers: useOrphanedTaskRecovery.js:44 DOES route the rethrown error to logError(source:'orphanRecovery:pauseTask'). But the […]

## security (3)

### 6. Worker can self-forge a confirmed/approved task on CREATE by calling the Firestore API directly
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `firestore.rules:200-204`
- **Detail:** The `changesApprovalFields()` guard that prevents workers from flipping `status` to `'confirmed'`/`'approved'`, `isApproved`, `confirmedBy`, or `approvedBy` is applied only on UPDATE (line 208-214). The CREATE rule has no equivalent check. The rule comment at lines 129-133 acknowledges this intentionally to allow call/quick-work auto-logging. However, the consequence is that any active worker can bypass the entire approval workflow by sending a raw `addDoc` to the `tasks` collection with `{ status: 'confirmed', isApproved: true, confirmedBy: '<uid>', assignedUserId: '<own uid>' }`. The client (`TaskModal.jsx` lines 571-592, `taskCompletionActions.js` lines 29-57) correctly gates the `'confirmed'` status behind a client-side `isManagerRole()` check, but Firestore rules never enforce this on CREATE. The firestore.rules comment explicitly calls out that create is intentionally not guarded, accepting the risk; this finding surfaces it as an unmitigated path for any active worker.
- **Why confirmed:** VERIFIED REAL (integrity/correctness gap, medium is defensible). The mechanism is exactly as claimed. firestore.rules:200-204 (CREATE on /tasks) guards only assignee-ownership/team-scope; it never calls changesApprovalFields(). The UPDATE rule (208-214) DOES enforce `!changesApprovalFields()` on the owner branch (line 213), so the asymmetry is real: a worker can do via a raw addDoc what they're blocked from doing via updateDoc. A direct-API call with {assignedUserId:<own uid>, status:'confirmed', isApproved:true, confirmedBy:<own uid>, approvedBy:<own uid>} is accepted by the rules — the assignedUserId==auth.uid branch (line 201) passes and nothing checks the approval fields on create. The client (TaskModal.jsx ~579-587 sets workers to status:'unapproved' and fires a manager approval notification; taskCompletionActions.js:47 gates 'confirmed' behind isManagerRole) enforces the workflow o […]

### 7. work_hours UPDATE does not pin the userId field — owner can re-assign a record to another user
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `firestore.rules:270`
- **Detail:** `allow update, delete: if isUserActive() && (ownsUserId() || isManagerOrAdmin())` — `ownsUserId()` checks that `resource.data.userId == request.auth.uid` (the EXISTING stored value), but the rule does not assert `request.resource.data.userId == resource.data.userId`. A worker who owns a `work_hours` document can therefore submit an update that changes the `userId` field to a different user's uid, effectively re-stamping the record as belonging to a colleague. After the write the record is no longer owned by the original worker, so subsequent `ownsUserId()` checks will pass for the victim's uid instead. This allows a worker to either orphan their own records (so they are no longer deleteable by themselves) or pollute a colleague's planner data without manager privilege. The same gap exists for `work_sessions` and `break_sessions` updates.
- **Why confirmed:** CONFIRMED REAL via source at firestore.rules:270 (and :238-242 work_sessions, :251-255 break_sessions). The UPDATE rules gate on `ownsUserId() || isManagerOrAdmin()` (or scoped-overseer variant). `ownsUserId()` (lines 117-119) = `resource.data.userId == request.auth.uid` — it checks the EXISTING stored value. None of the three UPDATE rules assert `request.resource.data.userId == resource.data.userId`, so the incoming write may carry a different userId. Firestore evaluates the rule once against the pre-update doc, so an owning worker passes `ownsUserId()` and can re-stamp `userId` to a colleague's uid in the same write. The claim's mechanism is accurate for all three collections.

This is exploitable, not a Chesterton's-fence design choice. The in-file comment (lines 105-115) and the project memory state the explicit invariant: WRITE is owner-scoped precisely to stop tampering — "a worker […]

### 8. request_notifications CREATE has no rate-limit enforcement and any active user can ring any manager's device
- **Severity (triage):** 🟡 / low · **Votes:** 3/3
- **Location:** `firestore.rules:363-374`
- **Detail:** The create rule requires a non-empty `recipientId`, provenance stamping, and an unread flag, but places no constraint on the `recipientId` value itself — any active user can target any other user as recipient, including managers they have no relationship with. Each successful write triggers a Cloud Function that delivers an OS push notification to the recipient's registered devices. Firestore security rules cannot enforce rate limits, and there is no server-side throttle (the `notify.js` comment at line 12 explicitly acknowledges this). A disgruntled worker can spam any manager's phone with arbitrary notifications (within whatever FCM/Cloud Function quota applies). The `commentText` is capped at 2000 chars (line 371) so the lockscreen payload itself is bounded, but the frequency is not.
- **Why confirmed:** VERIFIED REAL against source. firestore.rules:363-371 (create) constrains only: active caller, non-empty string recipientId, provenance (caller's uid must equal createdBy OR userId), isRead==false, and commentText<=2000 chars. Crucially it places NO constraint binding recipientId to any relationship with the caller — any active user can set recipientId to any uid, including managers they have no relationship with. The provenance check only blocks forging the SENDER identity (you must stamp your own uid), not restricting the TARGET. Delivery chain confirmed: every create fires notifyOnRequestNotification (functions/index.js:159) -> sendToUser (line 77) -> sendEachForMulticast (line 88), pushing an OS notification to the recipient's FCM tokens; sendToUser has NO throttle (only gates: recipient-disabled-notifications, has-tokens). Firestore rules genuinely cannot count over time and there i […]

## session-color (2)

### 9. Rule B drift — QuickWorkTimer desktop button uses hardcoded `text-red-900` instead of session token
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/QuickWorkTimer.jsx:323`
- **Detail:** The desktop (non-compact) active state of the QuickWorkTimer button applies `text-red-900` directly: `bg-session-quickWork-surface border-red-200 text-red-900 ring-1 ring-red-200`. The text color should be `text-session-quickWork-accent` (resolves to #B91C1C from SESSION_COLORS), which is the single source of truth for all quickWork foreground color (DESIGN_SYSTEM §4-B). `text-red-900` is a hardcoded Tailwind value (#7F1D1D) that does not match the SESSION_COLORS accent token and would not update if the token is revised. The `border-red-200` and `ring-red-200` on the same line are also outside the token map.
- **Why confirmed:** VERIFIED REAL (core claim). src/components/QuickWorkTimer.jsx:323 reads exactly `'bg-session-quickWork-surface border-red-200 text-red-900 ring-1 ring-red-200'`. The `text-red-900` (Tailwind #7F1D1D) is a hardcoded foreground that bypasses the quickWork accent token `text-session-quickWork-accent` (= #B91C1C from SESSION_COLORS / tailwind.config.js session.quickWork.accent). This is a genuine §4-B "one source of truth" drift: DESIGN_SYSTEM.md §4-B and src/utils/sessionColors.js both mandate that accent/text color derive from the SESSION_COLORS map. Tellingly, the SAME button sources every other accent element from the token — line 329 (icon), 338 ("Vyksta..." label), and 343 (timer) all use `text-session-quickWork-accent` — so line 323 alone uses a different, darker, off-token red for the button's default text color. Chesterton's-fence check found no justification: no explanatory comment […]

### 10. Rule B drift — BreakTimer desktop button uses hardcoded amber values instead of session tokens
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/BreakTimer.jsx:157`
- **Detail:** The desktop (non-compact) active state of the BreakTimer button is styled with `bg-session-break-surface text-amber-800 hover:bg-amber-100 border border-amber-200`. The text, hover, and border values are raw Tailwind amber constants rather than session tokens. According to DESIGN_SYSTEM §4-B all presentation must come from the SESSION_COLORS map. The correct equivalents are: `text-session-break-accent` (accent, #B45309), `hover:bg-session-break-shell` or `hover:bg-session-break-surface` (hover tint), and `border-session-break-shell` or the session surface token for the border. If the break token palette is updated, this button will not follow.
- **Why confirmed:** VERIFIED REAL. src/components/BreakTimer.jsx:157 — the active (non-compact) break-button state is styled `'bg-session-break-surface text-amber-800 hover:bg-amber-100 border border-amber-200'`. Three of four color classes (text-amber-800, hover:bg-amber-100, border-amber-200) are raw Tailwind amber constants; only the base bg is token-sourced. This bypasses the SESSION_COLORS map (src/utils/sessionColors.js) that is meant to be the single source of truth for session presentation, violating DESIGN_SYSTEM principle 4 ("Tokens, not magic numbers ... a raw hex/arbitrary value in a component is a bug") and §4 Rule B ("One source of truth ... must never drift"). The consequence stated is accurate: tailwind.config.js defines break tokens only as shell=#FEF3C7, surface=#FFFBEB, accent=#B45309, so if the palette is re-tinted these raw amber literals will not follow.\n\nChesterton's-fence check pas […]

## discipline (9)

### 11. Bespoke modal shells instead of canonical Modal in TaskDetailsModals.jsx
- **Severity (triage):** 🟠 / high · **Votes:** 2/3
- **Location:** `src/components/TaskDetailsModals.jsx:20-31, 469-478, 579-586`
- **Detail:** Three hand-rolled modal scaffolds (DetailsModal, the image-viewer overlay, DeleteConfirmationModal) each implement their own `fixed inset-0 z-modal/z-top … bg-feedback-scrim` scrim. None import or route through the canonical Modal (src/components/ui/Modal.jsx). DeleteConfirmationModal is also a bespoke confirm-destructive dialog that should be ConfirmDialog. The file has no import of Modal or ConfirmDialog whatsoever.
- **Why confirmed:** Factually the claim checks out — at src/components/TaskDetailsModals.jsx the DetailsModal shell (L20-31), the image-viewer overlay (L469-478), and DeleteConfirmationModal (L578-586) each hand-roll a `fixed inset-0 ... bg-feedback-scrim`/`bg-black/95` scrim, and the file imports neither Modal (src/components/ui/Modal.jsx) nor ConfirmDialog (src/components/ui/ConfirmDialog.jsx). But under the CORRECTNESS lens this is not a real defect, for two reasons. (1) It is not a correctness bug — every shell renders and behaves correctly: all use the shared useModalA11y hook (focus-trap, Escape, focus restore), portal where needed, use token scrim/z classes, and carry proper role/aria-modal/aria-labelledby. This is a design-system *discipline* smell (the prompt itself tags it [discipline/high]), not broken behavior. (2) Chesterton's fence is explicitly documented and already adjudicated against this  […]

### 12. TaskModal rolls its own fixed-inset-0 outer shell instead of using Modal
- **Severity (triage):** 🟠 / high · **Votes:** 3/3
- **Location:** `src/components/TaskModal.jsx:695`
- **Detail:** The entire TaskModal component is a hand-rolled `fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim` shell. Despite importing ConfirmDialog for its internal confirm dialogs, the top-level modal frame does not use the canonical Modal component, violating DESIGN_SYSTEM §8 which mandates routing all overlays through Modal.
- **Why confirmed:** VERIFIED REAL. Read src/components/TaskModal.jsx:695 directly: it returns createPortal(<div className="fixed inset-0 z-modal flex items-center justify-center bg-feedback-scrim p-4">...) — a hand-rolled scrim shell, the exact thing the canonical Modal exists to provide. The import block (lines 1-25) imports Button, IconButton, Select, ConfirmDialog, TaskStatusPill, DeletedBadge and useModalA11y but NOT the canonical Modal (src/components/ui/Modal.jsx), confirming the claim that it imports ConfirmDialog yet bypasses Modal for the top-level frame.

DESIGN_SYSTEM §8 is explicit and binding (lines 216-217): "This is the single rule for all pop-ups; route new overlays through Modal rather than hand-rolling a fixed inset-0 scrim." Modal.jsx's portal (lines 59-68) produces precisely the fixed inset-0 ... bg-feedback-scrim shell TaskModal duplicates.

Chesterton's-fence check fails to find a fenc […]

### 13. WorkPlanner has three bespoke modal scaffolds and two raw <select> controls
- **Severity (triage):** 🟠 / high · **Votes:** 3/3
- **Location:** `src/components/WorkPlanner.jsx:875, 941, 1022, 1088, 1123`
- **Detail:** Three hand-rolled `fixed inset-0` modal dialogs (Edit Event modal at line 941, Approval Feedback modal at 1088, Reason modal at 1123) bypass the canonical Modal. Additionally, two raw native `<select>` elements exist at lines 875 and 1022 for 'Nebuvimo tipas', violating DESIGN_SYSTEM §8 which bans native `<select>` and mandates the canonical Select component.
- **Why confirmed:** Verified against real source at C:\Users\karol\Desktop\WORKZ\.claude\worktrees\stoic-proskuriakova-aad0bf\src\components\WorkPlanner.jsx. All five sites confirmed exactly as claimed.

THREE bespoke modal scaffolds, each a hand-rolled `fixed inset-0 ... bg-feedback-scrim backdrop-blur-sm` scrim with manual role="dialog"/aria-modal/ref-based focus trap, bypassing the canonical Modal:
- L941 Edit Event modal ("Redaguoti laiką" / "Pridėti darbo laiką")
- L1088 Approval Feedback modal (showApprovalFeedback)
- L1123 Reason modal (showReasonModal)
The canonical component exists at src/components/ui/Modal.jsx but is NOT imported here (imports L15-20 bring in DeleteConfirmationModal, Button, IconButton, InfoPopover, Select, DatePicker — no Modal). DESIGN_SYSTEM §8 (L207-217) explicitly says "route new overlays through Modal rather than hand-rolling a `fixed inset-0` scrim" and "Replaces ~10 hand- […]

### 14. ActiveSessionReadout duplicates session palette in a local READOUT map instead of reading SESSION_COLORS
- **Severity (triage):** 🟠 / high · **Votes:** 3/3
- **Location:** `src/components/ActiveSessionReadout.jsx:11-30`
- **Detail:** The component defines its own local `READOUT` object with hardcoded session token class strings for quickWork/call/break, duplicating exactly what SESSION_COLORS provides. It does not import SESSION_COLORS at all. DESIGN_SYSTEM §4-B states 'the shell background, the timer pill, and the running task card all read the same SESSION_COLORS token map — they must never drift.'
- **Why confirmed:** VERIFIED REAL. Read src/components/ActiveSessionReadout.jsx:11-30 and src/utils/sessionColors.js directly. The component defines a local `READOUT` map for quickWork/call/break that hardcodes (a) labels ('Greitas darbas','Skambutis','Pertrauka'), (b) icons (Zap/Phone/Coffee), and (c) color token classes inside `tone` (bg-session-<type>-surface, text-session-<type>-accent, plus border-session-<type>-accent). It never imports SESSION_COLORS. SESSION_COLORS in src/utils/sessionColors.js already provides exactly these per type: `label`, `Icon`, `surface`, `accent`. So label/icon/surface/accent are pure duplication of the single-source-of-truth map. DESIGN_SYSTEM.md §4-B (lines 91-93) is binding: "The shell background, the timer pill, and the running task card all read the same SESSION_COLORS token map. They must never drift." This readout IS the timer pill, so this is the precise failure §4-B […]

### 15. Session-state ring/border colors hardcoded as raw Tailwind in timer dock controls
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/CallTimer.jsx:229`
- **Detail:** `ring-blue-100` is a raw Tailwind color class used for the call-active ring on the compact timer button. Similarly QuickWorkTimer.jsx line 284 uses `ring-red-200 shadow-red-500/20` and line 323 uses `border-red-200`, and BreakTimer.jsx line 112 uses `ring-amber-100` and line 157 uses `text-amber-800 hover:bg-amber-100 border-amber-200`. These bypass the SESSION_COLORS map and will drift when session tokens change.
- **Why confirmed:** Verified against source. Every cited line is accurate: CallTimer.jsx:229 uses `ring-blue-100` on the active-call accent button; QuickWorkTimer.jsx:284 uses `ring-red-200 shadow-red-500/20` and :323 uses `border-red-200 ring-red-200`; BreakTimer.jsx:112 uses `ring-amber-100` and :157 uses `text-amber-800 hover:bg-amber-100 border-amber-200`. These appear ONLY on the active-session branch of each timer (isCalling/isQuickWorking/isTakingBreak), so they are session-state presentation — exactly what src/utils/sessionColors.js (SESSION_COLORS) is meant to be the single source of truth for (per its own header and DESIGN_SYSTEM §4-B). They bypass that map: they are raw Tailwind palette steps (blue-100/red-200/amber-100) hand-tuned to harmonize with the session hues, while the shell/surface/accent on the SAME elements come from tokens (bg-session-call-accent, bg-session-quickWork-shell, bg-sessio […]

### 16. QuickWorkTimer and QuickWorkDescribePrompt use raw border-red-200 instead of session token
- **Severity (triage):** 🟡 / medium · **Votes:** 2/3
- **Location:** `src/components/QuickWorkTimer.jsx:49, 284, 323`
- **Detail:** The time-display card at line 49 uses `border border-red-200` alongside `bg-session-quickWork-surface`, mixing a raw color with a token. Line 284 active-ring uses `ring-red-200 shadow-red-500/20`. Line 323 expanded-view uses `border-red-200`. QuickWorkDescribePrompt.jsx line 40 has the same `border border-red-200` issue. These should read from SESSION_COLORS.quickWork.
- **Why confirmed:** Confirmed by reading the real source. QuickWorkTimer.jsx mixes raw Tailwind-palette reds with session tokens at all three cited lines: L49 `bg-session-quickWork-surface ... border border-red-200`; L284 active button `bg-session-quickWork-shell ... ring-2 ring-red-200 shadow-lg shadow-red-500/20`; L323 desktop active `bg-session-quickWork-surface border-red-200 text-red-900 ring-1 ring-red-200`. QuickWorkDescribePrompt.jsx L40 repeats `bg-session-quickWork-surface ... border border-red-200`. These are session-state decorations painted with off-token reds while everything adjacent is tokenized — the tell-tale of an oversight, not a deliberate exception. It violates the spirit of DESIGN_SYSTEM §4-B ("one source of truth" for session presentation) and §48-49 (tokens, not ad-hoc colors). Severity is real but lower than "medium": these reds are theme-INVARIANT literal hex by design (same as th […]

### 17. Reports.jsx uses bare inline loading strings instead of canonical Loading component
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/Reports.jsx:1333, 1521`
- **Detail:** Two loading states render `<div className="...">Kraunami duomenys...</div>` inline. The file does not import the canonical Loading component (src/components/ui/Loading.jsx). DESIGN_SYSTEM §8 mandates 'one consistent treatment … no more bare "Kraunami duomenys..." strings duplicated per screen'.
- **Why confirmed:** Verified real. Reports.jsx:1333 and 1521 both render bare inline `<div className="bg-surface-card p-8 rounded-card shadow-sm text-center text-ink-muted">Kraunami duomenys...</div>` loading states, and the import block (lines 1-26) does NOT import the canonical Loading component (no Spinner/SkeletonRows/Loading import). The DESIGN_SYSTEM mandate is real and sits in §8 ("Components (the canonical set)", line 185): the Loading subsection (lines 259-263) states verbatim "Loading: one consistent treatment... No more bare 'Kraunami duomenys...' strings duplicated per screen." Chesterton's-fence check finds no intentional exception: the canonical component (src/components/ui/Loading.jsx) exists, its docstring explicitly calls out this exact anti-pattern, and the pattern is ALREADY adopted everywhere else — MonthlyHours.jsx (line 104 even uses `<Spinner label="Kraunami duomenys…" />`), Dashboard […]

### 18. ManagerNotifications task_reverted card uses raw amber colors instead of feedback-warning tokens
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/ManagerNotifications.jsx:623-626`
- **Detail:** The `task_reverted` notification card uses `border-amber-200 bg-amber-50` (container) and `text-amber-600 text-amber-900` (icon and text). The design token system exposes `feedback-warning-soft`, `feedback-warning-border`, and `feedback-warning-text` tokens exactly for this pattern. Raw amber Tailwind classes should be replaced with these tokens.
- **Why confirmed:** CONFIRMED REAL. At src/components/ManagerNotifications.jsx:623-626 the `task_reverted` card uses raw Tailwind palette classes: container `border border-amber-200 bg-amber-50` (623), icon `text-amber-600` (625), text wrapper `text-amber-900` (626). The semantic token layer for exactly this pattern exists and is fully wired: src/index.css defines `--fb-warning-soft` (amber-50), `--fb-warning-border` (amber-200), `--fb-warning-text` (amber-700, AA-validated on soft), and tailwind.config.js exposes them as `feedback-warning-soft / -border / -text`. The claim is accurate.

Not a Chesterton's-fence design choice: this is the ONLY raw-amber usage in the file. Its sibling warning cards in the same component already use the tokens — the `new_comment` card (line ~657/810: `bg-feedback-warning-soft border border-feedback-warning-border` + `text-feedback-warning-text`) and `time_change_request` card […]

### 19. CombinedHoursSummary uses raw bg-blue-300 for a progress bar
- **Severity (triage):** 🟡 / low · **Votes:** 3/3
- **Location:** `src/components/CombinedHoursSummary.jsx:269`
- **Detail:** The 'Planuota' (planned hours) progress bar fill uses `bg-blue-300`, a raw Tailwind color with no backing token. This is unrelated to any session state (it is a per-user hours chart), so it should use a neutral or brand token (e.g. `bg-brand/40` or a dedicated chart token) rather than a hardcoded palette value.
- **Why confirmed:** Verified by reading src/components/CombinedHoursSummary.jsx:269 directly: the "Planuota" (planned hours) progress-bar fill uses className "...bg-blue-300...", a raw Tailwind palette color with no backing token. This violates DESIGN_SYSTEM.md (lines 48-49): "Tokens, not magic numbers ... A raw hex or an arbitrary text-[9px] in a component is a bug." Chesterton's-fence check confirms it is NOT a deliberate choice: the sibling "Dirbta" bars in the same component were intentionally tokenized with explanatory comments (bg-feedback-success for work, bg-session-break-accent for breaks), and the user color dot is sourced from data, so the planned bar's raw bg-blue-300 is an inconsistency/oversight, not an intended exception. There is no dedicated chart token, but feedback.info/brand (indigo) tokens cover the informational-progress semantic, so a token-based replacement exists. A second raw color […]

## ux-a11y (1)

### 20. Reports tab bar missing aria-current and role='tablist'
- **Severity (triage):** 🟡 / medium · **Votes:** 3/3
- **Location:** `src/components/Reports.jsx:1068-1092`
- **Detail:** The three-button tab strip (Darbo ataskaita / Patvirtinimas / Kalendoriaus pakeitimų istorija) renders plain <button> elements inside a <div>. There is no role='tablist' on the container, no role='tab' on each button, and no aria-current or aria-selected on the active tab. Screen readers cannot identify this as a tab widget and cannot communicate which tab is selected. The active state is communicated only by color (brand border-bottom), violating §7 'color is never the sole signal'.
- **Why confirmed:** Confirmed by reading src/components/Reports.jsx:1068-1092. The tab strip is a plain <div className="flex border-b border-line overflow-x-auto"> containing three bare <button>s. The container has no role="tablist", the buttons have no role="tab", and the active tab carries no aria-current/aria-selected. Active state is signaled purely via className color/border (border-brand text-brand vs border-transparent text-ink-muted) — color is the sole programmatically/visually-distinct signal of selection, which violates DESIGN_SYSTEM §7 "Color is never the sole signal" (line 174) and the WCAG 2.1 AA gate. This is NOT a Chesterton's fence: the rest of the app consistently exposes the active-state semantic — AppHeader.jsx:52, SideRail.jsx:78, and BottomNavigation.jsx (lines 93/119/174) all set aria-current={active ? 'page' : undefined}, and UserProfileModal.jsx:93-115 implements a full role="tablis […]

---

## Rejected as false positives (20 — filtered by verify, NOT in synthesis)

These were surfaced by finders but failed the skeptic majority. Listed so the synthesis can note what the verify stage caught:


**discipline (1 rejected):**
- ~~TaskTimeLimitPopup and TaskTimeWarningPopup use raw <button> with raw red/amber colors instead of Button variant='danger'~~ (1/3) — `src/components/TaskTimeLimitPopup.jsx`

**timetracking (3 rejected):**
- ~~calculateCurrentTotalMinutes: timeAdjustments summed on top of manualMinutes that may already embed them~~ (0/3) — `src/utils/timeUtils.js`
- ~~Reports.jsx spanDays uses UTC midnight parse for YYYY-MM-DD strings; DST boundary can produce 0-day span~~ (0/3) — `src/components/Reports.jsx`
- ~~endSession does not reset restoredSession.startTime when pausedSession itself has a pausedSession (nested interruption)~~ (0/3) — `src/utils/sessionActions.js`

**crashsafety (4 rejected):**
- ~~Single-level pausedSession is silently overwritten on a second interruption — the outer session's state is lost~~ (0/3) — `src/utils/sessionActions.js`
- ~~useOrphanedSessionRecovery runs only once (handledRef never resets) — a user who logs out and back in skips recovery~~ (0/3) — `src/hooks/useOrphanedSessionRecovery.js`
- ~~handleStopCall fast-path (sub-minute call) calls endSession without error handling — failure leaves session orphaned with no user feedback~~ (0/3) — `src/components/CallTimer.jsx`
- ~~endSession swallows its own outer catch and does not rethrow — callers cannot distinguish a failed session-end from a successful one~~ (1/3) — `src/utils/sessionActions.js`

**session-color (1 rejected):**
- ~~Rule C — full-saturation red reused for task time-limit alarm (not quickWork)~~ (0/3) — `src/components/TaskTimeLimitPopup.jsx`

**security (2 rejected):**
- ~~Firebase API key hardcoded in source and committed since initial commit~~ (0/3) — `src/firebase.js`
- ~~error_logs CREATE allowed for any authenticated user, not just active users~~ (0/3) — `firestore.rules`

**firebase-coupling (9 rejected):**
- ~~Orphan rule: shift_logs — locked but never accessed~~ (0/3) — `firestore.rules`
- ~~Orphan rule: daily_stats — locked but never accessed~~ (1/3) — `firestore.rules`
- ~~Missing composite index: request_notifications — recipientId + isRead~~ (0/3) — `src/context/NotificationsContext.jsx`
- ~~Missing composite index: calendar_requests — managerId + status~~ (0/3) — `src/context/NotificationsContext.jsx`
- ~~Missing composite index: calendar_requests — userId + status (in) + userDismissed~~ (0/3) — `src/components/CalendarRequestStatusBanner.jsx`
- ~~Missing composite index: calendar_requests — createdAt range + orderBy~~ (0/3) — `src/components/Reports.jsx`
- ~~Missing composite index: tasks — assignedUserId + timerStatus~~ (0/3) — `src/utils/taskActions.js`
- ~~Missing composite index: work_sessions — userId + taskTitle~~ (0/3) — `src/utils/sessionActions.js`
- ~~Missing composite index: archived_tasks — assignedUserId + archivedAt with orderBy~~ (0/3) — `src/components/TaskHistory.jsx`
