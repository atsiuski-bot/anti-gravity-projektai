# ADR 0024 — Decision buttons on a background notification

- **Date:** 2026-07-31
- **Status:** Accepted (client + functions; the push half activates on the next `functions` deploy)
- **Supersedes / amends:** extends [ADR 0017](./0017-notification-registry.md) (the registry gains a
  fifth delivery dimension) and [ADR 0004](./0004-notification-infrastructure.md) (the FCM payload
  gains an `actions` field).

## Context

A background notification could only be **tapped**. The tap opened the app, and every decision — approve
this task, accept this finished work, grant 30 more minutes — still had to be found again in the bell
and pressed a second time. For a manager who is not at a desk, the notification announced work rather
than letting them do it.

Two platform facts bound anything we build here, and neither is negotiable:

- **Android and desktop** render up to **two** buttons on a notification (`Notification.maxActions`).
  A third is dropped silently.
- **iOS ignores `actions` entirely.** Apple's web push offers a tap on the body and nothing else. Any
  design that *depends* on buttons is a design that does not work on half the workforce's phones.

A third fact is ours, not the platform's: the FCM service worker (`public/firebase-messaging-sw.js`)
has **no auth and no Firestore**. It is a bare script loading two compat SDKs at its own scope.

## The real question

Not "can a notification have buttons" — it can — but **who executes the decision**.

Every decision in WORKZ already has exactly one implementation, in the bell's feed
(`ManagerNotifications`), and each of those implementations is mostly *guards*:

- re-read the task/account before writing, because it may have been deleted meanwhile (the orphan
  self-heal, which clears the stale request and says so instead of surfacing a permission error);
- re-read the live status, because **another manager may already have decided** — the server fans one
  card out to every eligible manager, so a blind write lets a second person silently reverse the first;
- commit immediately but offer an **undo window**, holding the outbound worker notification until it
  closes so an undo leaves nothing the worker ever saw;
- map every failure to friendly Lithuanian copy, never a raw error.

Those guards are the decision. A write that skips them is not "the same action, faster".

## Alternatives considered

**A. The button hands the app an intent; the app decides.** (Chosen.)
The worker posts `{action, notifId, type}` to the running app — or cold-starts it with the intent in
the query string — and the app dispatches to the **same handler the in-app card's button calls**.

- Nothing about the security model changes: every write stays behind the user's own auth and the
  Firestore rules. The worker remains write-less by construction.
- Every guard above applies for free, and can never drift, because there is still only one
  implementation of each decision.
- Concurrency resolves itself: two managers tapping "Patvirtinti" produce one commit and one
  "already decided — stale request cleared" notice, exactly as in the panel.
- Android and iOS converge on one code path. The iPhone user's tap lands where the decision is; the
  Android user saves the hunt. The button is an accelerator, never a separate capability.
- Cost: the app must come to the front. That is a real cost, and it is what makes "mark as read"
  useless as a button (swiping the notification away is cheaper), which is why it is not offered.

**B. The button performs the decision in the worker, without opening the app.**
The worker would call a server endpoint carrying a one-time token minted into the push payload.

- Rejected. It creates a new authenticated write surface reachable from a notification payload; it
  reimplements — or skips — every guard listed above; it has no undo, because there is no UI to
  offer one in; it behaves badly offline, which is the norm for field staff; and it would still not
  work on iPhone, so the guards would have to exist twice regardless. A possible v2 if v1's
  open-the-app step proves too slow in daily use, never a starting point.

**C. Do nothing; keep tap-to-open.**
Rejected: the request is real and A is cheap.

## Decision

**Option A.** Buttons are declared **per notification type in the registry** — a fifth delivery
dimension beside category, copy, sound, push and link — using the Notification API's own
`{ action, title }` shape, so the worker passes them through untouched.

Which types get buttons, and why only these three:

| Type | Buttons | Reasoning |
|---|---|---|
| `task_approval` | Patvirtinti · Atidaryti | approve is one tap and undoable; Redaguoti opens an editor and Ištrinti is irreversible |
| `task_completion` | Priimti · Atidaryti | sign-off is one tap and undoable; Grąžinti reopens the task *and* the editor |
| `time_extension_request` | Pratęsti +30 min · Atidaryti | the common grant; "+1 val." would crowd out Atidaryti, and a refusal the worker is waiting on deserves context |
| `calendar_request` | Patvirtinti · Atidaryti | *(amendment, follow-up 1 — see below)* approve is one tap; Atmesti blocks the worker's planning and deserves the card's context |

The exclusions are the load-bearing part of the decision:

- **Destructive or privilege-granting decisions never get a button** — Ištrinti, Grąžinti,
  Užblokuoti, and approving a new account (`account_approval`). These stay in-app where a confirm
  dialog and the surrounding context exist. Approving an account is not destructive, but granting
  someone access to the system is precisely the class of decision that should not be a lockscreen
  reflex; it is rare enough that one extra tap costs nothing.
- **"Mark as read" is not a button.** Under the open-the-app model it would cost more than swiping.
- **`Atidaryti` performs no write at all.** It brings the decision card on screen, so "let me look
  first" is one tap instead of a hunt. It is deliberately *not* wired to the existing "open the task"
  handler, which dismisses the notification — on an approval request that would silently discard the
  very decision the manager came to make.
- **Calendar approval requests were out of scope for v1.** They ride a different collection and a
  different sender (`notifyOnCalendarRequest`), outside the registry the mirror test locks. Deferred
  rather than special-cased — and delivered in the amendment below.

