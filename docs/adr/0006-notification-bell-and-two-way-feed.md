# 0006 — Notification bell, top bar, and a two-way notification feed

- **Date:** 2026-06-23
- **Status:** Accepted
- **Supersedes / extends:** [ADR 0004](./0004-notification-infrastructure.md) (keeps its
  Cloud-Functions + toast + unread-count stack; changes only where the count is surfaced and who
  receives notifications).

## Context

[ADR 0004](./0004-notification-infrastructure.md) built the notification *plumbing* (a global
`NotificationsProvider` unread count, an OS app-icon badge, a foreground toast, FCM background
push). But the in-app *surface* had three problems:

1. **The unread count had no visible home.** It drove only the OS app-icon badge (which most
   users never notice, and which iOS web does not show without install). There was no in-app bell.
2. **The feed was manager-only and pinned to one page.** `ManagerNotifications` rendered an inline
   stack of action cards at the top of `ManagerView`, mixing *action-required* items (approve a
   task, decide a time-extension, approve a calendar change) with *informational* ones (a comment,
   a calendar-change notice). Workers received essentially nothing in-app — every manager decision
   that affected their work (task approved, task confirmed, task sent back for rework, time
   extension granted/denied) was silent; only a separate `CalendarRequestStatusBanner` told them
   about calendar decisions.
3. **The notification surface conflated a to-do queue with a feed.**

## Decision

**A persistent top bar (`AppHeader`) carrying the active-session pill + a notification bell with the
unread count + the profile avatar, opening a single HYBRID, TWO-WAY feed.**

1. **Top bar.** A calm `surface-card` header, sticky, shown on every viewport. Left: the active
   session as a pill (running task → label pill; quick work / call / break → the live-timer
   `ActiveSessionReadout`), which **replaces** the old full-width session strip and the floating
   avatar bubble. Right: the bell (+ unread badge) and the avatar. **No brand/role** in the bar —
   those stay in the desktop `SideRail`; on mobile the brand was never shown. The session *controls*
   stay at the bottom (mobile) / in the rail (desktop) — only the *indicator* moved up.

2. **Hybrid feed in the bell.** One `Modal` panel renders the merged feed in two tiers:
   *action* items (a manager's pending approvals/completions/time-extensions, a worker's returned
   task, and calendar-approval requests) as cards with decision buttons; *info* items (comments,
   and a worker's assigned/approved/confirmed/extension/calendar-decision notices) as compact
   read/unread rows. "Mark all read" clears **only** info items — action items stay until the
   underlying work is resolved.

3. **Two-way over the SAME collection.** The `request_notifications` rule was already
   recipient-keyed (`recipientId == uid`), so workers could always read notifications addressed to
   them — nothing was written to them. We add the manager→worker writes through one funnel
   (`src/utils/notify.js`), which stamps the rule's invariants (string `recipientId`, unread,
   provenance) and tags each type with a `category` from one map (`categoryOf`, derived at render
   so legacy docs need no backfill). `NotificationsContext` drops its manager-only gate so workers
   count + toast their own unread too.

4. **Routing follows the event, not the role.** Task-bound events (approval, completion,
   time-extension, the matching comment) go to the **single assigned manager**
   (`taskAuditor`/`routedManagerId`). Person-level events (calendar/shift) **fan out to ALL of the
   worker's managers** via a `managerIds` array on `calendar_requests`, queried with
   `array-contains` (any may act; the first to act flips the status and clears the card for the
   rest). Manager→worker decisions go to that one worker. `CalendarRequestStatusBanner` is removed —
   its result folds into the worker's bell as a `calendar_decision` info notice.

## Alternatives considered

- **Keep the inline `ManagerView` feed, just add a bell that scrolls to it.** Rejected — leaves it
  manager-only and page-bound.
- **A brand-new `notifications` collection.** Rejected for now — the existing
  `request_notifications` rule is already recipient-generic and two-way-safe; reusing it avoids a
  risky migration of a security-sensitive, push-triggering collection (and re-pointing the Cloud
  Function + rules) for no functional gain.
- **Store `category` on each doc as the source of truth.** Rejected — deriving it from `type`
  (`categoryOf`) means the five legacy write-sites need no change and old docs render correctly.
- **Fan calendar approvals out with a `managerIds array-contains + status == pending` composite
  query.** Rejected — that needs a manually-created composite index (a founder-run deploy that would
  break the manager calendar view until live). We query `array-contains` only and filter `pending`
  in memory (single-field index is automatic). Trade-off: reads resolved rows too (fine at this
  team size) and legacy pending docs without `managerIds` won't appear until re-submitted.

## Consequences

- The unread count finally has a visible in-app home; workers stop being blind to manager decisions
  (the manager↔worker loop is symmetric).
- `ManagerNotifications.jsx` becomes the two-way feed body (manager-only calendar listeners gated by
  role; `request_notifications` listener already serves everyone) mounted inside the bell, not
  inline. `onEditAndApprove` is replaced by a global `open-task-modal` CustomEvent carrying the task,
  so the bell can open the task editor from any page.
- The signature whole-screen session colour is untouched: the header is calm and sits above the
  colour; the session pill still pairs colour with a label+icon (DESIGN_SYSTEM §4-A / WCAG 1.4.1).

## Follow-ups (human-run)

- **No rules/index deploy is required** for the in-app feed (`array-contains` uses the automatic
  single-field index; the `request_notifications` rule is unchanged). The `category` field carries
  no rule constraint.
- **`functions` deploy** (founder-run) to pick up the new FCM copy (manager→worker types) and the
  calendar-request push fan-out to `managerIds`. Background push for the new types is otherwise
  inert until deployed; the foreground/in-app path works immediately.
- Optional: backfill `managerIds` onto any in-flight pending `calendar_requests` so they survive the
  cutover; and, if calendar volume grows, add the composite index and restore the server-side
  `status == pending` filter.
