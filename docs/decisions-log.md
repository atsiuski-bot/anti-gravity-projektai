# WORKZ — Decisions log

Chronological index of major decisions (ADRs) and notable inline decisions.
**AI agents read this first for orientation.**

## ADRs

| # | Date | Status | Decision |
|---|---|---|---|
| [0001](./adr/0001-visual-design-system.md) | 2026-06-20 | Accepted | Visual design system & tokens — keep the bold whole-screen session color (with mandatory text labels), indigo brand accent, system font, WCAG AA as a mandatory gate, dual density, canonical component set. |
| [0002](./adr/0002-agent-operating-model.md) | 2026-06-20 | Accepted | Agent operating model — `AGENTS.md`/`CLAUDE.md` entry points, free-write + `[ai-author]` audit, English artifacts / Lithuanian UI, Netlify hosting + Firebase backend, `docs/` + ADR structure. |
| [0003](./adr/0003-push-notification-strategy.md) | 2026-06-22 | Superseded by 0004 | Notification strategy — originally deferred FCM background push; reversed same day. The permission-on-first-interaction change still stands. |
| [0004](./adr/0004-notification-infrastructure.md) | 2026-06-22 | Accepted | Notification infrastructure — **build the full stack**: Cloud Functions (`functions/`) as FCM sender + Storage-orphan janitor, client token registration + dedicated FCM service worker, a `ToastProvider`, and a global `NotificationsProvider` (unread count → OS badge + foreground toast). Requires Blaze + a VAPID key + human-run `functions`/rules deploys — see `docs/runbooks/fcm-notifications-deploy.md`. |

## Notable inline decisions

- **2026-06-22** — **Unified pop-up presentation on one shell.** Every informational pop-up /
  dialog renders through the canonical `Modal`: the scrim dims the whole viewport and the
  dialog is a content-sized card **centred over it**, including on phones, where a pop-up must
  appear centred over the full screen rather than anchored to a trigger or corner (it is *not*
  stretched edge-to-edge). The two worker time pop-ups (`TaskTimeWarningPopup`,
  `TaskTimeLimitPopup`) — previously hand-rolled `fixed inset-0` overlays with their own scrim
  opacities (`bg-black/40` vs `/50`), focus-traps and z-values — were folded onto `Modal` via
  two new escape hatches: `bare` (caller-owned full-bleed chrome) and `level="top"` (alarm
  above any open modal). `InfoPopover` keeps its compact anchored bubble on `≥sm` but opens as
  a centred `Modal` over the dimmed screen on phones (so it is no longer a bubble that can clip
  off the edge). Toast stays a transient top notification (already on the shared tokens).
  Rationale + the design rule live in `DESIGN_SYSTEM.md` §8.
- **2026-06-20** — Retired the legacy **"Viduramžiai.LT"** brand. The product name is now
  **WORKZ** only; the old name was removed from `index.html`, `vite.config.js`, and
  `README.md`, and must not be reintroduced anywhere in code or copy.
