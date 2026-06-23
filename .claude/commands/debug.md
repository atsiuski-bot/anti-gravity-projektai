---
description: Diff-scoped change-impact diagnostics for WORKZ — blast-radius full-sweep across all coupled layers. Run AT ANY TIME during development (NOT a replacement for /ship or /full-debug-sweep).
allowed-tools: Bash(git status*), Bash(git diff*), Bash(git branch*), Bash(git rev-parse*), Bash(git log*), Bash(git fetch*), Bash(npm run lint*), Bash(npm test*), Bash(npm run build*), Bash(npm --prefix functions run lint*), Grep, Read, Glob, mcp__firebase__firebase_get_security_rules, mcp__firebase__firestore_list_indexes, mcp__firebase__functions_list_functions, mcp__Claude_Preview__preview_start, mcp__Claude_Preview__preview_list, mcp__Claude_Preview__preview_console_logs, mcp__Claude_Preview__preview_network, mcp__Claude_Preview__preview_snapshot
---

Diff-scoped change-impact diagnostics. Takes the **code written in this worktree**
(diff against `main` + staged + working tree) and across **8 levels** checks not only the
code itself, but all the coupled layers that could **break as a result of those changes**
(coupling / blast radius).

**Authoritative target — the worktree's live working tree is the newest version of the
code.** Everything written during this session (committed on the `claude/*` branch, staged,
AND unsaved working-tree edits — taken together) is THE code under diagnosis. Always read and
diagnose this live state — never an older committed snapshot, never `origin`. If a file was
touched this session, its current on-disk content in this worktree wins over anything git
history or a remote says about it. Concretely: when a level reads a file, it reads the
working-tree copy; when it diffs, it unions `main..HEAD` + `--cached` + unstaged so nothing
written this session is missed.

**Full-sweep — never stops at the first error.** It goes through ALL applicable levels,
collects ALL problems, and produces a single ranked blast-radius report (L7). The goal is to
see the whole picture at once, not a fix→rerun cycle.

**This is NOT `/ship` and NOT `/full-debug-sweep`.** `/debug` changes nothing — it only reads
and diagnoses (no `Edit`/`Write`/commit/push/deploy). Differences:

| | `/debug` | `/ship` | `/full-debug-sweep` |
|---|---|---|---|
| Goal | diagnosis (what might break from *this* diff) | go/no-go gate → push to prod | whole-project audit |
| Scope | diff against `main` (+ staged + working tree) | the commit being shipped | the entire repo, diff-agnostic |
| Behavior | full-sweep, aggregates everything | fail-fast, STOPS at the 1st gate failure | parallel finders + adversarial verify |
| When | any time during development | right before deploy | every 2–4 weeks |

Triggers (run even if the user did not type `/debug` directly): the user says "debug",
"what might break", "check the impact of changes", "blast radius", "what is coupled to this
change", "will this break something", "ką sulaužys šitas pakeitimas".

---

## Findings model

Each level: if the diff **does not touch** that layer → **SKIP with a reason** (logged into
the L7 INFO section, not silently skipped). If it touches it → run ALL of that level's checks,
accumulate findings, **never stop**.

Finding format: `file:line · what might break · WHY: coupling reason · FIX: remediation`

Severity scale:
- 🔴 **Critical** — breaks prod / crosses the human-only boundary / DANGER zone (CLAUDE.md)
- 🟠 **Likely** — contract drift / missing index / missing test update / needs a deploy
- 🟡 **Risk** — pattern / design-system violation / listener-leak edge case
- ℹ️ **Info** — touched-file map, skipped levels + reason

---

## L0 — Diff baseline / change surface map (always)

One Bash batch in parallel:
- `git rev-parse --show-toplevel` + `git branch --show-current` — confirm we are in a
  `claude/*` worktree. If `main` → **STOP** "not a worktree — nothing to diagnose" (the only
  place where the chain breaks; the project ships from worktrees, never edits `main`).
