# Phase 06 - Firebase Rules And Coupling

**Status:** PARTIAL  
**Findings:** P0 0 / P1 0 / P2 1 / P3 1

## Method

Static-read local `firestore.rules`, `storage.rules`, and `firestore.indexes.json`. Live Firebase rule state was not fetched or diffed.

## Findings

### P2

- `docs/audits/FULL_SWEEP_PLAN.md` - The sweep plan is stale: it says there is no test runner, no `firestore.indexes.json`, and no Cloud Functions. Current repo reality has all three. This makes future audits misclassify real gates and skip active backend code unless the plan is updated.

### P3

- Live deployed Firestore/Storage rules were not verified from the Firebase project. Local rules are materially stronger than older documentation describes, but deploy drift remains unverifiable from this read-only local audit.

## Positive Findings

- `firestore.rules:155-168` bounds `durationMinutes`.
- `firestore.rules:266-314` scopes `work_sessions` and `break_sessions` and pins owner fields on update.
- `firestore.rules:380-384` now covers the legacy `sessions` collection.
- `firestore.indexes.json` exists and includes scoped manager indexes for tasks, archived tasks, work sessions, and break sessions.
