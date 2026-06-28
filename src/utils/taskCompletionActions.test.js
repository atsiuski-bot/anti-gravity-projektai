import { describe, it, expect, vi, beforeEach } from 'vitest';

// CHARACTERIZATION of toggleTaskCompletion — the checkbox/"Užbaigti" orchestrator that ties the
// stateful timer-stop (credited duration + clamping) to the audited status write (completion-status
// resolution). It is a thin router with three load-bearing decisions, all asserted here:
//   1. completing a STILL-RUNNING task pauses FIRST (clamp + log the final work_session + clear the
//      clock) so the audited command stays a pure status write — otherwise the task lands "completed
//      but still running" (timer keeps accruing, the green UI sticks).
//   2. the resulting status comes from the actor's ROLE via resolveCompletionStatus: a manager-role
//      finish auto-confirms ('confirmed'); everyone else lands 'completed' awaiting a real manager.
//   3. un-checking routes to reopenTask and NEVER pauses.
//
// Mocking mirrors the established integration convention (taskActions / completeTask suites): fake
// only the firebase boundary so the REAL domain commands, REAL formatters (resolveCompletionStatus)
// and REAL timeUtils credit math (clampSessionMinutes / MIN_LOGGED_SESSION_MINUTES) all run, and we
// inspect the exact Firestore payloads. getLithuanianNow is the only timeUtils member stubbed so the
// pause credit (now - timerStartedAt) is deterministic.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
    collection: vi.fn((_db, name) => ({ _col: name })),
    updateDoc: vi.fn(() => Promise.resolve()),
    addDoc: vi.fn(() => Promise.resolve({ id: 'generated-id' })),
    setDoc: vi.fn(() => Promise.resolve()),
    deleteDoc: vi.fn(() => Promise.resolve()),
    getDoc: vi.fn(() => Promise.resolve({ exists: () => false, data: () => ({}) })),
    getDocs: vi.fn(() => Promise.resolve({ docs: [] })),
    query: vi.fn((...args) => args),
    where: vi.fn(() => 'where-clause'),
    orderBy: vi.fn(() => 'order-clause'),
}));

vi.mock('./errorLog', () => ({ logError: vi.fn() }));

vi.mock('./timeUtils', async (importActual) => ({
    ...(await importActual()),
    getLithuanianNow: vi.fn(),
}));

import { updateDoc, addDoc, setDoc } from 'firebase/firestore';
import { getLithuanianNow, MAX_SESSION_MINUTES } from './timeUtils';
import { toggleTaskCompletion } from './taskCompletionActions';

// Fixed "now" so the pause credit (now - timerStartedAt) is exact. June -> Vilnius is a stable
// UTC+3, so a session buckets to 2026-06-23 with no DST ambiguity.
const NOW = new Date('2026-06-23T12:00:00.000Z');

const MANAGER = { uid: 'mgr1', displayName: 'Manager', email: 'm@x.lt' };
const WORKER = { uid: 'w1', displayName: 'Worker', email: 'w@x.lt' };

// Find the write payload for a specific Firestore doc / collection across all mock calls. A running
// finish writes the task doc TWICE — first the pauseTask timer-credit write, then the completeTask
// status write — so callers pick the relevant one: taskUpdateFor = first (credit), lastTaskUpdateFor
// = the completion write whose status/confirmation fields are the final word.
const taskUpdatesFor = (id) => updateDoc.mock.calls.filter(([ref]) => ref?._path === `tasks/${id}`).map((c) => c[1]);
const taskUpdateFor = (id) => taskUpdatesFor(id)[0];
const lastTaskUpdateFor = (id) => taskUpdatesFor(id).at(-1);
const workSessionWrites = () => addDoc.mock.calls.filter(([col]) => col?._col === 'work_sessions').map((c) => c[1]);
const decisionWrites = () => setDoc.mock.calls.filter(([ref]) => ref?._col === 'decision_log').map((c) => c[1]);

beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks wipes call history but NOT implementations, so re-arm the resolving defaults —
    // otherwise a mockRejectedValue from a failure test would leak into the next one.
    updateDoc.mockResolvedValue(undefined);
    addDoc.mockResolvedValue({ id: 'generated-id' });
    setDoc.mockResolvedValue(undefined);
    getLithuanianNow.mockReturnValue(NOW);
});