- **2026-06-20** — `index.html` `lang` corrected from `en` to **`lt`** (the UI is Lithuanian).
- **2026-06-22** — Retroactive description for **remote-ended quick-work sessions** (audit
  #8(a)). A quick-work session ended on another device is auto-logged with a generic title and
  `autoStopped: true` (the worker never saw the naming prompt); that flag was previously written
  but never read. The worker can now describe it after the fact, surfaced both ways: a one-shot
  "prompt on return" modal and a persistent "Aprašyti" banner in `Layout`, sourced from
  `useUndescribedQuickWork` (live `tasks`, so an entry drops out when described **or** when the
  nightly automation archives it — "until archived"). `addQuickWorkDescription` renames BOTH the
  task and its work_session; to make that join reliable the auto-log path now stores a
  `workSessionId` link on the task (the session's own `taskId` is synthetic, so the two were
  otherwise unjoined). Stays within existing Firestore rules (owner update, no approval-field
  flip) — no rules change. Legacy pre-link records fall back to a bounded best-effort session
  lookup. The bold whole-screen session red stays reserved for the ACTIVE state; the reminder is
  a calm card with only a quick-work accent strip.
- **2026-06-22** — **Checklists (sub-tasks) Phase 1** shipped. Stored as a `checklist` array on
  the task document (`{id, text, done, doneBy, doneByName, doneAt, createdAt}`), mirroring the
  `comments[]`/`links[]` pattern — chosen over a subcollection for free reads, single-`updateDoc`
  writes, and rule simplicity. **No `firestore.rules` change needed**: the assigned worker may
  already update their own task as long as it does not flip the manager-only approval fields, and
  a checklist mutation never does. Logic in `src/utils/checklistActions.js`; surfaces: `TaskModal`
  (authoring), `TaskCard` + `TaskTable` (progress badge + `ChecklistModal` to tick/add/delete).
  Manager saves reconcile the checklist via an atomic transaction (three-way merge of
  baseline/authored/live) so a worker's concurrent live ticks/adds are never clobbered.
- **2026-06-22** — **Photo attachments** improved for field use: a direct-camera button
  (`capture="environment"`) beside the gallery picker, a combined upload-progress bar, and
  per-file size shown before upload (`TaskModal`). Client-only; compression already existed
  (`imageUtils.js`). Storage-orphan cleanup + a content-type rule were deliberately **not** done
  here (they touch production data / need a human-run rules deploy) and remain open follow-ups.
- **2026-06-22** — **Resolved the three remaining deferrals** (see [ADR 0004](./adr/0004-notification-infrastructure.md)):
  (a) **FCM background push** — added a `functions/` Cloud Functions codebase as the sender
  (data-only messages on `request_notifications`/`calendar_requests`), client token registration
  (`src/utils/messaging.js`), a dedicated FCM service worker, and an `fcm_tokens/{uid}` owner rule.
  (b) **Badge + toast** — a new `ToastProvider` and a global `NotificationsProvider` (single unread
  source → OS app-icon badge + foreground toast from the live listeners, push-independent).
  (c) **Storage orphan cleanup + content-type rule** — done server-side via Cloud Functions
  (admin SDK deletes objects on attachment removal / true task deletion, with an archive-vs-delete
  sibling guard) plus a tightened `storage.rules` (`image/*`, < 20 MB). **Activation is founder-run**
  (Blaze plan, VAPID key, `firebase deploy --only functions` + rules) — `docs/runbooks/fcm-notifications-deploy.md`.
- **2026-06-22** — **Notification module cross-device hardening** (multi-agent review of the FCM
  stack). Fixes, no architectural change to ADR 0004: (1) **Android-safe local notifications** —
  session/timer alerts used the page `new Notification(...)` constructor, which throws "Illegal
  constructor" on Android Chrome / installed PWAs (silently swallowed → dead on the worker's main
  device). New `src/utils/localNotify.js` routes through a service worker (FCM SW → desktop
  constructor → Workbox SW fallback), with real PNG icons instead of emoji/`favicon.ico`. (2)
  **Token lifecycle** — `registerFcmToken` now re-runs on `visibilitychange` (FCM tokens rotate;
  login-only registration let a rotated token go stale), returns a status; new `removeFcmToken`
  (arrayRemove + `deleteToken`) runs on explicit logout so a handed-over device stops receiving
  the previous user's push (owner-rule requires it BEFORE `signOut`). (3) **Push routing/dedup** —
  FCM SW `notificationclick` honors a per-message `data.link` (deep link to `?tab=`); per-event
  `notifId` tag + `renotify` so distinct alerts (esp. multiple pending calendar requests) no longer
  silently collapse onto one slot. (4) **SW resilience** — pinned FCM SDK bumped 10.8.0 → 10.14.1
  (match bundle) and `importScripts`/init wrapped in try/catch. (5) **Payload hygiene** — comment
  text clamped/whitespace-collapsed (100 ch) before it crosses onto a lockscreen; removed the dead
  `onForegroundMessage` export + corrected the "onMessage foreground" doc/comments (foreground is
  Firestore-listener-sourced by design). (6) **iOS** — InstallPrompt now states push needs the PWA
  installed to Home Screen. **`firestore.rules` change (needs founder deploy):** `request_notifications`
  CREATE was `if isUserActive()` with no shape check, yet each doc triggers a push — now requires a
  string `recipientId`, binds provenance to the caller (`createdBy` OR `userId` == uid, so a user
  can't forge a notification "from" someone else), requires unread, and clamps `commentText` ≤ 2000.
  All four client write-sites satisfy it. Residual (rules can't rate-limit): a per-sender throttle
  belongs in the Cloud Function — open follow-up.
- **2026-06-22** — **Desktop app shell → a single left rail.** On `lg+` (≥1024 px) the bottom
  tab bar and the floating work pill are replaced by one docked left rail (`SideRail`), read
  top→bottom: brand → primary `Sukurti` → grouped destinations (Mano / Komanda /
  Administravimas) → session work-controls → account. This merges the two stacked bottom
  surfaces into one (DESIGN_SYSTEM §9 "prefer merging into one docked surface") and follows the
  desktop convention of an edge rail over a thumb-reach bottom bar. **Phones and tablets keep the
  bottom bar unchanged.** Tab definitions were extracted to a shared `src/config/navTabs.js` so
  the rail and the bottom bar can never drift (§3 "one way to do a thing"). The rail-vs-bottom-bar
  choice is gated by a **JS media query** (`src/hooks/useMediaQuery.js`), *not* CSS, on purpose:
  both navs mount the session timers, whose `useTimerState` starts a `SoundManager` singleton beep
  and an SR live-region announcement, so a CSS-hidden duplicate would double both — exactly one nav
  is mounted at a time. The whole-screen session signature is preserved; on desktop the workspace
  area carries the tint while the rail stays a calm neutral panel.
- **2026-06-22** — **Functions migrated to Node 22 + `firebase-functions` 7 (code done; re-deploy pending).**
  Node 20 is decommissioned for Cloud Functions **after 2026-10-30**, so ahead of that
  `functions/package.json` was moved to `engines.node: "22"` and `firebase-functions ^6.1.0 → ^7.2.5`.
  `firebase-admin` is **held at `^13`**: `firebase-functions@7` declares its peer as
  `firebase-admin ^11.10 || ^12 || ^13`, so admin 14 (which itself requires Node ≥22) must wait for a
  later `firebase-functions` peer bump — minor follow-up. Verified locally on Node 22: `npm install`
  resolves cleanly (no `--legacy-peer-deps`) and every `index.js` import target (v2 firestore
  triggers, `setGlobalOptions`, `logger`, and the admin `getFirestore`/`getMessaging`/`getStorage`
  modular entry points) resolves on the new majors; functions `eslint` is clean. **The running
  functions stay on Node 20 until the founder re-deploys** (`firebase deploy --only functions`) — the
  runtime only changes at deploy time. See [ADR 0004](./adr/0004-notification-infrastructure.md) and
  the [FCM runbook](./runbooks/fcm-notifications-deploy.md).
