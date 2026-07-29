/**
 * Pure, dependency-free detection logic for two CREDIT-INTEGRITY checks the dailyIntegrityScan runs
 * (audit R-04 / ADR 0021 compensating-control tightening). Like decisionLog.js, the classification
 * lives here as pure functions so the standalone `node functions/integrityScans.test.cjs` can assert
 * them with no Firestore and no emulator; index.js does the I/O and delegates the decision. Both
 * checks are REPORT-ONLY — they never mutate data, only surface samples into integrity_reports.
 *
 * WHY these exist. A worker authors their own `work_sessions` rows, so a hostile/buggy client can
 * mint valid-shaped credited time (R-04). The existing scans have two blind spots this closes:
 *   • ORPHAN — the per-row anomaly scan only rejects MALFORMED rows; a well-formed row that claims
 *     to be task work but references NO real task (fabricated credit with no run behind it) passes.
 *     Genuine system sessions (call / quick-work / interrupted-partial) carry a SYNTHETIC taskId by
 *     design and are flagged, so they are excluded — only rows that SHOULD point at a real task are
 *     checked.
 *   • SUSPICIOUS WORK DAY — the additive-overdraft scan only flags a work+break day total above 24h
 *     (physically impossible). A worker who really did 8h can still mint up to ~16h of extra valid
 *     rows and stay under that wire. Summing WORK-only minutes per worker per day and flagging the
 *     (16h, 24h] band catches that moderate pay-inflation the 24h wire misses, disjoint from it.
 *
 * The 16h ceiling MIRRORS src/utils/timeUtils MAX_SESSION_MINUTES (the client's single-continuous-
 * session clamp): no one human plausibly credits more than that much ACTUAL WORK in one calendar day
 * — long 25-70h jobs accrue over many days via paused sessions, never 16h+ in a single day. Both
 * checks are report-only, so a rare genuine long/night-shift day is a harmless manager review nudge,
 * not a block.
 */

// Work-only per-day total above this (minutes) is implausible for one human = the moderate-inflation
// signal. Mirror of the 16h single-session clamp; see module header.
const SUSPICIOUS_DAY_WORK_MINUTES = 16 * 60; // 960
// Upper bound of the suspicious band. A total above 24h is physically impossible and already owned by
// the combined work+break overdraft scan — kept disjoint so a day is never double-reported.
const IMPOSSIBLE_DAY_MINUTES = 24 * 60; // 1440
// Synthetic taskId shapes minted by the system-session writers (call_<ts>, quick_<ts>,
// <type>_partial_<ts>). A real task is a Firestore auto-id / audited deterministic id and never
// matches. Belt-and-suspenders behind the provenance flags, in case a legacy row lacks a flag.
// `manual_` is included because a manager correcting someone's hours (SessionEditModal →
// createWorkSession) mints `manual_<ts>` and no matching tasks doc ever exists — so without this the
// orphan scan reported every LEGITIMATE correction as fabricated credit for LOOKBACK_DAYS, flipping
// the daily report to 'warning'. That is the alarm fatigue the three-collection lookup exists to
// avoid: admins learn to ignore the orphan count, and a genuinely fabricated row hides in the noise.
const SYNTHETIC_TASK_ID = /^(?:call_|quick_|manual_)|_partial_/;
const DEFAULT_SAMPLE_LIMIT = 20;

/**
 * True when a work_sessions row is expected to reference a REAL `tasks` doc — so a missing task means
 * the credited row is orphaned. False for genuine system sessions (call / quick-work / interrupted
 * partial), whose taskId is synthetic by design, and for rows that claim no task at all.
 */
function isReferentialTaskSession(row) {
    if (!row) return false;
    // NOTE: isManualSession is deliberately NOT excluded here. A manager correction pinned to a REAL
    // taskId must stay orphan-checked — that is the R-04 fraud control, and the test below locks it.
    // Only the SYNTHETIC-id shape (`manual_<ts>`, handled above) is exempt, because no task exists
    // for it by construction.
    if (row.isSystemTask || row.isQuickWork || row.isPartial) return false;
    const taskId = row.taskId;
    if (!taskId || typeof taskId !== 'string') return false;
    if (SYNTHETIC_TASK_ID.test(taskId)) return false;
    return true;
}

/**
 * The distinct real taskIds that must be verified to exist, drawn from the referential rows only.
 * @param {Array<Object>} rows - work_sessions docs as { id, ...data }.
 * @returns {string[]}
 */
