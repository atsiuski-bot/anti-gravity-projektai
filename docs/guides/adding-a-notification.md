# How to add a notification

> The single, authoritative procedure for adding a new notification to WORKZ. Read this before
> wiring any new alert. It replaces the old "edit four files and hope they agree" tribal knowledge.
>
> Architecture decision: [ADR 0017](../adr/0017-notification-registry.md). Background:
> [ADR 0004](../adr/0004-notification-infrastructure.md) (delivery infra),
> [ADR 0006](../adr/0006-notification-bell-and-two-way-feed.md) (the bell + two-way feed).

## The model in one picture

Every bell notification is **one Firestore document** in `request_notifications`, and it fans out to
the user along **four delivery dimensions**:

| Dimension | Where it happens | When |
|---|---|---|
| **Feed row/card** | `ManagerNotifications` (the bell panel) | whenever the user opens the bell |
| **Toast** | `NotificationsContext` (always mounted) | app is open + a new doc arrives |
| **Sound** | `SoundManager.playNotificationCue` via `NotificationsContext` | same moment as the toast |
| **External push** | Cloud Function `notifyOnRequestNotification` → FCM → OS tray (with the OS sound) | app is closed / backgrounded |

A background push may additionally carry up to **two decision buttons** — see
[§ Decision buttons](#decision-buttons-on-the-background-push-adr-0024) below.

The **type** of a notification — its tier, its Lithuanian copy, its in-app sound, its external-push
intent, its deep link and its push buttons — is declared in **one place**:

> **[`src/notifications/registry.js`](../../src/notifications/registry.js)** — the single source of truth.

The Cloud Function can't import that file across the deploy boundary, so it keeps a hand-copied
**mirror** of the copy (`copyForRequestNotification` in `functions/index.js`). The
[`firebaseConsistency`](../../src/__tests__/firebaseConsistency.test.js) test gate evaluates that
mirror and **fails the build if it drifts** from the registry — so the toast and the push can never
say different things again.

## Step-by-step: add a new notification type

### 1. Declare it in the registry

Add one entry to `NOTIFICATIONS` in `src/notifications/registry.js`:

```js
my_new_event: {
    category: 'action',          // 'action' = a decision is owed (floats to top) | 'info' = FYI row
    sound: 'alert',              // 'alert' = decision arrived | 'info' = soft FYI | null = silent
    push: true,                  // fan out to an external OS/lockscreen notification?
    link: '/?tab=tasks',         // the in-app tab tapping it opens
    // actions: [...],           // OPTIONAL — decision buttons on the push. Most types omit this.
    copy: (n) => ({ title: 'Trumpa antraštė', body: n.taskTitle || 'WORKZ' }),
},
```

Copy rules:
- **Lithuanian, formal "Jūs".** Keep the title short (it lands on a lockscreen).
- **Clamp any free-form, user-authored text** (a comment, a note) with the `clamp()` helper — it
  collapses whitespace and caps length so it can't be weaponised onto a lockscreen.
- `copy(n)` receives the notification document, so you can read `n.taskTitle`, `n.day`,
  `n.decision`, `n.commentText`, `n.targetUserName`, etc.

That single entry now drives the toast copy, the toast sound, the bell tier and the deep link.

### 2. Mirror the copy on the server

In `functions/index.js`, add the matching `case` to `copyForRequestNotification`:

```js
case 'my_new_event':
    return { title: 'Trumpa antraštė', body: n.taskTitle || 'WORKZ' };
```

It must return the **same `{ title, body }`** the registry produces for the same document. If it
doesn't, the consistency test goes red and tells you exactly which type and payload diverged.

### 3. Add the test coverage

In `src/__tests__/firebaseConsistency.test.js`, add a `SAMPLES` payload for the new type (one entry
per branch your copy has — e.g. with and without a comment). The test will refuse to pass until every
registry type has a sample, so this is not optional.

### 4. Write the notification

**Never `addDoc` to `request_notifications` directly.** Always go through the funnel, which stamps the
rule-required invariants (provenance, unread flag, category) and drops self-notifications:

```js
import { notify, notifyMany } from '../utils/notify';

// One recipient (task-bound → the single assigned manager / the worker):
await notify({
    recipientId: managerId,
    type: 'my_new_event',
    taskId, taskTitle,
    actorUid: currentUser.uid,                 // → createdBy (provenance for the rules)
    actorName: currentUser.displayName || currentUser.email,
});

// Many recipients (person-level → ALL of a worker's managers):
await notifyMany(managerIds, { type: 'my_new_event', actorUid, actorName, /* … */ });
```

Provenance convention: pass `actorUid` for a manager/admin-authored event (becomes `createdBy`), or
pass `userId: currentUser.uid` for a worker-authored event — the rules require one of the two to equal
the caller.

### 5. (Only if the server fires it) add a Cloud Function trigger

If the notification is raised by a backend event (a schedule, another document changing) rather than a
user action, write the `request_notifications` document from a Cloud Function — see
`notifyAdminsOnPendingSignup` and the recurring-task generator in `functions/index.js` as templates.
The existing `notifyOnRequestNotification` trigger will pick it up and push it automatically; you do
**not** write a new push sender.

### 6. (Usually nothing) Firestore rules

The `request_notifications` rule already gates create on a non-empty `recipientId`, the unread flag and
provenance, and gates read on `recipientId`. A new **type** needs **no rule change**. You only touch
rules if you introduce a brand-new collection — and then the consistency test's "rules coverage"
section will remind you.

## Decision buttons on the background push (ADR 0024)

Most notifications need none — skip this section unless the new type carries a decision the recipient
can settle in **one tap**.

A button **never decides anything itself.** The service worker has no auth, no Firestore and none of
the feed's guards (the deleted-task self-heal, the "another manager already decided" re-read, the undo
window). It hands the app an *intent*, and the app runs **the same handler the in-app card's button
runs** — so a lockscreen tap and a panel tap are the identical, equally-guarded action. Keeping the
worker write-less is the whole safety argument; a test asserts it never imports Firestore.