- `git diff --name-only main..HEAD && git diff --name-only --cached && git diff --name-only`
  — merge into a **touched files list** (dedupe). This union — committed-this-session +
  staged + unsaved — IS "everything written in this session"; it is the input for all later
  levels. Do NOT narrow it to only committed or only the last edit.
- `git diff --stat main..HEAD` — overall scope (info).

For every file on the touched list, the version that matters is its **current working-tree
content in this worktree** (the newest version). When a later level Reads a touched file,
read it from disk here — not from `git show main:<file>`, not from `origin`.

If the touched list is empty → **STOP** "no changes to diagnose".

Categorize each file into a zone (used for L1–L6 gating):
`UI (*.jsx/css)` · `context (src/context/*)` · `hooks` · `utils (src/utils/*)` ·
`pages` · `firebase client (src/firebase.js, src/config/*)` · `functions (functions/**)` ·
`firestore.rules` · `storage.rules` · `firestore.indexes.json` · `PWA (vite.config / manifest / sw)` ·
`docs`.

This is the foundation — there is no PASS/FAIL. Present a short touched map in text before
moving on.

---

## L1 — Static / pattern layer (if touched includes `src/**`)

Parallel Greps in one message. Diagnostic findings (not gates — they do not stop). Each hit →
a finding with file:line:

1. **Raw `err.message` rendered to the user** — pattern `err\.message|error\.message|e\.message`
   glob `src/**/*.jsx`. If the value flows into a toast / `setError` / modal body / visible
   JSX text → 🔴 "CLAUDE.md bans raw `err.message` in UI — map to friendly Lithuanian copy".
   Logged-only (console / errorLog) → ignore.
2. **Banned `window.confirm` / `window.alert`** — pattern `window\.(confirm|alert)|(?<!\.)\b(confirm|alert)\(`
   glob `src/**/*.jsx` → 🔴 "banned in UI flows — use `ConfirmDialog` / `Modal` (DESIGN_SYSTEM)".
3. **Retired brand** — pattern `Viduramžiai|Viduramzi|viduramziai` glob `src/**/*.{js,jsx}`
   (also check `index.html`, `public/manifest*`). Any hit in a user-facing string or asset →
   🟠 "WORKZ is the only name — the old brand is retired everywhere (CLAUDE.md)".
4. **Hardcoded session color** — pattern `bg-(red|blue|amber|green|orange)-[0-9]` or raw hex
   for the whole-screen session background, glob `src/**/*.jsx`, **exclude** `src/utils/sessionColors.js`.
   The signature whole-screen session color MUST come from the single `SESSION_COLORS` map and
   be paired with a text label + icon → 🔴 "color is sourced from one map + label + icon
   (CLAUDE.md / DESIGN_SYSTEM §Calm canvas, loud state); a stray inline color breaks the
   invariant and the a11y 'color-never-the-sole-signal' rule".
5. **Magic numbers / raw hex in components** — pattern `text-\[[0-9]|#[0-9a-fA-F]{3,6}`
   glob `src/components/**,src/pages/**` → 🟡 "tokens, not magic numbers — use the token
   scale (DESIGN_SYSTEM / tokens.md); raw `text-[9px]` also risks the ≥12 px / ≥44 px AA floor".
6. **English user-facing copy** — scan touched `src/**/*.jsx` for newly-added button labels /
   toasts / placeholders / aria-labels / modal titles / empty states written in **English**.
   WORKZ user-facing copy is Lithuanian, formal "Jūs" → 🟠 "user-facing strings are Lithuanian
   (CLAUDE.md language policy); English belongs only in code/comments/commits". (This is the
   inverse of a TypeScript-repo check — here Lithuanian UI is correct and English UI is the bug.)
7. **Stray `console.*` in shipped code** — pattern `console\.(log|warn|error|info|debug)`
   glob `src/**/*.{js,jsx}` → 🟡 "left-in console noise; persistent errors belong in
   `src/utils/errorLog.js`, not the browser console". (Minor — App-level `console.error` in a
   genuine catch is acceptable.)

