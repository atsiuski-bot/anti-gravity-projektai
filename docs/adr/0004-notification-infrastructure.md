# ADR 0004: Notification infrastructure — implement FCM background push + in-app toast/badge

- **Date**: 2026-06-22
- **Status**: Accepted (supersedes [ADR 0003](./0003-push-notification-strategy.md))
- **Decision-maker**: Founder (Karol)
- **AI assistant during decision**: claude-opus-4-8

## Context

[ADR 0003](./0003-push-notification-strategy.md) deferred true background push because it
requires a **sender** the stack did not have, and crossing the "Firebase data-only" line from
[ADR 0002](./0002-agent-operating-model.md). The founder has now chosen to **build all of it**:
background push, the in-app toast, the unread badge, and the long-standing Storage-orphan
cleanup (which also needs admin-side compute). This ADR records that reversal and the resulting
architecture. ADR 0003's analysis of *what exists* still holds; only its disposition changed.

## Decision

**Adopt a Cloud Functions (2nd-gen) codebase** under `functions/` as the backend sender and
janitor, and wire the matching client surface:

1. **FCM background push.**
   - `functions/index.js` triggers on `request_notifications` create (manager alerts) and
     `calendar_requests` create (pending approvals), looks up the recipient's device tokens at
     `fcm_tokens/{uid}`, and sends a **data-only** FCM message (avoids the web double-display
     gotcha). Dead tokens are pruned on send failure.
   - Client (`src/utils/messaging.js`) registers the device token once notification permission
     is granted and stores it under `fcm_tokens/{uid}.tokens` (owner-only Firestore rule).
   - A dedicated service worker (`public/firebase-messaging-sw.js`) renders background
     messages at its own FCM scope, coexisting with the Workbox PWA SW (excluded from Workbox
     precache via `globIgnores`).
2. **In-app toast + unread badge (no push needed for the foreground case).**
   - A new `ToastProvider` (`src/context/ToastContext.jsx`) — the app had no toast system.
   - A global `NotificationsProvider` (`src/context/NotificationsContext.jsx`) is the single
     always-mounted source of the manager unread count (unread `request_notifications` +
     pending `calendar_requests`). It drives the OS app-icon badge (`navigator.setAppBadge`)
     and fires a foreground **toast** when a new item arrives — sourced from the live Firestore
     listeners, so it works even before FCM is configured. FCM only adds the *tab-closed* case.
3. **Storage-orphan cleanup as Cloud Functions** (admin SDK can delete any object; the client
   can only delete its own uploads). Triggers: on task **update** delete objects dropped from
   the attachment list; on task/`archived_tasks` **delete** delete the attachments — guarded by
   a sibling-existence check so an archive *move* (copy exists in the other collection) never
   deletes still-referenced files.
4. **Storage rule tightened** to image content-types under 20 MB (closes the `accept="image/*"`
   client bypass).

## Consequences

- **Requires the Firebase Blaze (pay-as-you-go) plan** — 2nd-gen functions run on Cloud Run.
  This is the cost ADR 0003 weighed against; the founder accepts it.
- New always-on backend surface (functions) + a second service worker to maintain.
- Foreground alerting now works regardless of FCM (the Firestore listeners), so the app
  degrades gracefully when push is not yet configured (missing VAPID key → token registration
  simply no-ops; everything else still works).
- Notifications still target **managers** primarily; worker-facing pushes (e.g. on calendar
  approval) are a straightforward later extension — tokens are already registered for every
  user.

## Follow-ups / deploy (founder-run — see `docs/runbooks/fcm-notifications-deploy.md`)

This change ships the **code**; activation needs human-run steps the AI cannot perform:
1. Enable **Blaze** billing on the Firebase project.
2. Generate a **Web Push (VAPID) key** (Firebase console → Cloud Messaging) and set
   `VITE_FIREBASE_VAPID_KEY` in the Netlify build env.
3. `cd functions && npm install`, then **`firebase deploy --only functions`**.
4. **`firebase deploy --only firestore:rules,storage:rules`** (adds `fcm_tokens` rule +
   image/size constraint).
Until step 2–3 are done, push is dormant but the app, toast, badge, and (post-deploy) Storage
cleanup are unaffected.