function collectReferentialTaskIds(rows) {
    const ids = new Set();
    for (const row of rows) {
        if (isReferentialTaskSession(row)) ids.add(row.taskId);
    }
    return [...ids];
}

/**
 * Orphan classification. A referential row whose taskId is NOT in `existingTaskIds` is credited work
 * with no task behind it.
 * @param {Array<Object>} rows - work_sessions docs as { id, ...data }.
 * @param {Set<string>} existingTaskIds - task ids confirmed present in `tasks`.
 * @param {number} [sampleLimit]
 * @returns {{ orphans: number, samples: Array<Object> }}
 */
function findOrphanSessions(rows, existingTaskIds, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
    let orphans = 0;
    const samples = [];
    for (const row of rows) {
        if (!isReferentialTaskSession(row)) continue;
        if (existingTaskIds.has(row.taskId)) continue;
        orphans += 1;
        if (samples.length < sampleLimit) {
            samples.push({
                id: row.id,
                taskId: row.taskId,
                userId: row.userId || null,
                durationMinutes: typeof row.durationMinutes === 'number' ? row.durationMinutes : null,
                createdByAdmin: row.createdByAdmin || null,
            });
        }
    }
    return { orphans, samples };
}

/**
 * Suspicious-work-day classification. Sums WORK-only credited minutes per user per day and flags
 * totals in (SUSPICIOUS_DAY_WORK_MINUTES, IMPOSSIBLE_DAY_MINUTES] — implausible for one human but
 * under the 24h physical-impossibility the combined scan owns.
 * @param {Array<Object>} rows - work_sessions docs (durationMinutes + startTime/createdAt + userId).
 * @param {(iso: string) => (string|null)} dayOf - maps a timestamp to its 'YYYY-MM-DD' day (injected
 *   so this module stays free of Intl / timezone deps); returns null for an unparseable value.
 * @param {number} [sampleLimit]
 * @returns {{ checked: number, count: number, samples: Array<Object> }}
 */
function classifySuspiciousWorkDays(rows, dayOf, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
    const totals = new Map(); // `${userId}|${date}` -> { userId, date, minutes }
    for (const row of rows) {
        const dur = row.durationMinutes;
        if (typeof dur !== 'number' || Number.isNaN(dur) || dur <= 0 || !row.userId) continue;
        const anchor = row.startTime || row.createdAt;
        if (!anchor) continue;
        const date = dayOf(anchor);
        if (!date) continue;
        const key = `${row.userId}|${date}`;
        const entry = totals.get(key) || { userId: row.userId, date, minutes: 0 };
        entry.minutes += dur;
        totals.set(key, entry);
    }
    const offenders = [...totals.values()]
        .filter((e) => e.minutes > SUSPICIOUS_DAY_WORK_MINUTES && e.minutes <= IMPOSSIBLE_DAY_MINUTES)
        .sort((a, b) => b.minutes - a.minutes);
    return { checked: totals.size, count: offenders.length, samples: offenders.slice(0, sampleLimit) };
}

// Slack on the server-span check below. Honest timer work always fits inside the span with room to
// spare, so this only has to absorb bookkeeping noise (a row written under a deterministic id before
// the final duration lands, rounding, a task created moments before the run). Generous on purpose:
// this is a report-only check whose real enemy is alarm fatigue, not a missed minute.
const SERVER_SPAN_GRACE_MINUTES = 30;

/**
 * SERVER-SPAN classification — the one credit check that does not take the client's word for
 * anything.
 *
 * Every other guard in this system reasons about instants the PHONE asserted, so a device whose
 * clock lies can shift them all together. This one compares the claimed duration against two
 * timestamps Firestore assigned itself, which no client can influence: when the TASK document was
 * created, and when the SESSION row was last written. A timer cannot credit more work than the
 * server has seen the task exist — so a row claiming 9h against a task the server first saw 20
 * minutes ago is impossible, whatever its start and end strings say.
 *
 * This is the detection-shaped form of "bound the duration by server-elapsed time". The door-level
 * form is unbuildable today: it needs a server-anchored START, and an offline start's server
 * timestamp resolves only on arrival, so it would compute a span SHORTER than the real work and
 * reject honest pay (see firestore.rules endTimeNotInServerFuture, ADR 0021). Measured after the
 * fact instead, that failure mode costs a line in a report rather than a worker's wages — which is
 * exactly why the bound can be stated here and not there.
 *
 * Deliberately blind to two things, and both are correct:
 *   • HAND-AUTHORED intents (backdate, recovered gap, manager correction) describe work that
 *     happened before the row existed, so the span says nothing about them — excluded, not judged.
 *   • A session on an OLD task. The span is then days wide and swallows anything, so this cannot see
 *     inflation on a long-running task. What it does see is inflation on a task created shortly
 *     before the claim — the shape a self-created task carrying a fabricated session takes, which
 *     matters here because most tasks are self-assigned.
 *
 * @param {Array<Object>} rows - work_sessions docs as { id, serverAnchorMs, ...data }, where
 *   serverAnchorMs is the row's Firestore updateTime in ms (the LAST server write — later than
 *   createTime, so a row that grew in place is never judged against its first, smaller state).
 * @param {Map<string, number>} taskCreateMsById - taskId → the task doc's Firestore createTime in ms.
 * @param {number} [sampleLimit]
 * @returns {{ checked: number, count: number, samples: Array<Object> }}
 */
