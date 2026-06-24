# ADR 0017 — Notification registry: one source of truth for every alert

- **Date:** 2026-06-24
- **Status:** Accepted
- **Supersedes / relates to:** [0004](./0004-notification-infrastructure.md) (delivery infra),
  [0006](./0006-notification-bell-and-two-way-feed.md) (the bell + two-way feed + the `notify()` funnel).

## Context

The bell notification system (ADR 0004 + 0006) is sound at the transport layer — one
`request_notifications` spine, a `notify()` write funnel, data-only FCM push rendered by a single
service worker, an always-on foreground toast. But the **identity** of a notification type was
scattered across four files that had to be edited in lockstep and could silently disagree:

1. the type→category map (`utils/notify.js`),
2. the in-app toast copy (`context/NotificationsContext.jsx`),
3. the push copy on the server (`functions/index.js → copyForRequestNotification`),
4. the feed renderer (`components/ManagerNotifications.jsx`).

The copy lived in (2) and (3) with **nothing linking them**, and had already drifted —
`task_confirmed` read "užbaigta ir **priimta**" in the toast but "užbaigta ir **patvirtinta**" in the
push, and `recurring_reassign` had no client copy at all (it toasted a generic "Naujas pranešimas"
while the push said "Priskirkite kitą vykdytoją"). Adding a type meant remembering all four edits.

Two further defects compounded it:
- **Sound was divorced from the notification plane.** The only in-feed sound (`playBeep`) lived inside
  `ManagerNotifications`, which mounts **only when the bell panel is open**, and fired for **one** type
  (`time_extension_request`). The always-on toast was silent. Net effect: a user heard a notification
  when the app was *closed* (the OS push sound) but not when it was *open*.
- **`playBeep` was double-coupled** — it played a tone *and* raised a hard-coded "Praėjo 7 min." OS
  notification, so using it for a time-extension alert showed the wrong text.
- Five write sites still `addDoc`-ed `request_notifications` inline, re-implementing the rule invariants
  by hand (four remained; `new_comment` had already migrated).

## Alternatives considered

- **True shared module** imported by both client and Cloud Function. Rejected: `functions/` is a
  separate CJS package deployed on its own; a file under `src/` is never bundled into the deploy, so it
  cannot be the server's source. Sharing across the deploy boundary is not possible without a build
  step we don't have.
- **Generate the server copy from the registry at build time.** Over-engineering for one switch; adds a
  codegen step to a `functions/` package that has none.
- **Leave it as four files, add discipline.** This is the status quo that already drifted. Rejected.

## Decision

Introduce **`src/notifications/registry.js`** as the single source of truth: one entry per
`request_notifications` type declaring its four delivery dimensions — `category`, `copy(n) → {title,
body}`, `sound` (`alert` | `info` | `null`), `push`, and `link`. The client reads it directly for the
toast copy, the toast sound, the bell tier and the deep link. `notify.js` derives `category` from it.

The Cloud Function keeps a hand-copied **mirror** (`copyForRequestNotification`) — unavoidable across
the deploy boundary — but the [`firebaseConsistency`](../../src/__tests__/firebaseConsistency.test.js)
gate now **evaluates that mirror and fails the build if its output drifts** from the registry, exactly
like the existing priority/estimate/recurrence mirrors. Divergence is no longer silent; it's a red
gate before any ship.

Three coupled fixes ride along:
- **Sound moves to the always-on plane.** `NotificationsContext` plays one per-batch cue
  (`SoundManager.playNotificationCue`, `alert` outranks `info`) at the same moment it shows the toast,
  for **every** type, regardless of whether the bell is open. The per-panel `playBeep` special-case is
  removed.
- **`playBeep` is decoupled** into sound-only; the 7-minute timer's OS notification moves to a dedicated
  `playSevenMinuteBlock`, which also fixes a latent "announce on start" bug.
- **The four remaining inline writers migrate to `notify()`**, so no write can drift from the
  invariants.

The `task_confirmed` divergence is resolved to the canonical completion-gate vocabulary ("priimta");
`recurring_reassign` and `session_correction_request` copy is unified across client and server.

## Consequences

- Adding a notification is now **one registry entry + one mirror case + one test sample** (+ a trigger
  only if server-fired). Documented in [`docs/guides/adding-a-notification.md`](../guides/adding-a-notification.md).
- The toast a user sees and the push they receive **cannot disagree** — the gate enforces it.
- A notification is now **audible whether the app is open** (the in-app cue) **or closed** (the OS push
  sound), within the platform limits (iOS in-app audio remains best-effort; the toast is never the sole
  signal).
- Client-only change at runtime; the `firestore.rules` are untouched (a new *type* needs no rule).
- **Deploy:** the server copy fix (`task_confirmed`, `session_correction_request`) lives in
  `functions/`. It reaches production only when a human runs `firebase deploy --only functions` from an
  up-to-date `main` checkout **after** this merges — per CLAUDE.md's post-ship deploy rule. Until then
  the push for those two types keeps the old wording; the in-app toast is already correct.

## Follow-ups

- Optional: migrate `ManagerNotifications`' render/icon switch to read an `icon`/`render` hint from the
  registry, closing the last "half-wired type renders as a generic row" gap. Deferred — the 877-line
  panel refactor is higher-risk than the value, and the consistency gate already covers copy.
- Optional: have the server honor `push: false` so a future in-app-only type can opt out of FCM without
  touching the switch. No type needs it today.
