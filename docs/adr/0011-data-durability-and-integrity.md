# 0011 — Data durability & integrity safety net

- **Date:** 2026-06-23
- **Status:** Accepted
- **Deciders:** Founder + AI agent (claude-opus-4-8)

## Context

Logged work time (`work_sessions`, `break_sessions`) and planned hours (`work_hours`) are the
product's most valuable, least reconstructible data. Yet the project had **no recovery story**. A
live inspection of the Firestore database on 2026-06-23 confirmed:

- `pointInTimeRecoveryEnablement: DISABLED` — only the default 1-hour version retention, i.e. no
  usable rewind.
- `deleteProtectionState: DISABLED` — the whole database could be dropped with one command.
- No scheduled backup / export configured anywhere (no code, no schedule).

The only "recovery" that existed was task-level archive (`archived_tasks` / `deleted_tasks`), which
is product behaviour, not a backup. This is not hypothetical: a prior bug wrote **247 corrupt
`break_sessions` (>960-min durations)** that had to be deleted by a one-off service-account script,
because nothing stopped the bad values at the door and nothing flagged them afterwards.

The founder's stated risk: *"a buggy AI agent or a bug could destroy the work-hours data and there
must be a way to restore it."* That risk has three distinct shapes — **prevention** (stop corruption
entering), **detection** (notice loss/corruption quickly), and **recovery** (get the data back) —
and no single mechanism covers all three.

## Decisions

Adopt a **four-layer** safety net, each layer addressing a different shape of the risk. The most
important insight: the strongest protection here is **not code we write** but two managed Firestore
features that were simply switched off.

1. **Recovery — Point-in-Time Recovery + database delete protection** (managed, founder-run). PITR
   gives a continuous 7-day rewind; delete protection blocks accidental whole-database deletion. This
   is the primary answer to "an agent/bug wiped the data". Zero code; one `gcloud` command each.

2. **Recovery (durable/long) — native scheduled backups** (managed, founder-run). Daily (7-day
   retention) + weekly (14-week retention) snapshots that live *outside* the database and survive its
   deletion. Restored into a new database, then cut over.

3. **Prevention — Firestore rules shape/range validation** (in-repo, this change). Authorization
   rules already answer *who* may write; these add *what* a write may contain. `durationMinutes` on
   the two session collections must be a finite number in `[0, 1440]` (24h sanity ceiling — the
   client already clamps to 16h, so a legitimate write can never trip it); `work_hours.start/end`
   must be strings. Deliberately **permissive**: a field is validated only when *present* (create) or
   *changed* (update), so partial updates (rename, soft-delete) and the remediation of an
   already-corrupt row are never blocked. Admin-SDK Cloud Functions bypass rules, so the team-stamp
   writes are unaffected.

4. **Detection — `dailyIntegrityScan` Cloud Function** (in-repo, this change). A scheduled daily
   pass writing one report to `integrity_reports/{YYYY-MM-DD}` (manager/admin-readable;
   client-immutable). Two checks: a **volume canary** (counts each monitored collection and flags a
   >30% day-over-day drop as `critical` — the signal of a mass delete/wipe, since normal activity only
   adds rows) and an **anomaly scan** over sessions created in the last 2 days (out-of-range/non-numeric
   duration, end-before-start, missing owner).

## Alternatives considered

- **A custom JSON-export Cloud Function** (scheduled read of the critical collections → JSON in
  Storage). Rejected: native scheduled backups + PITR do the same job more reliably, atomically, and
  with nothing to maintain. Re-implementing it would add read cost and a bespoke restore path.
- **Strict rules validation (require the full field set, validate on every update).** Rejected: it
  would break the legitimate partial updates (title rename, soft-delete write only a few fields) and,
  worse, lock out remediation — an update touching a *merged* doc that still holds a legacy
  out-of-range value would be denied, so you couldn't even soft-delete a corrupt row from the app.
  The present-or-changed form avoids both.
- **Capping duration at the client's exact clamp (960).** Rejected in favour of a higher physical
  ceiling (1440) so the rule can never fight a future clamp re-tune; the scan still *flags* anything
  over 960 as suspect, so the suspicious band is observed even though only the absurd band is blocked.
- **Alerting via push/email from the scan.** Deferred: the report doc + `logger.error` are enough to
  start; wiring an admin alert channel is a follow-up.

## Consequences

- **Founder-run activation** (an agent cannot; see
  [`docs/runbooks/firestore-backup-recovery.md`](../runbooks/firestore-backup-recovery.md)):
  1. `gcloud firestore databases update --enable-pitr` + `--delete-protection`.
  2. `gcloud firestore backups schedules create` (daily + weekly).
  3. `firebase deploy --only firestore:rules --project darbo-planavimas` (layer 3).
  4. `firebase deploy --only functions --project darbo-planavimas` (layer 4 — the **first**
     scheduled-function deploy auto-enables the Cloud Scheduler API and creates the job).
- **No client change and nothing auto-deploys.** All four layers are backend/ops; the Cloudflare
  push→main client deploy is irrelevant here. Until the deploys run, the app behaves exactly as
  before (the new rules/function are simply absent).
- **Recovery has a known caveat** (documented in the runbook): Firestore *import* re-creates deleted
  docs and overwrites changed ones but does **not** delete extra rows — so added-garbage corruption
  needs targeted deletes, not just a re-import.
- **Cost** is negligible at this scale (PITR version history + backup storage + one tiny daily
  function), but non-zero — set a budget alert if desired.
- The rules guard is **defence in depth, not a replacement** for the read-side outlier clamp already
  in the client; both now cover the >960-min class from opposite ends (write-block the absurd,
  display-clamp + scan-flag the suspect).

## Follow-ups

- Surface `integrity_reports` in an admin UI (a small panel under the existing manager tooling) so a
  `critical`/`warning` report is seen without reading Firestore directly.
- Wire a real alert (push to admins / email) when a report is `critical`.
- Once PITR + backups are confirmed live, record the activation date here and in the decisions log.
- Consider extending the anomaly scan to `work_hours` (it has no `createdAt`; either add one on write
  or accept a periodic full scan).
