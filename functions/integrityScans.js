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

module.exports = {
    SUSPICIOUS_DAY_WORK_MINUTES,
    IMPOSSIBLE_DAY_MINUTES,
    isReferentialTaskSession,
    collectReferentialTaskIds,
    findOrphanSessions,
    classifySuspiciousWorkDays,
    classifyEngineAdoption,
};
