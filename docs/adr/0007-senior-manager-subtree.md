# 0007 — Senior manager as a scoped subtree (four-level hierarchy)

- **Date:** 2026-06-23
- **Status:** Accepted
- **Deciders:** Founder + AI agent (claude-opus-4-8)
- **Supersedes:** the ADR 0005 follow-up that made `seniorManager` an *unscoped* (whole-company)
  manager with a distinct label.

## Context

[ADR 0005](./0005-scoped-manager-hierarchy.md) introduced a real, server-enforced confidentiality
boundary: a *scoped* manager sees and assigns only their assigned workers' private rows
(`tasks` / `archived_tasks` / `work_sessions` / `break_sessions` / `deleted_tasks`), via a
denormalized `teamManagerIds` array stamped onto each row and an `array-contains` query. A fourth
rank, `seniorManager` (**Vyr. vadovas**), was then added — but only as a *whole-company* viewer
with a distinct label (visibility-equal to an unscoped manager).

That left the actual four-level org chart unrepresentable. The founder needs a genuine chain of
command:

> **Administratorius → Vyr. vadovas → Vadovas → Vykdytojas**

i.e. a senior manager who oversees **a specific set of managers** (and, transitively, those
managers' workers) — **not** the whole company. And the admin needs to assign *which senior
oversees which managers* from the user-management screen. Neither existed: a senior saw everyone,
and the UI had no control to wire managers to a senior.

## Decisions

1. **A senior manager is a SCOPED overseer of their transitive subtree** — the managers assigned
   to them, plus those managers' workers. A senior is **never** whole-company; only admins and
   *unscoped* managers are. This reuses ADR 0005's machinery (per-row stamp + `array-contains`),
   so a senior queries identically to a scoped manager: `where('teamManagerIds', 'array-contains',
   myUid)`.

2. **Two editable membership fields, one per upward edge.** Admin-only, on the user doc:
   - `teamManagerIds` — a **worker's** managers (unchanged from ADR 0005).
   - `seniorManagerIds` — a **manager's** senior managers (new).

   Both express the same relation ("who is one level above me"), kept as separate fields because
   they are populated from different candidate pools and a manager's seniors must never be
   confused with a worker's managers.

3. **The per-row stamp becomes the owner's OVERSEER CLOSURE, not just their direct managers.** A
   worker's row must be visible to their managers **and** those managers' seniors. So the stamp
   (`teamManagerIds` on the row) is computed one hop up per level, non-recursively:
   - worker → their managers **∪** each of those managers' seniors;
   - manager → their seniors;
   - senior / admin → ∅ (their own rows are visible only to themselves + admins).

4. **The CREATE/assign rule reads a closure field on the user doc (`overseerIds`), not the row.**
   At create/reassign time the row isn't stamped yet, so the rule checks the *target user's*
   overseer closure. `overseerIds` is the same closure as (3), maintained on the user doc by the
   Cloud Function. **No client — not even an admin — may write `overseerIds`;** only the admin-SDK
   function does, so the boundary can't be silently desynced.

5. **A manager's senior-change cascades.** Changing a manager's `seniorManagerIds` (or anyone's
   `role`) re-stamps not just that user but **every worker under that manager**, because each such
   worker folds the manager's seniors into their own closure. Handled in the existing
   `restampTeamOnUserChange` trigger, which now watches `teamManagerIds`, `seniorManagerIds` and
   `role` (deliberately **not** `overseerIds`, which it writes — watching it would loop).

6. **Bidirectional assignment UI.** In `UserManagement`:
   - a **worker** row keeps its manager multi-select (with the primary star → `defaultManager`);
   - a **manager** row gains a senior-manager multi-select (→ `seniorManagerIds`) alongside its
     existing whole-company/scoped toggle;
   - a **senior** row shows the *inverse* convenience view — the managers assigned to it — and
     toggling there writes the **manager's** `seniorManagerIds` (the same edge, from the other
     side). Candidate pools are rank-correct: workers pick from `manager`s, managers pick from
     `seniorManager`s.

7. **Account management stays admin-only** (approve/block/delete/role/time edits), exactly as
   ADR 0005. A senior is a *visibility* rank, not an account administrator.

## Alternatives considered

- **Senior = whole company (the ADR 0005 follow-up).** Simplest — no denormalization — but cannot
  express "this senior oversees only these managers." Rejected: it is not a hierarchy, just a
  second admin-lite label.
- **Transitive `get()` chase in the rules** (row → owner doc → owner's managers → their seniors).
  Always-current, no denormalization, but pays **2–3 extra document reads per row evaluated** on
  the hot read path. Rejected for the same read-cost reason ADR 0005 rejected its option C.
- **Recursive closure for arbitrary depth.** Rejected as over-engineering: the org is fixed at
  four levels, so a non-recursive one-hop-per-level computation is sufficient and cannot loop.
- **Store only direct edges and union at query time on the client.** Can't — the security rules
  are the boundary, and they can only cheaply compare a single denormalized field. The closure
  must be materialized server-side.

## Consequences

- **Rollout mirrors ADR 0005** and must not ship the tightened reads before the closure exists:
  1. Membership fields + closure computation + per-row stamp (server-side) + **backfill**
     (`backfillTeamStamps` now also seeds `overseerIds` and the senior subtree).
  2. Client self-scopes: `isScopedOverseer = scopedManager || seniorManager` drives the
     `array-contains` query and the roster filter; `canSeeWholeTeam` **no longer includes**
     `seniorManager`.
  3. Tighten reads / indexes (the `array-contains` indexes from ADR 0005 already cover seniors —
     the query shape is unchanged).
- **Founder-run steps:** `firebase deploy --only firestore:rules`, `firebase deploy --only
  functions` (the new closure + cascade), and **running `backfillTeamStamps` once** so existing
  rows/users get `overseerIds` and the senior subtree stamp. Until the backfill runs, a senior
  sees nothing (fail-closed); the client roster filter falls back to the direct membership fields
  during that window.
- **Cascade cost:** changing a manager's seniors re-stamps that manager's whole crew's history.
  Membership changes are rare and crews small, so the bounded fan-out (one manager's workers ×
  their rows) is acceptable — same trade ADR 0005 accepted for a worker's own history.
- **`isScopedManager` keeps its precise meaning** (a scoped *manager*); the new `isScopedOverseer`
  carries the "confined to a subtree stamp" concept for both scoped managers and seniors, so the
  six client read-surfaces switch to it with a one-line import swap each.
- **Daily automation stays whole-team-only.** It is gated on `canSeeWholeTeam`, so a senior — now
  excluded — correctly never runs the team-wide promote/archive pass (their tighter rules would
  deny those writes anyway).

## Follow-ups

- Create the `array-contains` composite indexes if any senior-scoped query 400s (the shape equals
  ADR 0005's, so existing indexes should suffice).
- Consider a `defaultSeniorManager` (primary senior) if upward approval routing is ever needed;
  the field is already write-gated admin-only in the rules but is currently unused by the UI.
- Promote to a first-class `teams`/`departments` entity if the hierarchy grows past four levels.
