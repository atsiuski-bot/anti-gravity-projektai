import { describe, it, expect } from 'vitest';
import { deriveIntegrityView } from './auditDashboard.helpers';

/**
 * The fixtures below are REAL `integrity_reports` documents read out of production
 * (project darbo-planavimas) on 2026-07-29, trimmed to the fields this derivation reads. Real ones
 * on purpose: the bug this card fixes was not a logic error, it was a whole family of fields that
 * the scan had been writing for weeks and the UI never read. A synthetic fixture would have been
 * written from the same mistaken picture of the document as the original card, and would have
 * agreed with it.
 */

// 2026-07-29 — a run WITH findings. 26 server-span hits (the check's first production day) plus a
// large stale backlog, and it did complete.
const REPORT_WITH_FINDINGS = {
    day: '2026-07-29',
    severity: 'warning',
    complete: true,
    scanErrors: [],
    ranAt: '2026-07-29T03:00:04.679Z',
    counts: { work_sessions: 6402, break_sessions: 1361, work_hours: 735, tasks: 180 },
    drops: [],
    totalAnomalies: 0,
    dailyOverdraft: { checked: 14, offenders: 0, samples: [] },
    autoStoppedTimers: { scanned: 0, stopped: 0, deferred: 0, samples: [] },
    autoClosedSessions: { scanned: 18, closed: 0, samples: [] },
    staleBacklog: { count: 64, samples: [] },
    creditIntegrity: {
        orphan: { checked: 33, orphans: 0, samples: [] },
        suspicious: { checked: 14, count: 0, samples: [] },
        serverSpan: {
            checked: 97,
            count: 26,
            samples: [
                {
                    id: 'sess_run_timer_run_27c69990-3477-4fbe-9585-9696ee624c75',
                    taskId: 'FnG8cwzP7WwFd6vjCWgD',
                    userId: 'RLYj18Ry6MMONDWO6GhaRA6b7eJ3',
                    durationMinutes: 0.7651166666666667,
                    serverSpanMinutes: -1244,
                },
            ],
        },
        engineAdoption: { total: 166, engineV2: 31, legacy: 135, legacyPct: 81.3 },
    },
};

// 2026-07-27 — a genuinely clean run. Note it predates the server-span check, so `serverSpan` is
// absent entirely: an older report must degrade to "clean", never to a crash or a false finding.
const REPORT_CLEAN = {
    day: '2026-07-27',
    severity: 'ok',
    ranAt: '2026-07-27T03:00:01.859Z',
    counts: { work_sessions: 6234 },
    drops: [],
    totalAnomalies: 0,
    dailyOverdraft: { checked: 4, offenders: 0, samples: [] },
    autoStoppedTimers: { stopped: 0, scanned: 1, samples: [] },
    autoClosedSessions: { scanned: 18, closed: 0, samples: [] },
    staleBacklog: { count: 72, samples: [] },
    creditIntegrity: {
        orphan: { checked: 5, orphans: 0, samples: [] },
        suspicious: { checked: 4, count: 0, samples: [] },
        engineAdoption: { total: 24, engineV2: 17, legacy: 7, legacyPct: 29.2 },
    },
};

describe('deriveIntegrityView — findings that the card used to swallow', () => {
    it('surfaces the server-span finding with its evidence', () => {
        const v = deriveIntegrityView(REPORT_WITH_FINDINGS);
        expect(v.creditFindings.map((f) => f.key)).toEqual(['serverSpan']);
        expect(v.creditFindings[0].count).toBe(26);
        // The samples are the whole point: a count alone is not actionable, because an admin cannot
        // query Firestore to find out WHICH rows were flagged.
        expect(v.creditFindings[0].samples[0].taskId).toBe('FnG8cwzP7WwFd6vjCWgD');
    });

    it('reports the checked totals so a clean run proves it ran', () => {
        const v = deriveIntegrityView(REPORT_WITH_FINDINGS);
        expect(v.creditChecked).toBe(33 + 14 + 97 + 14);
        expect(v.hasCreditSection).toBe(true);
    });

    it('collapses a clean run to no findings, without inventing one', () => {
        const v = deriveIntegrityView(REPORT_CLEAN);
        expect(v.creditFindings).toEqual([]);
        expect(v.creditChecked).toBe(5 + 4 + 4);
        // Still rendered — "checked 13 things, found nothing" and "never ran" must not look alike.
        expect(v.hasCreditSection).toBe(true);
        expect(v.incomplete).toBe(false);
    });

    it('surfaces deferred auto-stops — timers the net could not safely close', () => {
        const v = deriveIntegrityView({
            ...REPORT_WITH_FINDINGS,
            autoStoppedTimers: { scanned: 3, stopped: 1, deferred: 2, samples: [] },
        });
        expect(v.stopped).toBe(1);
        expect(v.deferred).toBe(2);
    });
});

