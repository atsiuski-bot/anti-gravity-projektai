# Phase 06 — Firebase rules (deterministic diff)

**Status:** ⚠️ PARTIAL (live-rules diff unverifiable — see below)
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 3

## Method

Read `firestore.rules` (16 collection match blocks) and `storage.rules` (1 path) and
checked the deterministic facts only — rule presence, obvious `if true`, recursive `=**`
wildcards, and the `firestore.indexes.json` presence — per §6.4. Privilege-escalation and
coupling *reasoning* is delegated to the `security` and `firebase-coupling` reasoning
dimensions, not decided here. Attempted a live-rules diff via the Firebase MCP.

**Live-diff outcome — UNVERIFIABLE from this session.** The Firebase MCP is bound to a
different project: `firebase_get_environment` reports the active project as **`g-o-g-f1e67`**
(the GODSGLOOM app, project dir `APP-GODSGLOOM\GODSGLOOM APP - dabartinis`), with no alias for
WORKZ's Firestore project **`darbo-planavimas`**. Reading that instance's rules would return
GODSGLOOM's rules, not WORKZ's, so the diff was deliberately **not** performed rather than
fabricate a comparison against the wrong project.

## Findings

### 🟡 Risk
- `DEPLOY_FIRESTORE_RULES.md:8-18` vs `firestore.rules:43` — **the deploy doc describes a
  `users` read rule that is not in the current file** (doc drift with a security smell).
  The doc's "What I Fixed" claims line 42 was changed to
  `allow read: if isAuthenticated() && request.auth.uid == userId;` (own-document-only), but
  the live `firestore.rules:43` is still `allow read: if isAuthenticated();` — any
  authenticated user can read **every** user document — WHY: the rule was evidently reverted
  (the current comment says broad read is "needed for viewing coworker info, calendars") but
  the deploy doc was never updated, so it now misrepresents the real rule and would mislead
  anyone using it as the source of truth for what is deployed — FIX: reconcile the two —
  either re-narrow the rule and keep the doc, or update `DEPLOY_FIRESTORE_RULES.md` to
  reflect that broad coworker read is the intentional, current design. (The *security
  judgement* on whether broad `users` read is acceptable is handed to the `security`
  dimension; this finding is the literal doc↔code mismatch, which is deterministic.)

### ℹ️ Info
- `(repo)` — **No `firestore.indexes.json` exists** (confirmed — not in the tree, though
  `firebase.json` references only `rules`). Every compound Firestore query in the client is
  therefore a runtime `FAILED_PRECONDITION` risk with no committed index to back it. The
  `firebase-coupling` reasoning dimension enumerates the specific queries with file:line —
  recorded here only as the deterministic fact that the index file is absent.
- `(firestore.rules)` — **No `if true` and no recursive `=**` wildcard** anywhere in the
  rules (clean on the two crudest escalation patterns). Structural facts for the reasoning
  track: 13 of 16 collections use `allow read, write: if isUserActive()` with **no
  per-document ownership scope** (any active worker can read/write any document in
  `tasks`, `work_sessions`, `break_sessions`, `work_hours`, `daily_stats`, `shift_logs`,
  `archived_tasks`, `deleted_tasks`, `calendar_notifications`, `calendar_requests`,
  `request_notifications`, `task_templates`); `users` read is gated on `isAuthenticated()`
  (not `isUserActive()`), so even a disabled user can read all user records; `error_logs` is
  correctly create-only/manager-read/immutable; `user_settings` is owner-scoped. These are
  facts handed to the `security` + `firebase-coupling` dimensions for the escalation verdict.
- `(storage.rules)` — **Single owner-scoped path** `attachments/{userId}/{fileName}`:
  read/write require `request.auth.uid == userId`, write enforces a 100 MB size cap. The
  legacy flat `attachments/<file>` path matches no rule by design (documented — viewable
  only via already-stored tokenized URLs). No over-broad path found. **Deploy state of both
  rule files vs the live `darbo-planavimas` project is unverifiable here** (MCP bound to the
  wrong project; `DEPLOY_FIRESTORE_RULES.md` already warns a manual deploy may be pending) —
  confirm in the Firebase Console for `darbo-planavimas` that the live rules match the repo.