If >20 hits in one pattern — group the findings by file.

---

## L2 — Contract / rules-field parity layer

WORKZ has no TypeScript / Zod schema; the contract that drifts is **client write shape ↔
`firestore.rules` validation**. Applies if touched: any `src/**` path that writes a
rules-validated collection (`work_hours`, `work_sessions`, `break_sessions`, `users` —
`payRate`/`role`/`overseerIds`), or `firestore.rules` itself. Otherwise → SKIP "no
rules-validated write touched".

- For each added/changed field written to one of those collections, Read `firestore.rules`
  and confirm the field passes the relevant validator/allowlist:
  - `work_hours` / `*_sessions` carry **duration + shape** validation (`durationOkForUpdate`)
    and a **`userId` UPDATE pin** — a write whose new field/shape the rule does not permit is
    silently **rejected at runtime** → 🔴 stating WHICH guard lags.
  - `users.payRate` and the hierarchy fields (`overseerIds`) have their own update rules — a
    client write outside the allowlist → 🔴 "write rejected; the field never persists".
- Drift the other way (rule references a field the client stopped writing) → 🟠 "the guard
  now over-constrains; legacy or future writes may fail".
- If only `firestore.rules` is touched (not the client) → defer the full analysis to L4
  (it owns the DANGER-zone rules check) and note it here as a pointer.

---

## L3 — Logic / unit-test layer (targeted)

WORKZ runs **vitest** (`npm test` → `vitest run`). Map each touched logic module to its
co-located `*.test.js` suite and run **only those** (fast). If no tested module is touched →
SKIP "logic layer not touched" (the full suite still runs in L6).

Known suites (run the matching one when its module — or a module it exercises — is touched):

| touched module | suite |
|---|---|
| `src/utils/timeUtils.js` | `timeUtils.test.js` |
| `src/utils/sessionActions.js` | `sessionActions.test.js` |
| `src/utils/sessionEditActions.js` | `sessionEditActions.test.js` |
| `src/utils/taskActions.js` | `taskActions.test.js` |
| `src/utils/taskSearch.js` | `taskSearch.test.js` |
| `src/utils/recurrence.js` / `recurringActions.js` | `recurrence.test.js` |
| `src/utils/reportAggregate.js` / `reportData.js` | `reportAggregate.test.js` |
| `src/utils/workerStats.js` | `workerStats.test.js` |
| `src/utils/templateCategories.js` | `templateCategories.test.js` |
| `src/utils/titleSimilarity.js` | `titleSimilarity.test.js` |
| `src/utils/automationUtils.js` | `automationUtils.test.js` |
| `src/utils/errorLog.js` | `errorLog.test.js` |

Run targeted, e.g. `npm test -- src/utils/timeUtils.test.js`.
- A failing targeted suite → finding: test name + suspected source change + 🔴.
- **Time / session / duration math touched but its suite is NOT in the touched list** → 🟠
  "time-credit logic changed without a test update — this is the crash-safety-critical path
  the test gate (ADR 0013) guards; add/extend coverage before `/ship`".
- A logic module touched that has **no** suite at all → 🟡 "unguarded logic change — no
  regression net".

---

## L4 — Firebase coupling layer (the core)

**Where most of "what breaks from a change" lives.** Applies if touched matches any Firebase
trigger: a Firestore field/collection/query, Storage path, a Cloud Function, an
`httpsCallable`, `firestore.rules`, `storage.rules`, `firestore.indexes.json`, or an
`onSnapshot` listener. Otherwise → SKIP "Firebase layer not touched".