describe('toggleTaskCompletion — completion-status resolution (actor ROLE decides)', () => {
    it('a WORKER finishing a not-completed task lands it as completed (awaiting confirmation)', async () => {
        const task = { id: 't1', title: 'Roof', status: 'in-progress', completed: false, managerId: 'mgr1' };

        await toggleTaskCompletion(task, WORKER, 'worker');

        const upd = taskUpdateFor('t1');
        expect(upd.completed).toBe(true);
        expect(upd.status).toBe('completed');
        expect(upd.completedBy).toBe('w1');
        expect(upd.confirmedBy).toBeNull();
        expect(upd.confirmedAt).toBeNull();
        // The command always pins the timer off on completion.
        expect(upd.timerStatus).toBe('paused');
        expect(upd.timerStartedAt).toBeNull();
    });

    it('a MANAGER finishing a task auto-confirms it (status confirmed + confirmedBy)', async () => {
        const task = { id: 't1', title: 'Roof', status: 'in-progress', completed: false, managerId: 'someoneElse' };

        await toggleTaskCompletion(task, MANAGER, 'manager');

        const upd = taskUpdateFor('t1');
        expect(upd.status).toBe('confirmed');
        expect(upd.completedBy).toBe('mgr1');
        expect(upd.confirmedBy).toBe('mgr1');
        expect(typeof upd.confirmedAt).toBe('string');
    });

    it('an ADMIN finishing a task also auto-confirms (admin is a manager-shaped role)', async () => {
        const task = { id: 't1', title: 'Roof', status: 'in-progress', completed: false };

        await toggleTaskCompletion(task, { uid: 'adm1' }, 'admin');

        expect(taskUpdateFor('t1').status).toBe('confirmed');
    });

    it("a WORKER named as the task's managerId still does NOT auto-confirm (role, not ownership, grants confirm)", async () => {
        // Regression guard: confirm authority keys off the actor ROLE alone — firestore.rules denies
        // a worker self-confirming, so an ownership-based auto-confirm would silently fail the finish.
        const ownManager = { uid: 'mgrOwn' };
        const task = { id: 't1', title: 'Roof', status: 'pending', completed: false, managerId: 'mgrOwn' };

        await toggleTaskCompletion(task, ownManager, 'worker');

        const upd = taskUpdateFor('t1');
        expect(upd.status).toBe('completed');
        expect(upd.confirmedBy).toBeNull();
    });

    it('appends exactly one decision_log entry naming the acting user and the before/after status', async () => {
        const task = { id: 't1', title: 'Roof', status: 'in-progress', completed: false };

        await toggleTaskCompletion(task, MANAGER, 'manager');

        const decisions = decisionWrites();
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({
            command: 'completeTask',
            targetType: 'task',
            targetId: 't1',
            actorId: 'mgr1',
            before: { status: 'in-progress', completed: false },
            after: { status: 'confirmed', completed: true, completedBy: 'mgr1' },
        });
    });
});

describe('toggleTaskCompletion — timer-stop credit + clamp on a still-running finish', () => {
    it('pauses a RUNNING task first: credits the elapsed interval and logs a matching work_session', async () => {
        const task = {
            id: 't1',
            title: 'Roof repair',
            status: 'in-progress',
            completed: false,
            timerStatus: 'running',
            timerStartedAt: '2026-06-23T11:00:00.000Z', // 60 min before NOW
            timerMinutes: 10,
            assignedUserId: 'u1',
        };

        await toggleTaskCompletion(task, WORKER, 'worker');

        // pauseTask wrote the credited duration onto the task doc (the FIRST tasks/t1 write)...
        const paused = taskUpdateFor('t1');
        expect(paused.timerMinutes).toBe(70); // 10 prior + 60 elapsed
        expect(paused.timerStatus).toBe('paused');
        expect(paused.timerStartedAt).toBeNull();
        // ...and the audited completion is still recorded (worker -> completed) by the LAST write.
        const completion = lastTaskUpdateFor('t1');
        expect(completion.status).toBe('completed');
        expect(completion.completed).toBe(true);
        expect(completion.timerStatus).toBe('paused');
        expect(completion.timerStartedAt).toBeNull();

        const sessions = workSessionWrites();
        expect(sessions).toHaveLength(1);
        expect(sessions[0].durationMinutes).toBe(60);
        expect(sessions[0].taskId).toBe('t1');
        expect(sessions[0].userId).toBe('u1');
        expect(sessions[0].endTime).toBe(NOW.toISOString());
        // Session is attributed to the Vilnius day it ENDED.
        expect(sessions[0].date).toBe('2026-06-23');
    });

    it('caps an orphaned running timer at the 16h ceiling instead of crediting the whole gap', async () => {
        const orphan = {
            id: 'orphan1',
            title: 'Left running',
            status: 'in-progress',
            completed: false,
            timerStatus: 'running',
            timerStartedAt: '2026-06-20T12:00:00.000Z', // 72h before NOW
            timerMinutes: 0,
            assignedUserId: 'u1',
        };

        await toggleTaskCompletion(orphan, WORKER, 'worker');

        const upd = taskUpdateFor('orphan1');
        expect(upd.timerMinutes).toBe(MAX_SESSION_MINUTES); // 960, not 4320
        expect(workSessionWrites()[0].durationMinutes).toBe(MAX_SESSION_MINUTES);
    });

    it('does NOT pause when completing a task whose timer is NOT running (no spurious credit)', async () => {
        const task = {
            id: 't2',
            title: 'Already paused',
            status: 'in-progress',
            completed: false,
            timerStatus: 'paused',
            timerStartedAt: null,
            timerMinutes: 30,
            assignedUserId: 'u1',
        };

        await toggleTaskCompletion(task, WORKER, 'worker');

        // No timer credit math ran: no work_session logged, timerMinutes untouched by the path.
        expect(workSessionWrites()).toHaveLength(0);
        const upd = taskUpdateFor('t2');
        expect(upd.completed).toBe(true);
        expect(upd.status).toBe('completed');
    });

    it('completing a task with no timer fields at all just records the status (never crashes)', async () => {
        const task = { id: 't3', title: 'Manual only', status: 'pending', completed: false };

        await toggleTaskCompletion(task, WORKER, 'worker');

        expect(workSessionWrites()).toHaveLength(0);
        expect(taskUpdateFor('t3').completed).toBe(true);
    });
});

