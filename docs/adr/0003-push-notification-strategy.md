# ADR 0003: Notification strategy — in-app + foreground now, FCM background push deferred

- **Date**: 2026-06-22
- **Status**: Accepted
- **Decision-maker**: Founder (Karol)
- **AI assistant during decision**: claude-opus-4-8

## Context

"FCM push" recurred as an undocumented **strategic deferral** across earlier sessions. An
analysis of the current notification surface established what actually exists today:

- **Foreground Web Notifications** — `src/hooks/useSessionNotification.js` fires
  `new Notification(...)` for active session state; `src/utils/soundUtils.js` adds Web-Audio
  tones + `navigator.vibrate`. These only appear **while a tab is open/foregrounded**.
- **In-app Firestore feed** — `src/components/ManagerNotifications.jsx` listens (`onSnapshot`)
  to `request_notifications`, `calendar_notifications`, and `calendar_requests` and renders a
  real-time, sorted manager feed. `src/components/CalendarRequestStatusBanner.jsx` is the
  worker-side equivalent.
- **No FCM** — `src/firebase.js` carries a `messagingSenderId` in config but never calls
  `getMessaging()`; `firebase/messaging` is not used; there is no VAPID key, no FCM token
  storage, and no foreground `onMessage()` handler.
- **No sender** — `firebase-admin` is a `devDependency` only; there is **no `functions/`
  directory and no `functions` block in `firebase.json`**. Per [ADR 0002](./0002-agent-operating-model.md)
  the backend is **Firebase data-only** (Auth/Firestore/Storage), no serverless compute.

True background push (phone in pocket, app closed) is therefore **not a missing line of
code** — it is an architectural commitment: it requires a service worker that handles `push`
events (the current `vite-plugin-pwa` runs in Workbox `generateSW` mode, which cannot host a
custom push handler), a VAPID key, per-user token storage + a matching Firestore rule, **and**
a sender (Cloud Functions or an external server) that none of the stack currently provides.

## Alternatives considered

- **Defer background push; invest in the in-app + foreground surface** *(chosen)* — keep the
  Firebase data-only stance; ship the client-only notification wins that need no backend.
- **Build the full FCM stack now** — ❌ adds an always-on serverless backend, VAPID/key
  management, token lifecycle, and an `injectManifest` custom service worker that complicates
  the existing PWA. The primary notification consumer (the manager) is desk-bound with the
  live feed open, so foreground + in-app already covers the dominant case; the cost/benefit
  does not justify crossing the "no serverless compute" line yet.
- **Drop notifications entirely / rely on polling the UI** — ❌ the manager approval loop and
  worker session reminders genuinely benefit from the existing real-time feed.

## Decision

1. **Background FCM push is deferred**, explicitly, until a worker-facing *tab-closed* alert
   becomes a real, repeated need. It is no longer an undocumented loose end.
2. **Notification permission is requested on the first user interaction, not on app load**
   (`src/App.jsx`) — a cold prompt with no user gesture is ignored/penalized by modern
   browsers (and disallowed by Safari), wasting the one-time ask.
3. The **in-app Firestore feed + foreground Web Notifications remain the notification model**
   for now.

## Consequences

- No new backend surface, no VAPID/token lifecycle, no custom service worker to maintain.
- Notifications still do **not** reach a user whose tab/app is fully closed — an accepted
  limitation given the manager-centric usage pattern.
- The permission opt-in rate should improve (asked in-context rather than cold at startup).

## Follow-ups (not done here — each needs its own slice)

- **Badge API** (`navigator.setAppBadge`) for unread manager items and a **foreground toast**
  on a new notification were scoped OUT of this change: both require infrastructure that does
  not yet exist — a single app-wide *unread-count provider* (today the count lives only inside
  `ManagerNotifications`, which is not always mounted) and a reusable *toast system* (there is
  none — `z-toast` is only the offline banner). Build that shared plumbing first, then layer
  Badge + toast on top.
- **When/if background push is greenlit:** stand up Cloud Functions as the sender, switch the
  PWA to `injectManifest` with a `firebase-messaging-sw.js`, add a VAPID key + an `fcm_tokens`
  store with a per-owner Firestore rule, and an `onMessage()` foreground handler. This is a
  deliberate, separately-tested track — revisit ADR 0002's "Firebase data-only" stance first.
