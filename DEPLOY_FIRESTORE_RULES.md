# Deploy Firestore Security Rules — Manual Steps

> **The repo `firestore.rules` may be ahead of what is live.** Firestore rules are NOT
> deployed by the Netlify build (Netlify ships the static app only). After any change to
> `firestore.rules` or `storage.rules`, someone must deploy them manually to the
> **`darbo-planavimas`** Firebase project. Until then the live rules and the repo can drift.

## Current security model (last reviewed 2026-09-06)

`firestore.rules` enforces **per-document ownership** with a scoped manager/admin escape, not
just "any active user". The shape, newest constraints last:

- **Identity:** `isUserActive()` = authenticated + the user doc exists + `isDisabled != true`.
  Every operand is read with `.get(field, default)`, never bare dot access — a missing field
  raises an evaluation error that DENIES the write.
- **Four-level hierarchy (ADR 0007):** admin > seniorManager > manager > worker. An admin
  writes the membership edges; a Cloud Function folds them into each user's `overseerIds`
  closure and denormalises it onto every private row as `teamManagerIds`. Clients — admins
  included — may never hand-edit either, or the confidentiality boundary silently desyncs.
  A *scoped* manager and any *senior* manager see only their subtree; an unscoped manager and
  an admin keep whole-company reach (`canSeeWholeTeam`).
- **Per-user collections** (`tasks`, `work_sessions`, `break_sessions`, `work_hours`,
  `archived_tasks`, `calendar_requests`, `calendar_notifications`, `active_sessions`): read
  stays broad within scope, WRITE is pinned to the owner plus their overseers. Read is
  deliberately not a row filter — a rule cannot filter a list query, it can only allow or deny
  it wholesale, so scoping happens in the query and the write rule.
- **Named task overseer:** a manager named on a task (`managerId` / `taskAuditor`) may act on
  it even from outside their team closure — otherwise the designated approver could see a task
  and have every write denied.
- **Time integrity:** `durationMinutes` is shape- and range-validated; a session's `endTime` is
  compared against `request.time` with an asymmetric ±2 min tolerance (the client is
  server-anchored via `serverClock.js`); a worker may SHORTEN their own logged time but never
  lengthen it (the rule keys on the `selfAdjusted` marker, not the role, because the live timer
  legitimately grows durations); trusted backdating (`canBackdateTime`) is add-only, ≤ 7 days.
- **Pay rate is NOT company-readable (audit R-10, 2026-09-06).** `users/{uid}` is readable by
  every active user — it is the roster the app renders — and Firestore cannot project fields out
  of an allowed read. Salary therefore lives in `users/{uid}/private/payRate`, whose READ is the
  owner, their overseer, or an admin, and whose WRITE is admin-only (ADR 0012). Any confidential
  per-user field added in future belongs in that same subcollection, never on the user document.
- **`users`:** you can always read your **own** document (login bootstrap). Reading **others**
  requires `isUserActive()`. Self-provisioning at first login is pinned to a safe DISABLED
  WORKER shape (no self-minted admin); role, team/senior membership, scope, `payRate`,
  `canBackdateTime`, `canEditOwnStartTime` and `isTest` are admin-only; a non-admin manager may
  toggle `isDisabled` only on a NON-admin target (no governance lockout).
- **No-self-approval:** a worker may edit their own task but cannot flip the manager-only
  approval/confirmation fields; only managers/admins can.
- **Server-owned data:** earned badges (`users/{uid}/achievements`) and the overseer closure are
  written only by the Admin SDK; every client write is denied.
- **`request_notifications`:** owner is the `recipientId`; any active user may create one, only
  the recipient reads/updates it. **`task_templates`:** shared read; the creator (or a manager)
  edits. **`error_logs`:** any authenticated user appends a crash report, managers/admins read,
  entries immutable, admins clear. **Unused collections** (`shift_logs`, `daily_stats`) stay
  fully locked (`read, write: if false`) on purpose — they are defensive placeholders, not
  leftovers. **`deleted_tasks`** is team-scoped READ with WRITE `if false`.

`storage.rules` scopes `attachments/{userId}/…` to the owner with a 100 MB write cap.

> Keeping this section honest is part of a rules change: it is the only description a human reads
> before running an irreversible deploy. The authoritative source is always `firestore.rules`
> itself, and `/firebase-status` diffs it against what is actually live.

## How to deploy (choose one)

### Method 1 — Firebase CLI (recommended)

1. Open a terminal in the project directory, logged into the account that owns
   **`darbo-planavimas`**.
2. Re-authenticate if needed:
   ```bash
   firebase login --reauth
   ```
3. Deploy only the rules:
   ```bash
   firebase deploy --only firestore:rules,storage:rules
   ```

### Method 2 — Firebase Console

1. Go to the [Firebase Console](https://console.firebase.google.com/) → project
   **`darbo-planavimas`**.
2. **Firestore Database → Rules**, paste the full contents of local `firestore.rules`,
   **Publish**. Repeat for **Storage → Rules** with `storage.rules`.

## After deployment

- Validate the live rules behave as above (a worker cannot read another worker's tasks; a
  manager still sees the team dashboards; first login still works).
- Note: the rules add per-evaluation `get()`/`exists()` lookups of the caller's user doc.
  These are cached within a single evaluation, so the read cost is one user-doc lookup per
  request — the same footprint the previous `isUserActive()` rules already had.