1. **New `httpsCallable('X')`** in `src/` → Grep `functions/index.js` (and any
   `functions/**`) for the matching `exports.X` / `onCall` definition. Missing → 🔴 "prod
   returns `not-found`/`internal`". If present but `functions/**` was changed this session →
   🟠 "Cloud Functions deploy is **human-only** (`firebase deploy --only functions
   --account audrius@medievalclub.org`); an undeployed change runs stale code in prod — verify
   the live runtime via the Firebase MCP, not the deploy log". (Known callables today:
   `parseTaskDraft`, `runRecurringTasksNow`.)
2. **Firestore query** with `where`+`orderBy`, two `where` clauses, or a `collectionGroup` →
   Read `firestore.indexes.json` for a matching composite index. Missing → 🔴 "runtime
   `FAILED_PRECONDITION` until the index is built; index deploy is human-initiated". Optionally
   cross-check the **live** index set via `firestore_list_indexes` (MCP) — a local-only index
   not yet deployed is the same outage.
3. **Field added to a rules-validated collection** (`work_hours`, `*_sessions`, `users`) →
   re-state the L2 finding here in blast-radius terms: rule rejects the write / the field
   silently never persists → 🔴.
4. **`firestore.rules` or `storage.rules` touched** → 🔴 DANGER "rules are the security
   boundary — one wrong line = a data leak or a blocked feature. Deploy is **human-only** and
   reads the **CWD's** rules file; after deploy, re-verify the *live* ruleset
   (`firebase_get_security_rules` MCP), don't trust 'Deploy complete'. Keep READ broad / scope
   only WRITE — owner-scoped reads break team-wide Reports & calendar."
5. **`functions/**` touched** → run `npm --prefix functions run lint`; lint fail → 🟠. Always
   add 🟠 "needs a human `firebase deploy --only functions`; verify the deployed runtime via
   `functions_list_functions` (MCP), not the deploy log — a stale deploy silently keeps old code".
6. **New `onSnapshot` listener** in a component/hook → confirm it returns its `unsubscribe`
   from the `useEffect` cleanup. Missing cleanup → 🟠 "listener leak — duplicate reads and, if
   it writes, duplicate writes on every re-mount". (Carry the detail to L5.)
7. **Storage path / attachment-upload change** (`src/utils/attachmentUpload.js`,
   `imageUtils.js`) → confirm `storage.rules` still permits the new path/shape → 🔴 if not.

---

## L5 — PWA / realtime-listener layer

Applies if touched: any component/hook using `onSnapshot`, `src/utils/migrateDB.js`,
`src/utils/messaging.js`/`localNotify.js` (FCM/SW), `vite.config.js` (vite-plugin-pwa),
the web manifest, or a service-worker file. Otherwise → SKIP "PWA/listener layer not touched".

- **`onSnapshot` lifecycle** — every listener mounted in a `useEffect` MUST be torn down in
  the cleanup return. A listener left subscribed after unmount → 🟠 "memory + read-quota leak,
  stale-closure writes". (The known onSnapshot surfaces: ActiveWorkSessions, AllUsersCalendar,
  CalendarRequestStatusBanner, Combined/Daily/Monthly hours, DailyStatistics, DailyWorkProgress,
  ManagerNotifications, TaskHistory.)
- **vite-plugin-pwa / manifest touched** → 🟠 "precache + the update-prompt flow are coupled;
  a manifest `id`/`scope`/`start_url` change can orphan installed PWAs. Verify `dist/` still
  emits the service worker + manifest after `npm run build` (L6)."
- **`migrateDB.js` / IndexedDB touched** → check that any store/version change keeps a
  create-if-missing fallback so a fresh install does not throw on first read → 🔴 if absent.
- **FCM / `messaging.js` touched** → 🟠 "push depends on the VAPID key set in the host
  (Cloudflare/Netlify) env + the SW registration; a client-only change can't be verified
  without the deployed token — note it as a deploy-coupled check, not a local pass".

---

## L6 — Runtime / integration layer (full gates as findings, NOT stop)

Run **all three** in sequence even if `lint` fails (full-sweep — you want the whole picture,
not fail-fast). WORKZ is JS — there is **no `tsc` typecheck step**; the build + lint + vitest
are the runtime gates.

- `npm run lint` → non-zero exit = finding 🟠 (eslint runs `--max-warnings 0`, so any warning
  is a CI failure — quote file:line).
- `npm test` (**FULL** vitest suite) → capture ALL failing tests, each → a finding with the
  test name 🔴.
- `npm run build` → fail = finding 🔴 (vite build; also confirms the PWA precache emits).
- `src/App.jsx` **provider order** touched → 🔴 DANGER "the provider hierarchy
  (Theme → Auth → Users → Toast → Notifications → Navigation) is load-bearing — `ThemeProvider`
  must wrap `AuthProvider` (theme live pre-login), and downstream providers depend on `Auth`/
  `Users`. Reordering without a stated reason breaks context resolution."

If the touched list includes at least one `*.{jsx,css}`, `index.html`, `vite.config.*`,
`tailwind.config.*`, `public/**` → browser layer (use the dev-only test login for an
authed view if needed — see `docs/runbooks/visual-qa-test-account.md`):
1. `preview_list` → if none running for this worktree → `preview_start`.
2. `preview_console_logs` — an error-level line → 🔴 with a log excerpt + suspect file.
3. `preview_network` — 4xx/5xx (except a known pre-login 401) → 🟠 with URL + status.
4. `preview_snapshot` — does the changed route render (not a white screen / error boundary)?
   White/error → 🔴.

If no UI file → SKIP the browser sub-step "no UI surface touched".

---

## L7 — Synthesis / blast-radius report (always)

Aggregate EVERYTHING from L0–L6 into a single block, ranked by severity:

```
═══ DEBUG — CHANGE-IMPACT REPORT ═══

Touched: <N> files (UI <n> · utils <n> · context <n> · functions <n> · rules <n> · docs <n>)

🔴 CRITICAL — breaks prod / human-only boundary / DANGER zone (<count>)
  • <file:line> — <what breaks> — WHY: <coupling reason> — FIX: <remediation>
  ...
🟠 LIKELY — contract drift / missing index / missing test / needs deploy (<count>)
  • ...
🟡 RISK — pattern / design-system / listener edge (<count>)
  • ...
ℹ️  INFO — skipped levels + reason · touched map
  • L5 skipped: PWA/listener layer not touched
  ...

VERDICT (diagnosis, NOT a gate): <X> critical · <Y> likely · <Z> risk
→ Fix 🔴 before `/ship`. `/debug` changed nothing.
```

If nothing is found across all levels → VERDICT: `0 critical · 0 likely · 0 risk —
change-impact clean. You can proceed to `/ship``.

---

## Notes

- **Do not confuse with `/ship` or `/full-debug-sweep`**: `/ship` = a fail-fast go/no-go gate
  that pushes to prod; `/full-debug-sweep` = an infrequent whole-project audit; `/debug` =
  diff-scoped full-sweep diagnostics at any time. `/debug` does not replace either — after
  `/debug` fixes you still run the `/ship` gate before deploying.
- **Changes nothing**: no `Edit`/`Write`/commit/push/`gh`/deploy. If it finds a 🔴 — ask the
  user whether they want you to fix it (in a separate turn), but `/debug` itself only diagnoses.
- **Respect the human-only boundary**: `/debug` never deploys rules/functions, never writes to
  Firestore, never promotes hosting. It can READ live Firebase state via the read-only MCP
  tools to verify coupling (rules, indexes, function runtimes), but the deploy itself stays a
  founder action.
- **Diff-scoped**: always from `git diff main..HEAD` (+ staged + working tree). A level whose
  layer the diff does not touch is SKIPPED with a reason — but the applicable levels run
  EVERYTHING (full-sweep).
- If the changes touch only `docs/`, `*.md`, plan files → L1–L6 are mostly SKIPPED, but L0 +
  L7 are still produced (touched map + "no code-impact" verdict).
</content>
</invoke>
