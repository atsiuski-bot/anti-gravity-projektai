# Deploy Firestore Security Rules — Manual Steps

> **The repo `firestore.rules` may be ahead of what is live.** Firestore rules are NOT
> deployed by the Netlify build (Netlify ships the static app only). After any change to
> `firestore.rules` or `storage.rules`, someone must deploy them manually to the
> **`darbo-planavimas`** Firebase project. Until then the live rules and the repo can drift.

## Current security model (as of the 2026-06-21 hardening)

`firestore.rules` enforces **per-document ownership** with a manager/admin escape, not just
"any active user". The shape:

- **Identity:** `isUserActive()` = authenticated + the user doc exists + `isDisabled != true`.
  `isManagerOrAdmin()` reads the caller's `role` from their own user document.
- **Per-user collections** (`tasks`, `work_sessions`, `break_sessions`, `work_hours`,
  `archived_tasks`, `calendar_requests`, `calendar_notifications`, `sessions`): a worker may
  read/write only documents they own (owner field: `assignedUserId` for tasks, `userId` for
  the rest); managers/admins may read all and write corrections/approvals. This closes the
  old hole where any active worker could read or mutate **any** other worker's data.
- **`request_notifications`:** owner is the `recipientId` (the manager being notified); any
  active user may create one, only the recipient reads/updates it.
- **`task_templates`:** intentionally shared — any active user reads all; only the creator
  (or a manager) edits/deletes.
- **`users`:** you can always read your **own** document (login bootstrap), but reading
  **other** users now requires `isUserActive()`, so a disabled account can no longer
  enumerate the whole company during the ~1h its token is still valid. Roles change only by
  admins; `isDisabled` toggles only by managers/admins.
- **No-self-approval:** a worker may edit their own task but **cannot** flip the manager-only
  approval/confirmation fields (`status` → `confirmed`/`approved`, `confirmedBy`,
  `approvedBy`, `isApproved`); only managers/admins can.
- **Unused collections** (`shift_logs`, `daily_stats`, `deleted_tasks`) are locked
  (`if false`) — the client never touches them, so they should not be writable.
- **`error_logs`:** any authenticated user may append a crash report; only managers/admins
  read; entries are immutable; only admins clear them.

`storage.rules` scopes `attachments/{userId}/…` to the owner with a 100 MB write cap.

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