### Mechanics

- **Rendering.** The server attaches the buttons as JSON in the FCM data payload (values must be
  strings) and omits the key entirely for tap-only types, keeping the common push small. The worker
  re-validates and re-shapes what it receives and clamps to `Notification.maxActions` — a malformed
  payload degrades to a **button-less notification, never an unrendered one**, because a push that
  arrives without a visible notification is what gets an iOS subscription revoked.
- **Delivery.** A tap posts the intent to a live window; with no window open the worker cold-starts
  the app with the intent in the query string, which is read **once at module load** and stripped
  from the URL, so a reload or a restored tab can never replay a decision.
- **Why postMessage and not `navigate`.** The FCM worker is registered at its own scope and does not
  control the page at `/`, so `WindowClient.navigate()` rejects with a TypeError. The pre-existing
  deep link therefore never moved an already-open app to the right tab — it silently fell through to
  `focus()`. This change fixes that too: the same message now carries plain taps.
- **Execution.** The intent is matched against the notification's own type before it runs; an
  unknown or mismatched pair falls back to showing the card, never to a write. A monotonic sequence
  number makes each intent execute at most once (React StrictMode double-invokes effects in dev, and
  re-running a committed decision would be a genuine double write). A notification that is already
  gone reports "šis prašymas jau išspręstas" rather than appearing to do nothing.

### Drift control

The button set is hand-copied into `functions/index.js` (`PUSH_ACTIONS_BY_TYPE`) and the channel
constants into the worker, because neither can import client ESM. Both mirrors are locked by
`firebaseConsistency.test.js` — ids, Lithuanian titles **and order**, plus the platform contract
(≤2, known ids, real titles) and the product rule that only an `action`-category type may carry a
button. A separate assertion keeps the worker write-less: importing Firestore there would recreate
option B by accident.

## Consequences

- **Android / desktop:** a manager approves, accepts or extends from the notification. The app opens
  on the decision, the undo snackbar is right there, and the result is identical to the in-app tap.
- **iPhone:** unchanged buttons-wise (Apple offers none), but the tap now actually lands on the right
  tab in an already-open app — a fix, not a regression.
- **Failure mode is silence, not damage.** A lost intent, an old bundle, the login screen: the app
  comes to the front and nothing is written.
- The registry gains a dimension, so `adding-a-notification.md` and the registry completeness suite
  grow one optional field. Most types will keep declaring nothing.
- **Founder-run (post-ship):** `firebase deploy --only functions` from an up-to-date `main`
  checkout — the buttons only reach a device once the sender ships them. The client half is inert
  until then (no `actions` in the payload ⇒ today's notification, unchanged).

## Amendment — 2026-07-31: calendar approval requests (follow-up 1)

`calendar_request` now carries **Patvirtinti · Atidaryti**. Nothing above changes; the question was
only *where the declaration lives* so the drift lock still reaches it.

A `calendar_request` push is not a `request_notification` — it is fanned out by its own
collection trigger — so it cannot take a registry entry: the registry's keys **are** the
request_notification types, and the copy/category mirrors are locked against that key set, so an
entry there would fail the very gate it was meant to satisfy. Special-casing it out of the
assertions was the other option and was rejected: the value of the lock is that it has no holes.

So the boundary is made explicit instead. A second map, **`DIRECT_PUSH_ACTIONS`**, declares buttons
for push types that do not ride `request_notifications`, keyed by the `type` its sender stamps into
the payload, mirrored in `functions/index.js` under the same name and locked by its own lockstep
suite — ids, titles, order, the ≤2/known-id/real-title contract, and a **disjointness** assertion so
a type can never be declared in both maps and leave "which buttons apply" depending on the sender.

Two mechanics differ from the v1 types and are the parts worth remembering:

- **Atmesti gets no button**, on the same rule that keeps "Nepratęsti" off the extension push: a
  refusal blocks the worker's planning until they resubmit, so it belongs where the reason text and
  the requested times are on screen. Approve is the one-tap answer; refusal is a considered one.
- **The type guard cannot key on `type` here.** A `calendar_requests` doc's own `type` is the *kind
  of change* (`add`/`edit`/`delete`), not the notification type, so the intent is matched on the
  card's `source`. The runner table therefore holds a predicate per entry rather than a type string,
  which also lets one action id (`approve`) mean two different decisions — disambiguated by which
  feed the notification came from, never by what the payload claimed to be.

The execution path is unchanged and that is the point: the intent runs `handleApproveCalendarRequest`,
the very handler the card's Patvirtinti calls, which delegates to the shared `approveCalendarRequest`
writer the "Kalendoriaus istorija" tab also uses. The "someone else already decided" guard comes for
free — the listener keeps only `status === 'pending'`, so a resolved request has already left the feed
and the intent reports it as settled instead of writing.

## Follow-ups

1. ~~**Calendar approval buttons.**~~ Done — see the amendment above.
2. **Real-device QA once deployed.** The client chain is covered by unit tests and a live check of the
   cold-start URL capture; what no test can prove is a real Android notification rendering two buttons
   and a real iPhone ignoring them gracefully. Do this on the founder's own phone after the deploy.
3. **Revisit option B only if** the open-the-app step measurably slows the daily loop.
4. **Legacy `calendar_requests` docs** carrying only a `managerId` (no `managerIds` array) still get a
   push but no card, because the bell's listener queries the array — so a button on one of those
   reports "already resolved". Pre-existing and self-clearing (these resolve within a day), noted here
   only so it is not re-diagnosed as a button bug.