describe('deriveIntegrityView — cross-store session disagreements', () => {
    it('splits findings per kind and keeps each kind its own evidence', () => {
        const v = deriveIntegrityView({
            ...REPORT_CLEAN,
            sessionDisagreements: {
                checked: 12,
                count: 3,
                byKind: { staleUserRun: 2, multipleRunningTasks: 1, canonicalOrphanRun: 0 },
                samples: [
                    { kind: 'staleUserRun', userId: 'U1', taskId: 'T1', taskTimerStatus: 'paused' },
                    { kind: 'staleUserRun', userId: 'U2', taskId: 'T2', taskTimerStatus: 'missing' },
                    { kind: 'multipleRunningTasks', userId: 'U3', taskIds: ['T3', 'T4'] },
                ],
            },
        });
        expect(v.sessionFindings.map((f) => f.key)).toEqual(['staleUserRun', 'multipleRunningTasks']);
        expect(v.sessionFindings[0].samples).toHaveLength(2);
        expect(v.sessionFindings[1].samples[0].userId).toBe('U3');
        expect(v.sessionChecked).toBe(12);
    });

    it('shows the section on a healthy day so silence still proves it ran', () => {
        // The production shape on 2026-07-29: two workers, two running tasks, everything agreeing.
        const v = deriveIntegrityView({
            ...REPORT_CLEAN,
            sessionDisagreements: {
                checked: 2, count: 0,
                byKind: { staleUserRun: 0, multipleRunningTasks: 0, canonicalOrphanRun: 0 },
                samples: [],
            },
        });
        expect(v.sessionFindings).toEqual([]);
        expect(v.hasSessionSection).toBe(true);
    });

    it('hides the section entirely for reports written before the check existed', () => {
        expect(deriveIntegrityView(REPORT_CLEAN).hasSessionSection).toBe(false);
    });
});

describe('deriveIntegrityView — completeness outranks counts', () => {
    it('flags a run that could not read everything, however clean its counts look', () => {
        const v = deriveIntegrityView({
            ...REPORT_CLEAN,
            complete: false,
            scanErrors: [{ scan: 'count:work_sessions', message: 'DEADLINE_EXCEEDED' }],
        });
        expect(v.incomplete).toBe(true);
        expect(v.scanErrors).toHaveLength(1);
        // The zeros survive untouched — they are shown, but under a banner saying they mean nothing.
        expect(v.creditFindings).toEqual([]);
    });

    it('treats a recorded scan error as incomplete even when the flag says complete', () => {
        const v = deriveIntegrityView({
            ...REPORT_CLEAN,
            complete: true,
            scanErrors: [{ scan: 'creditIntegrity:query', message: 'permission denied' }],
        });
        expect(v.incomplete).toBe(true);
    });

    it('does not accuse an OLD report that predates the completeness flag', () => {
        // `complete: undefined` is unknown, not broken. Claiming otherwise would make every archived
        // report shout — the same alarm fatigue this card exists to avoid.
        const { complete, ...legacy } = REPORT_CLEAN;
        expect(complete).toBeUndefined();
        expect(deriveIntegrityView(legacy).incomplete).toBe(false);
    });
});

describe('deriveIntegrityView — degenerate input', () => {
    it('survives an empty or malformed report without throwing', () => {
        for (const bad of [undefined, null, {}, { creditIntegrity: null }, { scanErrors: 'nope' }]) {
            const v = deriveIntegrityView(bad);
            expect(v.creditFindings).toEqual([]);
            expect(v.incomplete).toBe(false);
            expect(v.hasCreditSection).toBe(false);
            expect(v.stale).toBe(0);
        }
    });
});