function findImpossibleSpanSessions(rows, taskCreateMsById, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
    let checked = 0;
    let count = 0;
    const samples = [];
    for (const row of rows) {
        if (!isReferentialTaskSession(row)) continue;
        if (row.isBackdated || row.isRecoveredGap || row.isManualSession) continue;
        const dur = row.durationMinutes;
        if (typeof dur !== 'number' || !Number.isFinite(dur) || dur <= 0) continue;
        const taskMs = taskCreateMsById instanceof Map ? taskCreateMsById.get(row.taskId) : undefined;
        const rowMs = row.serverAnchorMs;
        // Either anchor missing → unmeasurable, not suspicious. Skipping keeps this fail-SAFE: a
        // task whose createTime could not be read never becomes a false accusation.
        if (typeof taskMs !== 'number' || typeof rowMs !== 'number') continue;
        checked += 1;
        const spanMinutes = (rowMs - taskMs) / 60000;
        if (dur <= spanMinutes + SERVER_SPAN_GRACE_MINUTES) continue;
        count += 1;
        if (samples.length < sampleLimit) {
            samples.push({
                id: row.id,
                taskId: row.taskId,
                userId: row.userId || null,
                durationMinutes: dur,
                serverSpanMinutes: Math.round(spanMinutes),
            });
        }
    }
    return { checked, count, samples };
}

/**
 * Migration telemetry (ADR-0020 step 6 gate instrument). Step 6 — "stop legacy writes only after
 * telemetry shows no active legacy clients/runs" — needs a signal for how much credited work is
 * still authored by the LEGACY client paths vs the revisioned engine, which stamps engineVersion==2
 * on every row it writes. `legacy` = rows without engineVersion==2; NOTE this bucket also includes
 * the durable standalone intents (backdate/gap-claim/manager-manual) and server compensating writes,
 * which are NOT legacy-timer rows and persist regardless — so the target for retiring the legacy
 * timer sites (roadmap P8) is the TREND toward zero NEW engine-less timer rows after the flag flip,
 * not literally legacyPct==0. While system_config/timerEngine is absent in prod the engine is
 * dormant, so this reads ~100% legacy — the informative baseline, not an alarm. A per-path breakdown
 * (legacy-timer vs intent vs server) is a documented follow-up. Report-only.
 * @param {Array<Object>} rows - work_sessions docs.
 * @returns {{ total: number, engineV2: number, legacy: number, legacyPct: number }}
 */
function classifyEngineAdoption(rows) {
    let total = 0;
    let engineV2 = 0;
    for (const row of rows) {
        total += 1;
        if (row.engineVersion === 2) engineV2 += 1;
    }
    const legacy = total - engineV2;
    const legacyPct = total > 0 ? Math.round((legacy / total) * 1000) / 10 : 0;
    return { total, engineV2, legacy, legacyPct };
}

// ── Counter drift (task card vs. the session ledger) ────────────────────────────────────────────
//
// A task carries a DENORMALISED credited total (timerMinutes + manualMinutes) that the task sheet,
// the earnings popup and the time-limit monitor read; `work_sessions` is the canonical ledger the
// reports sum. Every correction path writes BOTH — and cannot write them atomically, because
// re-deriving the counter needs a QUERY over the task's sessions and a Firestore client transaction
// cannot contain one. So the ledger lands, the counter may not, and the two surfaces then disagree
// about the same task's pay with nothing anywhere to say which is right.
//
// The client already logs a failed re-derive, but a log is not a control: nobody reads it, and the
// drift is permanent (no path revisits a correction). This is the compensating detector — report
// only, mirroring the R-04 posture: the counter is never rewritten from here, because a server-side
// guess at credited pay is a far worse failure than a visible mismatch.
//
// SCOPE IS THE FALSE-POSITIVE CONTROL. Only tasks whose ledger was actually CORRECTED are checked
// (a row carrying an edit / soft-delete / self-reduction marker). A task nobody corrected can drift
// only through paths this scan cannot judge, and flagging those would bury the real signal.

