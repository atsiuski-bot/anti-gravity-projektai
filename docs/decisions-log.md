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