To add buttons to a type:

1. **Declare them** in the registry entry, reusing an existing `ACTION_*` constant where possible:
   ```js
   actions: [ACTION_APPROVE, ACTION_OPEN],
   ```
2. **Mirror them** in `PUSH_ACTIONS_BY_TYPE` (`functions/index.js`) — same ids, same Lithuanian
   titles, **same order**. The consistency gate compares all three.
3. **Wire the handler** in `ManagerNotifications`' push-intent effect: map the action id to the
   handler the card's button already calls, and pin it to this notification type.
4. If the action id is new, add it to `ACTION_*` + `PUSH_ACTION_IDS` in the registry — the gate
   rejects an id the app has no handler for.

Rules that the test gate enforces, and the reasoning behind each:

- **Two buttons maximum.** `Notification.maxActions` is 2 on Chrome; a third is dropped silently.
- **Only `action`-category types.** An FYI has nothing to decide.
- **Nothing destructive or privilege-granting.** Ištrinti, Grąžinti, Užblokuoti and account approval
  stay in-app, where the confirm dialog and the full context live.
- **No "mark as read" button.** Since acting opens the app, it would cost more than swiping the
  notification away.
- **`Atidaryti` writes nothing** — it just brings the decision card on screen. Do not point it at a
  handler that dismisses the notification, or the decision is discarded by the act of looking at it.

**iOS renders none of this.** Apple's web push has no `actions` at all, so buttons are an accelerator
for Android/desktop — never the only way to reach a decision. The tap-on-the-body path must stay
sufficient on its own.

### If the push does not ride `request_notifications`

A few pushes are sent straight from their own collection's trigger, so they have no registry entry —
today that is `calendar_request` (`notifyOnCalendarRequest`). Their buttons are declared in
**`DIRECT_PUSH_ACTIONS`**, keyed by the `type` the sender stamps into the push payload, mirrored in a
map of the same name in `functions/index.js` and locked by the same consistency test. Everything above
still applies; only steps 1–2 change map. Two extra things to get right:

