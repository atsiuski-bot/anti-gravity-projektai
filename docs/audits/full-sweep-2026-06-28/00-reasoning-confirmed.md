# Reasoning Findings - Confirmed

This is the main-agent reasoning track for the 2026-06-28 audit. It focuses on timer lifecycle, crash safety, app-quality anti-patterns, and security/dependency risks.

## P1 Major

1. **Critical session-end failures are logged but not surfaced to callers.**  
   Location: `src/utils/sessionActions.js:286-394`, callers such as `src/components/BreakTimer.jsx:79-82`, and optimistic reconciliation in `src/context/AuthContext.jsx:221-248`.  
   Impact: if the critical `updateDoc(userRef, updates)` fails, `endSession` catches and logs but resolves. Callers that already set optimistic "ended" state do not enter their catch blocks, so the UI can keep hiding an active server-side session. The optimistic overlay specifically keeps waiting when real Firestore data still has `activeSession`, so this can persist until reload or another corrective action.  
   Recommendation: split critical state mutation from non-critical logging; rethrow after durable logging when the user-doc state update fails.

2. **Starting a secondary session can leave the interrupted task running if pause fails.**  
   Location: `src/utils/sessionActions.js:53-64`, `src/utils/sessionActions.js:178-182`.  
   Impact: task pause failure is converted into a logged resolved promise, while the user document still moves to break/call/quick-work. That can leave the old task document at `timerStatus: "running"` while the user profile says another session is active. Consequence: double counting, stale running rows, wrong time-limit monitoring, and ghost time until a later pause/recovery clamps it.  
   Recommendation: make the interrupted task pause part of the critical transition, or compensate explicitly by reverting the new session state if the pause cannot be persisted.

3. **Starting/resuming a task is fail-open when pausing other tasks fails.**  
   Location: `src/utils/taskActions.js:36-44`, `src/utils/taskActions.js:187-195`, `src/utils/taskActions.js:259-285`.  
   Impact: `pauseOtherTasks` uses `allSettled` and never blocks start/resume. If an old running task fails to pause, the new task still starts, violating the single-active-work invariant.  
   Recommendation: make this an atomic transaction-like state machine, or fail closed and show the worker an actionable retry state.

4. **Timer lifecycle tests do not cover the risky state machines.**  
   Location: current tests cover `timeUtils`, `automationUtils`, `sessionEditActions`, and `taskSearch`, but not `sessionActions`, `taskActions`, `useOrphanedTaskRecovery`, `useOrphanedSessionRecovery`, or timer control double-tap paths.  
   Impact: regressions in the highest-risk workflow can pass all 87 tests.

5. **Root dependency tree has production advisories.**  
   Location: `package-lock.json`, `19-audit-prod-raw.json`.  
   Impact: production-only audit still reports 1 critical and 4 high advisories.

## P2 Minor

1. **Secondary timer controls do not have the same in-flight guard as task controls.**  
   Location: `src/components/QuickWorkTimer.jsx:179-245`, `src/components/CallTimer.jsx:97-174`, `src/components/BreakTimer.jsx:23-82`; compare `src/components/TaskTimerControls.jsx:55-58`.  
   Impact: on slow mobile networks, rapid taps can run overlapping start/end writes for break/call/quick-work even though the task timer path is protected.

2. **`stop-quick-work` event is dispatched but no listener exists.**  
   Location: dispatches in `src/components/TaskTimerControls.jsx:92-94` and `src/components/TaskTimerControls.jsx:158-161`; no matching listener in `src/components/QuickWorkTimer.jsx`.  
   Impact: if stale legacy `quickWorkState.isQuickWorking` is true while `activeSession` does not represent quick work, task start/resume can no-op through an event nobody handles.

3. **Orphan recovery intentionally treats every pre-boot active timer as orphaned.**  
   Location: `src/hooks/useOrphanedTaskRecovery.js:5-47`, `src/hooks/useOrphanedSessionRecovery.js:6-68`.  
   Impact: this protects against multi-hour ghost time, but it also means a legitimate timer that survives a reload/PWA restart is automatically stopped. This trade-off should be explicit in UX and tests.

4. **PWA manifest language/copy drift.**  
   Location: `vite.config.js:18-37`.  
   Impact: installed app metadata can appear in English despite Lithuanian UI requirements.

5. **Side-stripe alert pattern is widespread.**  
   Location examples: `src/components/QuickWorkTimer.jsx:304`, `src/components/CallTimer.jsx:249`, `src/components/BreakTimer.jsx:132`, `src/pages/ManagerView.jsx:130`, `src/components/Reports.jsx:1109`.  
   Impact: violates the loaded `impeccable` absolute ban on decorative `border-left`/`border-right` accents greater than 1px. Use full borders, icon + tint, or canonical alert styling.

6. **Full sweep documentation is stale.**  
   Location: `docs/audits/FULL_SWEEP_PLAN.md`.  
   Impact: future audits can skip tests/functions and misreport Firestore index coverage.

## P3 Polish

1. **Browserslist data is stale.**  
   Location: build output.  
   Impact: stale browser support metadata during build.

2. **Several `transition-all` usages remain.**  
   Location examples: `src/components/QuickWorkTimer.jsx:279`, `src/components/CallTimer.jsx:224`, `src/components/BreakTimer.jsx:107`.  
   Impact: the design system prefers curated GPU-safe transition properties, not `transition-all`.

3. **No live deployed rules diff was performed.**  
   Location: audit limitation.  
   Impact: local rules may be ahead of production.
