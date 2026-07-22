import { describe, it, expect, vi } from 'vitest';

// The panel is a React surface with Firebase-backed collaborators; only the PURE skip-target
// decision is under test here, so the module graph is neutralised the same way the taskActions /
// useOrphanedTaskRecovery suites do it. Everything below is a stub — nothing renders.
vi.mock('../firebase', () => ({ db: {}, auth: {}, functions: {} }));
vi.mock('firebase/firestore', () => ({}));
vi.mock('firebase/functions', () => ({ httpsCallable: vi.fn(), getFunctions: vi.fn() }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({}) }));
vi.mock('../context/UsersContext', () => ({ useUsers: () => ({ activeUsers: [] }) }));
vi.mock('../utils/taskActions', () => ({
    getTaskTemplates: vi.fn(),
    setTemplateRecurrence: vi.fn(),
    setTemplateAssignee: vi.fn(),
    createManagerTask: vi.fn(),
}));
vi.mock('../utils/recurringActions', () => ({ runRecurringNow: vi.fn() }));
vi.mock('./TaskModal', () => ({ default: () => null }));

import { nextPendingOccurrence } from './RecurringTasksPanel';

// A daily rule: every day fires, so the difference between "today" and "the next day a manager can
// still cancel" is exactly what this predicate decides.
const dailyRule = (overrides = {}) => ({
    active: true,
    freq: 'daily',
    byWeekday: [],
    interval: 1,
    anchorDate: null,
    byMonthDay: 1,
    skipDates: [],
    lastGeneratedDate: null,
    ...overrides,
});

describe('nextPendingOccurrence — the occurrence "Praleisti kitą" can still cancel', () => {
    it('skips TODAY once the 05:00 generator has already written it', () => {
        // The regression: with today already generated, targeting today is inert — the task exists
        // and tomorrow's occurrence, the one the manager meant to cancel, still fires.
        expect(
            nextPendingOccurrence(dailyRule({ lastGeneratedDate: '2026-07-22' }), '2026-07-22'),
        ).toBe('2026-07-23');
    });

    it('still targets today when today has NOT been generated yet', () => {
        expect(nextPendingOccurrence(dailyRule(), '2026-07-22')).toBe('2026-07-22');
        expect(
            nextPendingOccurrence(dailyRule({ lastGeneratedDate: '2026-07-21' }), '2026-07-22'),
        ).toBe('2026-07-22');
    });

    it('keeps honouring skipDates after moving past today (a second skip lands on the next day)', () => {
        expect(
            nextPendingOccurrence(
                dailyRule({ lastGeneratedDate: '2026-07-22', skipDates: ['2026-07-23'] }),
                '2026-07-22',
            ),
        ).toBe('2026-07-24');
    });

    it('returns null for a paused or missing rule', () => {
        expect(nextPendingOccurrence(null, '2026-07-22')).toBeNull();
        expect(nextPendingOccurrence(dailyRule({ active: false }), '2026-07-22')).toBeNull();
    });
});
