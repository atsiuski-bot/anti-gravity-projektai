import { describe, it, expect, vi, beforeEach } from 'vitest';

// Integration test: assignTask -> real kernel -> real decisionLog, all against in-memory Firestore
// fakes. This proves the WHOLE first command path end to end (plan -> apply -> audit) and the
// agent-commit boundary, without a live backend.
vi.mock('../../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  updateDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc, setDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { assignTask, __buildAssignPlan } from './assignTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const HUMAN = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:assign', kind: 'assignment-planner' });
const TASK = { id: 't1', title: 'Roof repair', assignedUserId: 'old', assignedUserName: 'Old Worker' };
const WORKER = { id: 'w2', name: 'Giedrius' };

const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref?._path === 'tasks/t1')?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref?._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('assignTask — plan', () => {
  it('captures before/after and a human-readable summary', () => {
    const p = __buildAssignPlan({ task: TASK, worker: WORKER });
    expect(p.targetId).toBe('t1');
    expect(p.before).toEqual({ assignedUserId: 'old', assignedUserName: 'Old Worker' });
    expect(p.after).toEqual({ assignedUserId: 'w2', assignedUserName: 'Giedrius' });
    expect(p.summary).toContain('Giedrius');
    expect(p.noop).toBe(false);
  });

  it('flags a no-op when the task is already assigned to the worker', () => {
    const p = __buildAssignPlan({ task: { id: 't1', assignedUserId: 'w2' }, worker: WORKER });
    expect(p.noop).toBe(true);
  });

  it('rejects missing task or worker (invalid input throws)', () => {
    expect(() => __buildAssignPlan({ worker: WORKER })).toThrow();
    expect(() => __buildAssignPlan({ task: TASK })).toThrow();
  });
});

describe('assignTask — propose (no writes)', () => {
  it('a human proposal returns the plan and writes nothing', async () => {
    const res = await assignTask({ task: TASK, worker: WORKER }, { actor: HUMAN, mode: MODES.PROPOSE });
    expect(res).toMatchObject({ ok: true, mode: 'propose', command: 'assignTask' });
    expect(res.proposal.after.assignedUserId).toBe('w2');
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('an AGENT may propose', async () => {
    const res = await assignTask({ task: TASK, worker: WORKER }, { actor: AGENT, mode: MODES.PROPOSE });
    expect(res.ok).toBe(true);
    expect(updateDoc).not.toHaveBeenCalled();
  });
});

describe('assignTask — commit', () => {
  it('a human commit reassigns the task and appends one decision entry', async () => {
    const res = await assignTask(
      { task: TASK, worker: WORKER },
      { actor: HUMAN, mode: MODES.COMMIT, idempotencyKey: 'op_assign_1', reason: 'rebalancing' },
    );

    const upd = taskUpdate();
    expect(upd.assignedUserId).toBe('w2');
    // assignedUserName is a read-derived display field — NOT persisted onto the task (it lives only
    // in the audit before/after). Persisting it would go stale on a rename.
    expect('assignedUserName' in upd).toBe(false);
    expect(typeof upd.assignedAt).toBe('string');
    expect(typeof upd.updatedAt).toBe('string');

    const decision = decisionWrite();
    expect(decision).toMatchObject({
      command: 'assignTask', targetType: 'task', targetId: 't1',
      actorType: 'human', actorId: 'mgr1', reason: 'rebalancing',
      before: { assignedUserId: 'old', assignedUserName: 'Old Worker' },
      after: { assignedUserId: 'w2', assignedUserName: 'Giedrius' },
    });
    expect(res).toMatchObject({ ok: true, mode: 'commit', decisionId: 'op_assign_1' });
  });

  it('an AGENT commit is REFUSED (human-only boundary) — nothing is written', async () => {
    const res = await assignTask({ task: TASK, worker: WORKER }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(res.reason).toMatch(/agent-commit-not-permitted/);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed task write is durably logged and rethrown (audit is not written)', async () => {
    updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(
      assignTask({ task: TASK, worker: WORKER }, { actor: HUMAN, mode: MODES.COMMIT }),
    ).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.assignTask' });
    expect(setDoc).not.toHaveBeenCalled(); // effect failed -> no audit claiming it happened
  });
});