- **`notifId` must be the id the feed's cards are keyed on** — the intent finds its card by that id
  alone, so a sender that stamps anything else produces a button that reports "already resolved".
- **The intent is matched on whatever identifies that card.** A `request_notification` is matched on
  its `type`; a `calendar_requests` doc's own `type` is the *kind of change* (`add`/`edit`/`delete`),
  so it is matched on `source` instead. Never let an action run without such a check.

## Done-checklist

Before calling a new notification finished:

- [ ] Registry entry added (`category`, `copy`, `sound`, `push`, `link`, and `actions` if it carries
      decision buttons).
- [ ] Server `copyForRequestNotification` mirror case added, identical output.
- [ ] If it declares `actions`: `PUSH_ACTIONS_BY_TYPE` (or `DIRECT_PUSH_ACTIONS` for a non-registry
      sender) mirrored **and** the intent wired to the matching in-app handler in `ManagerNotifications`.
- [ ] `SAMPLES` payload added in `firebaseConsistency.test.js`.
- [ ] The write goes through `notify()` / `notifyMany()` — no inline `addDoc`.
- [ ] If server-fired: a Cloud Function writes the doc (no new push sender needed).
- [ ] `npm run lint` clean · `npm run build` succeeds · `npm test` green.
- [ ] If it should render as a rich **action card** (buttons), add/confirm its branch in
      `ManagerNotifications`; an unhandled type falls back to a generic info row.
- [ ] Deploy is a **post-ship** step: the new push copy is in `functions/`, so after the change merges
      to `main`, a human runs `firebase deploy --only functions` from an up-to-date `main` checkout and
      re-verifies the live function via the Firebase MCP. (Per CLAUDE.md — never deploy from a worktree.)

## What the user actually gets, per platform

Sound and external notification do not behave identically everywhere — design for graceful degradation:

| Platform | Feed + toast | In-app sound cue | External push + OS sound | Decision buttons |
|---|---|---|---|---|
| Desktop Chrome / Edge / Firefox | ✓ | ✓ (after the user's first interaction unlocks audio) | ✓ | ✓ up to 2 |
| Android Chrome | ✓ | ✓ (+ vibration) | ✓ (needs notification permission) | ✓ up to 2 |
| iPhone / iPad Safari | ✓ | ⚠️ unreliable (Web Audio restricted, `vibrate` is a no-op) | ✓ **only when installed to the home screen** (PWA, iOS 16.4+) | ✗ not supported by Apple — tap only |

Implications you can rely on:
- The **feed row and the toast** reach every user on every platform.
- The **in-app sound cue** is best-effort: it needs a prior user gesture in the session, and on iOS it
  may not play. It is never the sole signal — the toast is always there.
- The **OS notification sound** is the cross-platform floor for the backgrounded case, but on iPhone it
  requires the app to be installed as a PWA. The Login/Install screen already nudges iOS users to
  "add to home screen"; keep that path intact.

## File map

| Concern | File |
|---|---|
| The single source of truth (type → category/copy/sound/push/link/actions) | `src/notifications/registry.js` |
| Push-intent capture (SW message + cold-start URL params) | `src/notifications/pushIntent.js` |
| The write funnel (invariants + provenance) | `src/utils/notify.js` |
| Toast + unread badge + sound trigger + FCM token registration | `src/context/NotificationsContext.jsx` |
| The bell panel (feed cards + rows + decision buttons) | `src/components/ManagerNotifications.jsx` |
| In-app sound synthesis | `src/utils/soundUtils.js` (`playNotificationCue`) |
| Server push copy mirror + the FCM sender | `functions/index.js` (`copyForRequestNotification`, `sendToUser`) |
| Background notification render + click routing | `public/firebase-messaging-sw.js` |
| The consistency gate (mirror lock) | `src/__tests__/firebaseConsistency.test.js` |
| Registry completeness | `src/notifications/registry.test.js` |
