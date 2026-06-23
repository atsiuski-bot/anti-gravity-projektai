# Runbook — Firestore backup, point-in-time recovery & disaster restore

> **Why this exists.** Logged work time is the product's most valuable data, yet the Firestore
> database currently has **no safety net**: as of 2026-06-23 the live database reports
> `pointInTimeRecoveryEnablement: DISABLED`, `deleteProtectionState: DISABLED`, and there is **no
> scheduled backup**. If a buggy migration, a runaway AI agent, or an operator mistake deletes or
> overwrites `work_sessions` / `break_sessions` / `work_hours`, there is today no clean way to get
> it back. The matching in-repo guards (rules shape validation + the `dailyIntegrityScan` Cloud
> Function) reduce the chance of corruption and *detect* loss — but **recovery** depends on the two
> managed features this runbook turns on. See [ADR 0011](../adr/0011-data-durability-and-integrity.md).

**These are human-run, one-time GCP operations.** Per the agent operating model, an AI agent cannot
perform them (the permission classifier blocks prod GCP changes), and only the owner account has
access. Run them yourself in a terminal.

- **Project:** `darbo-planavimas`
- **Database:** `(default)` — Firestore Native, location **`eur3`** (Europe multi-region)
- **Account:** `audrius@medievalclub.org` (`firebase login` / `gcloud auth login` as this account)
- **Prereq:** the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install) (`gcloud`). Billing
  (Blaze) is already enabled, which these features require.

```bash
gcloud auth login            # use audrius@medievalclub.org
gcloud config set project darbo-planavimas
```

---

## Layer 1 — Point-in-Time Recovery (the 7-day rewind) + delete protection

PITR keeps a continuous version history so you can read or export the database **as it was at any
minute within the last 7 days**. This is the primary answer to "an agent/bug wiped the data": you
rewind to a timestamp just before the damage. Delete protection stops the whole database from being
dropped by an accidental command.

```bash
# Enable PITR (7-day continuous version retention)
gcloud firestore databases update --database="(default)" --enable-pitr

# Enable database delete protection
gcloud firestore databases update --database="(default)" --delete-protection
```

**Verify:**

```bash
gcloud firestore databases describe --database="(default)" \
  --format="value(pointInTimeRecoveryEnablement,deleteProtectionState,versionRetentionPeriod)"
# expect: POINT_IN_TIME_RECOVERY_ENABLED   DELETE_PROTECTION_ENABLED   604800s
```

> Cost: PITR bills for the extra stored version history, proportional to write volume. At this app's
> scale it is a few cents/month. There is no way to recover data written *before* PITR was enabled,
> so turning it on is the start of the protection window — do it first.

---

## Layer 2 — Scheduled backups (durable, off-database, longer retention)

PITR only reaches back 7 days and lives *inside* the database. Scheduled backups are independent
snapshots that survive even a database deletion and retain far longer. Create both a daily and a
weekly schedule.

```bash
# Daily backups, retained 7 days
gcloud firestore backups schedules create \
  --database="(default)" \
  --recurrence=daily \
  --retention=7d

# Weekly backups (Sunday), retained 14 weeks (the maximum)
gcloud firestore backups schedules create \
  --database="(default)" \
  --recurrence=weekly \
  --retention=14w \
  --day-of-week=SUN
```

**Verify:**

```bash
gcloud firestore backups schedules list --database="(default)"
gcloud firestore backups list --location=eur3     # populates after the first scheduled run
```

> Cost: storage per retained backup; negligible at this scale.

---

## Recovery procedures

Pick the procedure by failure mode. **In all cases: stop the bleeding first** — if a rogue agent or
job is actively writing, disable it (revert/disable the Cloud Function or job, or temporarily lock
the offending collection in `firestore.rules`) before restoring, or it will re-corrupt the recovered
data.

### A. Surgical: an agent/bug corrupted or deleted rows in the last 7 days (PITR)

Export the affected collections *as they were* at a clean past minute, then import them back. The
timestamp must be a whole minute within the PITR window (last 7 days).

```bash
# 1) Export the pre-damage version of just the affected collections to a GCS bucket
gcloud firestore export gs://darbo-planavimas-recovery \
  --collection-ids=work_sessions,break_sessions,work_hours \
  --snapshot-time=2026-06-23T07:00:00Z

# 2) Import it back into the live database
gcloud firestore import gs://darbo-planavimas-recovery/<EXPORT_FOLDER> \
  --collection-ids=work_sessions,break_sessions,work_hours
```

> **Know what import does — this is the important caveat.** Firestore import is a *merge by document
> id*: it **re-creates deleted docs and overwrites changed ones**, but it does **not delete** docs
> that exist now yet were absent at the snapshot. So:
> - Damage = *rows deleted* or *fields overwritten* → import fully repairs it. ✅
> - Damage = *garbage rows added* (e.g. the >960-min corruption) → import will **not** remove the
>   extra rows; delete those by id (the `dailyIntegrityScan` report and the read-side clamp identify
>   them). 
>
> If you need the bucket first: `gcloud storage buckets create gs://darbo-planavimas-recovery
> --location=eur3`.

### B. Disaster: the whole database is gone/unusable (scheduled backup)

Restoring a backup creates a **new** database (you cannot restore in place over `(default)`), so
restore into a recovery database, verify it, then cut over.

```bash
# 1) Find the backup to restore from
gcloud firestore backups list --location=eur3

# 2) Restore it into a NEW database
gcloud firestore databases restore \
  --source-backup=projects/darbo-planavimas/locations/eur3/backups/<BACKUP_ID> \
  --destination-database=recovered-db

# 3) Inspect recovered-db, then either re-point the app at it (Firebase config) or
#    export from it and import into a freshly created (default).
```

---

## After any recovery

1. Re-enable whatever you disabled to stop the bleeding (function/job/rule).
2. Confirm `dailyIntegrityScan`'s next report (`integrity_reports/{date}`) is `severity: ok` and the
   collection counts look right.
3. Note the incident in [`docs/decisions-log.md`](../decisions-log.md) (date, cause, what was
   restored, snapshot time used).

## Related in-repo guards (already merged — deploy is founder-run)

- **Rules shape/range validation** (`firestore.rules`): rejects impossible `durationMinutes`
  (non-number / negative / > 24h) on `work_sessions` & `break_sessions` and malformed `start`/`end`
  on `work_hours`. Deploy: `firebase deploy --only firestore:rules --project darbo-planavimas`.
- **`dailyIntegrityScan` Cloud Function**: daily volume-drop canary + value-anomaly scan →
  `integrity_reports/{date}`. Deploy: `firebase deploy --only functions --project darbo-planavimas`
  (the **first** deploy of a scheduled function auto-enables the Cloud Scheduler API and creates the
  job; confirm with `gcloud scheduler jobs list --location=europe-west1`).
