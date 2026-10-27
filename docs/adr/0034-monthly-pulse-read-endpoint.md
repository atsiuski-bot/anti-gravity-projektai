# ADR 0034 — The monthly workshop pulse is served by WORKZ, not read with the owner's login

- **Date:** 2026-10-27
- **Status:** Accepted. **NO rules change. Functions deploy + one new secret needed post-ship**
  (new HTTPS function `monthlyPulse`, secret `PULSE_READ_TOKEN`).
- **Deciders:** founder (option choice, 2026-10-27), Audrius (project owner, consent 2026-10-27,
  relayed by the founder), agent (design)

## Context

The founder's monthly "Dirbtuvių pulsas" report for the workshop lead is collected by a private
script outside this repository. It drove `firebase mcp` over the **Firebase CLI login of the
project owner account** on the founder's PC and pulled raw `work_sessions`, `break_sessions`,
`tasks` and `archived_tasks` rows for seven people, then did the arithmetic locally. That login can
read, change and delete everything in `darbo-planavimas` and deploy rules and functions — far more
than a monthly read needs — and an unattended scheduled job was holding it. The Octopus ecosystem
plan (§6.6) requires moving the collector off the founder's PC credentials before any cloud agent
inherits them.

## Alternatives

1. **A dedicated read-only service account** (`roles/datastore.viewer`). IAM cannot scope Firestore
   reads to collections, so it reads the whole database; it needs a key file (the class of file
   being removed from the founder's PC) or keyless impersonation that a cloud agent cannot use
   without a key.
2. **A rules-scoped "reporter" Firebase Auth user.** Can be narrowed to the four collections, but
   needs a new role in `firestore.rules` (security review + rules deploy), a stored password, and
   still hands raw rows (descriptions, notes, edit reasons) to the reader.
3. **A scheduled function that precomputes and stores a summary document**, read through an
   endpoint. Two moving parts plus a Firestore write, and the report's "refresh the same month"
   and "pick a month" modes would need a second path.
4. **Keep the owner login with an expiry date.** Defers the exposure instead of removing it. Kept
   only as the bridge until this ADR is live (founder's report command records it, expiry
   2027-01-31).
5. **An on-demand, read-only HTTPS function (chosen).**

## Decision

- `monthlyPulse` (2nd gen, europe-west1) answers `POST { month: 'YYYY-MM', userIds: [...] }` with
  the computed aggregate only — per person and month: hours by session type, work days, average /
  median / longest day, median start hour, manual time, >12 h days, breaks; task throughput,
  estimate accuracy, the two worst overruns and up to five stale open tasks (titles truncated to
  40–45 characters); and completed-task counts per creator id. **It writes nothing.**
- **The caller's identity is a bearer token**, `PULSE_READ_TOKEN` in Secret Manager, checked
  timing-safe before anything else; a missing or short configured token refuses every caller.
  The function is the only HTTPS surface that no Firebase Auth user calls.
- **The team list stays with the reader.** The request names the uids; the response covers only
  those, keyed by uid. Names, uids and the creator-name map never enter this public repository.
  At most 25 uids per call.
- **Parity first.** `functions/monthlyPulse.js` is a faithful port of the old collector's rules
  (window, classification, thresholds, fixed-offset Vilnius hour); a randomized side-by-side run
  against the old logic matched on 100 cases before review. The first live month is compared with
  the old path before the old path is switched off. Rule improvements (e.g. a true Europe/Vilnius
  conversion for the median start hour) come after that, as their own change.
- Reads are the same per-person indexed queries the collector ran (userId/assignedUserId equality
  plus a date or `archivedAt` range), so no index change is needed.

## Consequences

- WORKZ gains its first **external read surface**. Whoever holds the token can pull the summary for
  any uid they already know, for any month — named people's work-time figures, so a leak is small
  but not zero. It cannot read anything else, write, or reach any other collection.
- **Rotation:** set a new secret version and redeploy `monthlyPulse`; the old token stops working
  with the new revision. The reader-side copy is replaced at the same time.
- Cost: a handful of indexed reads per call, once or twice a month — cents.
- If the organisation's policy forbids public invokers, the deploy reports that it could not make
  the function publicly invokable; the token check alone is the access control, so the invoker
  must be allowed for this one function or the design revisited.
- If WORKZ later moves off Firebase, the pure module moves with it; only the I/O in `index.js` is
  Firebase-specific.

## Follow-ups

1. Post-merge, from an up-to-date `main`: create the secret
   (`firebase functions:secrets:set PULSE_READ_TOKEN --project darbo-planavimas`) and deploy only
   this function (`firebase deploy --only functions:monthlyPulse --project darbo-planavimas`);
   re-verify live via the Firebase MCP (`functions_list_functions`), not the deploy log.
2. Founder side: point the report's collector at the endpoint, compare one month with the old path,
   then retire the owner-login path.
3. Optional later: a true time-zone conversion for the median start hour (changes reported numbers,
   so announce it in the report's method notes).