describe('toggleTaskCompletion — un-checking routes to reopenTask and never pauses', () => {
    it('un-checking a completed task reopens it to pending and clears completion/confirmation', async () => {
        const completed = {
            id: 't1',
            title: 'Roof',
            status: 'confirmed',
            completed: true,
            timerMinutes: 70, // any logged time -> reopen re-arms timer to paused
        };

        await toggleTaskCompletion(completed, MANAGER, 'manager');

        const upd = taskUpdateFor('t1');
        expect(upd.status).toBe('pending');
        expect(upd.completed).toBe(false);
        expect(upd.completedAt).toBeNull();
        expect(upd.completedBy).toBeNull();
        expect(upd.confirmedBy).toBeNull();
        expect(upd.timerStatus).toBe('paused'); // re-armed because timerMinutes > 0

        // No timer-stop ran on the reopen path.
        expect(workSessionWrites()).toHaveLength(0);

        const decisions = decisionWrites();
        expect(decisions).toHaveLength(1);
        expect(decisions[0]).toMatchObject({ command: 'reopenTask', targetId: 't1' });
    });

    it('un-checking a completed task with NO logged time clears the timer status entirely', async () => {
        const completed = { id: 't4', title: 'Roof', status: 'completed', completed: true, timerMinutes: 0 };

        await toggleTaskCompletion(completed, WORKER, 'worker');

        expect(taskUpdateFor('t4').timerStatus).toBeNull(); // mirrors prior revertTask behaviour
    });

    it('does NOT pause when un-checking, even if (impossibly) flagged running', async () => {
        // The pause guard is gated on `willBeCompleted`; reopening must never stop a timer.
        const completed = {
            id: 't5', title: 'Roof', status: 'completed', completed: true,
            timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z', timerMinutes: 5,
        };

        await toggleTaskCompletion(completed, MANAGER, 'manager');

        expect(workSessionWrites()).toHaveLength(0);
        expect(decisionWrites()[0]).toMatchObject({ command: 'reopenTask' });
    });
});

describe('toggleTaskCompletion — ordering: the timer is stopped BEFORE the status write', () => {
    it('the running-timer pause commits before the audited completion (pure status write invariant)', async () => {
        const order = [];
        addDoc.mockImplementation((col) => {
            if (col?._col === 'work_sessions') order.push('pause:work_session');
            return Promise.resolve({ id: 'generated-id' });
        });
        updateDoc.mockImplementation((ref) => {
            if (ref?._path === 'tasks/t1') order.push('task:update');
            return Promise.resolve();
        });

        const task = {
            id: 't1', title: 'Roof', status: 'in-progress', completed: false,
            timerStatus: 'running', timerStartedAt: '2026-06-23T11:00:00.000Z',
            timerMinutes: 0, assignedUserId: 'u1',
        };

        await toggleTaskCompletion(task, WORKER, 'worker');

        // pauseTask logs the work_session AND writes the task doc (timerStatus:paused) before the
        // completeTask command issues its own task-doc write. The work_session must precede the
        // FINAL (completion) task update.
        const firstSession = order.indexOf('pause:work_session');
        const lastTaskUpdate = order.lastIndexOf('task:update');
        expect(firstSession).toBeGreaterThanOrEqual(0);
        expect(firstSession).toBeLessThan(lastTaskUpdate);
    });
});
