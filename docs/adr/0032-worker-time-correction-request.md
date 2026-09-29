# ADR 0032 — Worker time-correction request: five choices, a pre-filled fix, and a Taip / Ne answer

- **Date:** 2026-09-29
- **Status:** Accepted
- **Deciders:** founder (scope + three product choices, 2026-09-29), agent (design)

## Context

Workers make the same handful of timer mistakes: they forget to start, forget to stop, press pause
when they were still working, or the logged start/end is simply wrong. The only in-app route was the
per-row "Koreguoti savo laiką" pencil (ADR 0023), which handles exactly one of these: an existing
row's END. "I forgot to start" (there is no row to tap), "the break was work", and anything the
worker can only describe in words had no path at all — they became phone calls, and the fix was done
by hand in the admin editor, or not at all.

The founder asked for one place where a worker can report any of these from a phone, quickly,
without confusing the choices: a few options first, detail only when needed, and an answer the
manager can give with "yes" or "no" — ideally with the fix already worked out, including from the
worker's own words.

## Alternatives

1. **Extend the per-row pencil.** Cannot express "forgot to start" (no row to tap) and keeps the
   request tied to a row the worker must first find.
2. **A new `correction_requests` collection** (the `calendar_requests` model). A new collection means
   new rules, a rules deploy, and a second approval surface — for data that fits in the existing
   notification.
3. **The request IS the notification** (the `time_gap_claim` precedent, ADR 0025) — chosen.

For the manager's "Taip" (founder choice): apply immediately where the app already has a safe,
owner-checked write; carry "the break was work" as information only in this version (reclassifying a
break is a three-part privileged write with no in-app editor yet).

For the suggestion (founder choice): derive it from the day's own rows, and for free text ask the AI
to turn the worker's words into the SAME structured fix, which the worker confirms before sending.

## Decision

- **Entry point:** "Pranešti apie klaidą" in the worker's own day view (Veiklų eiga). It opens five
  choices: Pamiršau paleisti / Pamiršau sustabdyti / Neteisingas laikas / Pauzė buvo darbas / Kita.
- **Pre-fill:** each choice opens a short form already filled from the day — the latest untracked gap
  and the task worked right after it; the latest row for stop/time fixes; the latest break. A comment
  is an optional expander, required only for "Kita".
- **Who settles what** follows ADR 0023's incentive rule:
  - giving time back (forgot to stop; an earlier end on the same start) is applied **on the spot**
    through the existing one-way self-reduction, with the admin FYI;
  - adding time (forgot to start; a different start/end) becomes a **`time_correction_request`**
    notification to all of the worker's managers. Its fields are the machine-readable fix;
  - a break that was work, and unstructured free text, reach the manager as information.
- **Manager "Taip"** dispatches on the kind to an owner-checked admin write:
  `creditRequestedSession` (forgot to start — the task must be assigned to the requester, an interval
  overlapping recorded time is refused, and the row id is derived from worker + start so a double tap
  or two managers answering land on one row) or `applyRequestedSessionTimes` (a start/end change —
  the row is re-read and must belong to the requester, then replayed through `editWorkSession`).
  **"Ne"** writes nothing. Both answers reach the worker (`time_correction_settled`), except a
  start/end "Taip", which the existing `session_edited` notice already reports.
- **AI ("Kita"):** a new callable `suggestTimeCorrection` (same key and model as `parseTaskDraft`)
  returns one proposal. It writes nothing, and it can only point at rows and tasks the caller
  supplied; a proposal missing what its kind needs degrades to a plain comment
  (`functions/correctionSuggestion.js`, unit-tested). The worker sees "Ar teisingai supratome?" and
  answers Taip (send the fix) or Ne (send the comment alone). If the AI is unreachable, the comment
  still goes to the manager.

## Consequences

- **No rules change.** The request rides `request_notifications`, whose create rule already binds
  provenance to the caller and requires any `sessionRef` to name the caller's own row. The manager
  writes use the existing `work_sessions` manager branches.
- **Functions deploy needed (post-ship, human-run):** the new callable and the push copy for the two
  new types live in `functions/`. Until it is deployed, "Kita" falls back to sending the comment, and
  the pushes use the generic fallback copy; everything else works from the client alone.
- The per-row "Koreguoti savo laiką" pencil is unchanged and still works; the two overlap for
  end-time fixes.
- "Pauzė buvo darbas" is not yet one-tap for the manager.

## Follow-ups

- A manager/admin "break → work" write (the three-part reclassification), so that kind becomes
  one-tap as well.
- Consider folding the per-row pencil into this sheet (pre-selecting "Neteisingas laikas" on that
  row), so there is one correction surface instead of two.
- Optional push decision buttons (ADR 0024) for `time_correction_request`, once the in-app flow has
  been used in practice.