// Legacy per-task manual offsets that are NOT sessions and are deliberately added on top of the
// re-derived counter — mirrored here or every task carrying one reads as drifted.
function timeAdjustmentMinutes(task) {
    const adjustments = task && task.timeAdjustments;
    if (!Array.isArray(adjustments)) return 0;
    let total = 0;
    for (const a of adjustments) {
        const m = a && a.minutes;
        if (typeof m === 'number' && Number.isFinite(m)) total += m;
    }
    return total;
}

/** The credited total a task's own fields claim — MIRROR of calculateCurrentTotalMinutes. */
function taskCreditedMinutes(task) {
    if (!task) return 0;
    const timer = typeof task.timerMinutes === 'number' && Number.isFinite(task.timerMinutes) ? task.timerMinutes : 0;
    const manual = typeof task.manualMinutes === 'number' && Number.isFinite(task.manualMinutes) ? task.manualMinutes : 0;
    return timer + manual + timeAdjustmentMinutes(task);
}

/** True when this row proves its task's ledger was corrected after the fact. */
function isCorrectedSession(row) {
    if (!row) return false;
    return Boolean(row.editedAt || row.isDeleted || row.selfAdjusted || row.originalDurationMinutes != null);
}

// A running task legitimately shows a counter BEHIND its ledger (the current stretch is not written
// until pause), and rounding differs by a minute across paths, so only a real gap is reported.
const COUNTER_DRIFT_TOLERANCE_MINUTES = 2;

/**
 * Compare each corrected task's cached counter against the summed ledger.
 *
 * @param {Array<Object>} rows       - the recent work_sessions window, as { id, ...data }.
 * @param {Map<string, Object>} tasks - taskId → task doc data, for the corrected tasks only.
 * @param {Map<string, number>} ledgerMinutes - taskId → sum of that task's non-deleted sessions
 *        (the FULL by-taskId sum, not the window's — a partial sum would read as drift).
 * @param {number} [sampleLimit]
 * @returns {{ checked: number, drifted: number, samples: Array<Object> }}
 */
function findCounterDrift(rows, tasks, ledgerMinutes, sampleLimit = DEFAULT_SAMPLE_LIMIT) {
    const corrected = new Set();
    for (const row of rows) {
        if (!isReferentialTaskSession(row)) continue;
        if (isCorrectedSession(row)) corrected.add(row.taskId);
    }

    let drifted = 0;
    const samples = [];
    for (const taskId of corrected) {
        const task = tasks.get(taskId);
        if (!task) continue;               // orphan — already owned by findOrphanSessions
        if (task.timerStatus === 'running') continue; // uncommitted stretch, not drift
        const ledger = ledgerMinutes.get(taskId);
        if (typeof ledger !== 'number') continue;     // unreadable → not a positive claim of drift
        const counter = taskCreditedMinutes(task);
        const delta = counter - ledger;
        if (Math.abs(delta) <= COUNTER_DRIFT_TOLERANCE_MINUTES) continue;
        drifted += 1;
        if (samples.length < sampleLimit) {
            samples.push({
                taskId,
                counterMinutes: Math.round(counter),
                ledgerMinutes: Math.round(ledger),
                deltaMinutes: Math.round(delta),
            });
        }
    }
    return { checked: corrected.size, drifted, samples };
}

module.exports = {
    SUSPICIOUS_DAY_WORK_MINUTES,
    COUNTER_DRIFT_TOLERANCE_MINUTES,
    isCorrectedSession,
    taskCreditedMinutes,
    findCounterDrift,
    IMPOSSIBLE_DAY_MINUTES,
    SERVER_SPAN_GRACE_MINUTES,
    isReferentialTaskSession,
    collectReferentialTaskIds,
    findOrphanSessions,
    classifySuspiciousWorkDays,
    findImpossibleSpanSessions,
    classifyEngineAdoption,
};
