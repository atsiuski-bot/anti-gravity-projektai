# 0005 — Scoped manager hierarchy (team-confidential oversight)

- **Date:** 2026-06-22
- **Status:** Accepted
- **Deciders:** Founder + AI agent (claude-opus-4-8)

## Context

WORKZ has a **flat** three-role model (`worker` / `manager` / `admin`, stored as a single
`role` string on `users/{uid}`). Almost every gate funnels through one predicate,
`isManagerRole(role) = role === 'manager' || role === 'admin'`, which collapses manager and
admin into a single "manager-or-above" tier. Consequently **every manager sees the entire
company** — all tasks, sessions, hours, reports and the live-activity panel.

The Firestore rules encode a deliberate **"READ broad, WRITE scoped"** asymmetry
(`firestore.rules:54-65`): every shared collection is `allow read: if isUserActive()` while
create/update/delete are owner-scoped with a blanket `isManagerOrAdmin()` escape. The reason
is mechanical: **Firestore rules are a per-document allow/deny decision, not a query filter** —
if a rule would deny even one document in a query's result set, the whole query fails. The
reporting/calendar layer issues collection-wide queries and filters client-side, so reads must
stay broad or those queries 400.

A latent half-edge already exists: a worker doc may carry `defaultManager` (a single
manager/admin uid), but it is used **only** to route approvals/notifications (it seeds a task's
`managerId`), never to scope visibility.

The founder needs **certain managers to see tasks/reports and assign tasks only for the people
assigned to them**, while other managers/admins keep full reach.

## Decisions

1. **Real confidentiality boundary, not cosmetic.** A scoped manager must not be able to read
   another crew's tasks/sessions/reports even via the SDK/devtools. This is enforced
   server-side in `firestore.rules`, not only hidden in the UI.
2. **Many-to-many membership.** A worker can answer to several managers. The edge is a new
   `teamManagerIds` array (of manager uids) on the user doc — named distinctly from the
   task-level `managerId` (the auditor) to avoid confusion. `defaultManager` stays as the
   single **primary** manager for approval/notification routing and must be a member of
   `teamManagerIds`.
3. **Admin stays global.** Only role `manager` is scoped; admins see/manage everyone. The
   scoping branches on a new predicate `canSeeWholeTeam` (admin = true) rather than mutating
   the high-blast-radius `isManagerRole`.
4. **Scoped manager = view + assign tasks + reports only.** Account management (approve
   pending sign-ups, block/unblock, change roles, edit logged time) stays admin-only.
5. **Full history.** A newly-assigned manager sees the worker's PAST rows too. Therefore the
   per-row team stamp must reflect the worker's **current** managers, kept live by a re-stamp
   Cloud Function that fires when a user's `teamManagerIds` changes.
6. **The shift calendar stays public to everyone.** Workers and managers keep seeing the whole
   company's planned shifts. So `work_hours`, `calendar_requests`, `calendar_notifications`
   and the `users` roster keep their broad READ. Confidentiality applies only to the
   "performance/work" collections.
7. **Private (scoped) collections:** `tasks`, `archived_tasks`, `work_sessions`,
   `break_sessions`, `deleted_tasks`. Each carries a denormalized `teamManagerIds` array
   (a copy of the owner's current team). Read rule:
   `isAdmin() || isOwner() || request.auth.uid in resource.data.teamManagerIds`. The scoped
   query is `where('teamManagerIds', 'array-contains', myUid)` — `array-contains` matches a
   single value, so there is **no 30-id `in`-query cap**.

## Alternatives considered

- **A. UI-only scoping (cosmetic).** Filter client-side, leave reads broad. Rejected: the
  founder requires a real boundary; this would be bypassable via the API.
- **B. Single denormalized `ownerManagerId` equality.** Cheapest reads but **1:1 only** —
  cannot express many-to-many. Rejected on the cardinality decision. (We keep its
  denormalization idea but as an **array** + `array-contains`.)
- **C. `teams` collection + per-row `get()` of the owner's user doc in the read rule.** Most
  flexible, no denormalization, always reflects current membership — but pays **one extra
  document read per row evaluated** on high-volume session reads (latency + billing).
  Rejected for read cost; the denormalized array + a re-stamp function gives the same
  live-membership semantics at a pure field-compare read cost.
- **Client-side stamping at the write sites.** Considered (immediate consistency, no
  per-create function cost) but **rejected**: creates are scattered across ~13 sites (TaskModal,
  WorkPlanner, taskActions, sessionActions, TaskTimerControls, TaskTable, DailyStatistics,
  TaskHistory, restores) and several util functions lack the owner's user doc, so threading the
  array through every site is fragile and easy to miss. Chosen instead: **server-side stamping
  via Cloud Functions triggers** — `onDocumentWritten` for `tasks`/`archived_tasks` (covers
  create + reassignment), `onDocumentCreated` for `work_sessions`/`break_sessions` (owner fixed
  at creation), each reading the owner's current `teamManagerIds` and writing it onto the row
  (idempotent guard: skip if already equal, so no trigger loop). One authoritative place,
  impossible to miss a site. Cost: a brief (~1 s) delay before a manager sees a brand-new row
  (the owner sees it instantly via the owner predicate) and one extra write per create —
  negligible for a field crew. Failure mode stays **fail-closed**: an unstamped row is hidden
  from managers, never leaked.

## Consequences

- **Cannot ship in one shot.** Tightening the read rules before the queries are rewritten
  would break every whole-collection listener. Mandatory rollout order:
  1. **Membership + stamping + migration** — add `teamManagerIds` to users + new private rows;
     backfill existing rows. *(Reads still broad — nothing breaks.)*
  2. **Self-scope the queries** — every private screen constrains itself
     (`array-contains` for scoped managers, owner for workers, broad for admins). *(Rules
     still broad — still works.)*
  3. **Tighten the read rules + add indexes.** Only now is the boundary real.
- **Founder-run steps:** the `firestore.rules` deploy (the permission classifier blocks the
  prod rules deploy) and **`firestore.indexes.json`** creation (composite indexes for
  `array-contains` + `orderBy`/date — the repo deliberately had none until now). The re-stamp
  Cloud Function deploy is also founder-run (`firebase deploy --only functions`).
- **Denormalization is a maintenance burden:** reassignment must re-stamp the worker's history
  (handled by the function); a bug there silently hides or (worse) leaks rows — covered by
  tests + the fail-closed read default.
- **`isManagerRole` keeps its meaning** (manager+admin = manager-shaped UI). A new
  `canSeeWholeTeam` predicate carries the visibility split, so the change stays low-blast.
- Orphans (no manager) and pre-team legacy rows are visible to **admins only** until assigned;
  the migration stamps existing rows from each owner's current team.

## Follow-ups

- Build membership UI (multi-manager) in `UserManagement` (admin-only).
- Re-stamp Cloud Function on `users/{uid}.teamManagerIds` change (europe-west1, admin SDK).
- Decide later whether to promote to a first-class `teams` entity if departments/sites emerge.
- Optional safety-net onCreate trigger if a missed client write-site is ever observed.
