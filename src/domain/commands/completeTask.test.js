import { describe, it, expect, vi, beforeEach } from 'vitest';

// Integration: completeTask -> real kernel -> real decisionLog, against in-memory Firestore fakes.
// formatters (isManagerRole) is kept REAL so the manager auto-confirm rule is genuinely exercised.
vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  updateDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc, setDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { completeTask, __buildCompletePlan } from './completeTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MANAGER = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const WORKER = humanActor({ uid: 'w1', displayName: 'Worker', role: 'worker' });
const AGENT = agentActor({ id: 'ag:complete', kind: 'planner' });
const OPEN_TASK = { id: 't1', title: 'Roof', status: 'in-progress', completed: false, managerId: 'mgr1' };

const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('completeTask — plan (manager auto-confirm rule)', () => {
  it('a manager completion auto-confirms (status confirmed + confirmedBy)', () => {
    const p = __buildCompletePlan({ task: { id: 't1', status: 'in-progress', completed: false, managerId: 'x' } }, MANAGER);
    expect(p.payload.status).toBe('confirmed');
    expect(p.payload.completed).toBe(true);
    expect(p.payload.completedBy).toBe('mgr1');
    expect(p.payload.confirmedBy).toBe('mgr1');
    expect(p.payload.timerStatus).toBe('paused');
    expect(p.payload.timerStartedAt).toBeNull();
    expect(p.before).toEqual({ status: 'in-progress', completed: false });
    expect(p.after).toEqual({ status: 'confirmed', completed: true, completedBy: 'mgr1' });
  });

  it('a worker completion lands as completed (awaiting confirmation), no confirmedBy', () => {
    const p = __buildCompletePlan({ task: { id: 't1', status: 'in-progress', completed: false, managerId: 'mgrX' } }, WORKER);
    expect(p.payload.status).toBe('completed');
    expect(p.payload.confirmedBy).toBeNull();
    expect(p.payload.confirmedAt).toBeNull();
    expect(p.payload.completedBy).toBe('w1');
  });

  it("a worker named as the task's managerId does NOT auto-confirm (confirm is a manager ROLE; firestore.rules denies a worker self-confirming)", () => {
    // Regression for the permission block: the old uid===managerId arm wrote status:'confirmed',
    // which changesApprovalFields() in firestore.rules DENIES for a worker — silently failing the
    // whole finish. A worker now lands 'completed' and waits for a real manager's priėmimas.
    const ownManager = humanActor({ uid: 'mgrOwn', role: 'worker' }); // role worker, even though they are the task's managerId
    const p = __buildCompletePlan({ task: { id: 't1', status: 'pending', completed: false, managerId: 'mgrOwn' } }, ownManager);
    expect(p.payload.status).toBe('completed');
    expect(p.payload.confirmedBy).toBeNull();
    expect(p.payload.confirmedAt).toBeNull();
  });

  it('a SELF-DIRECTED completion does NOT auto-confirm — it lands as completed for manager review', () => {
    // Worker created the task for themselves and is also its managerId — but role is worker, so it
    // still lands 'completed'; self-direction does not factor in, the actor's role decides.
    const selfDirected = { id: 't1', status: 'in-progress', completed: false, assignedUserId: 'w1', createdBy: 'w1', managerId: 'w1' };
    const p = __buildCompletePlan({ task: selfDirected }, WORKER);
    expect(p.payload.status).toBe('completed');
    expect(p.payload.confirmedBy).toBeNull();
    expect(p.payload.confirmedAt).toBeNull();
    expect(p.payload.completedBy).toBe('w1');
  });

  it('a self-directed completion with NO managerId also lands as completed', () => {
    const selfDirected = { id: 't1', status: 'in-progress', completed: false, assignedUserId: 'w1', createdBy: 'w1' };
    const p = __buildCompletePlan({ task: selfDirected }, WORKER);
    expect(p.payload.status).toBe('completed');
    expect(p.payload.confirmedBy).toBeNull();
  });

  it("a worker who is the managerId of SOMEONE ELSE's task still does NOT auto-confirm (role, not ownership, grants confirm)", () => {
    // managerId === actor but role is worker → no confirm authority under firestore.rules → 'completed'.
    const ownManager = humanActor({ uid: 'mgrOwn', role: 'worker' });
    const othersTask = { id: 't1', status: 'pending', completed: false, assignedUserId: 'someoneElse', createdBy: 'someoneElse', managerId: 'mgrOwn' };
    const p = __buildCompletePlan({ task: othersTask }, ownManager);
    expect(p.payload.status).toBe('completed');
    expect(p.payload.confirmedBy).toBeNull();
  });

  it('a MANAGER ROLE completing their own self-directed task still auto-confirms (they are the review authority)', () => {
    // Role-based auto-confirm is independent of self-direction: a manager needs no self-review.
    const selfDirectedByManager = { id: 't1', status: 'in-progress', completed: false, assignedUserId: 'mgr1', createdBy: 'mgr1', managerId: 'mgr1' };
    const p = __buildCompletePlan({ task: selfDirectedByManager }, MANAGER);
    expect(p.payload.status).toBe('confirmed');
    expect(p.payload.confirmedBy).toBe('mgr1');
  });

  it('rejects a missing task', () => {
    expect(() => __buildCompletePlan({}, MANAGER)).toThrow();
  });
});

describe('completeTask — commit', () => {
  it('writes the completion fields and appends one decision entry', async () => {
    const res = await completeTask({ task: OPEN_TASK }, { actor: MANAGER, mode: MODES.COMMIT, idempotencyKey: 'op_c1', reason: 'completed via checkbox' });
    const upd = taskUpdate();
    expect(upd.completed).toBe(true);
    expect(upd.status).toBe('confirmed');
    expect(upd.timerStatus).toBe('paused');
    const decision = decisionWrite();
    expect(decision).toMatchObject({ command: 'completeTask', targetType: 'task', targetId: 't1', actorId: 'mgr1', before: { status: 'in-progress', completed: false } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED — nothing is written', async () => {
    const res = await completeTask({ task: OPEN_TASK }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown (no audit)', async () => {
    updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(completeTask({ task: OPEN_TASK }, { actor: MANAGER, mode: MODES.COMMIT })).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.completeTask' });
    expect(setDoc).not.toHaveBeenCalled();
  });
});
