import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  updateDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc, setDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { confirmTask, __buildConfirmPlan } from './confirmTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MGR = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:c', kind: 'planner' });
const TASK = { id: 't1', title: 'Roof', status: 'completed' };

const updFor = (col) => updateDoc.mock.calls.find(([ref]) => ref && ref._col === col)?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('confirmTask — plan', () => {
  it('targets tasks by default, archived_tasks when asked', () => {
    expect(__buildConfirmPlan({ task: TASK }).collection).toBe('tasks');
    expect(__buildConfirmPlan({ task: TASK, collection: 'archived_tasks' }).collection).toBe('archived_tasks');
    expect(__buildConfirmPlan({ task: TASK }).before).toEqual({ status: 'completed', confirmedBy: null });
  });
  it('rejects a missing task', () => { expect(() => __buildConfirmPlan({})).toThrow(); });
});

describe('confirmTask — commit', () => {
  it('writes the canonical confirm shape (confirmedBy from actor, NO isApproved) + one decision', async () => {
    const res = await confirmTask({ task: TASK }, { actor: MGR, mode: MODES.COMMIT, reason: 'confirmed from task card' });
    const upd = updFor('tasks');
    expect(upd).toMatchObject({ status: 'confirmed', confirmedBy: 'mgr1' });
    expect('isApproved' in upd).toBe(false);
    expect(Object.keys(upd).sort()).toEqual(['confirmedAt', 'confirmedBy', 'status', 'updatedAt']);
    expect(decisionWrite()).toMatchObject({ command: 'confirmTask', targetId: 't1', actorId: 'mgr1', after: { status: 'confirmed' } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('can confirm an archived task (archived_tasks collection)', async () => {
    await confirmTask({ task: TASK, collection: 'archived_tasks' }, { actor: MGR, mode: MODES.COMMIT });
    expect(updFor('archived_tasks')).toMatchObject({ status: 'confirmed', confirmedBy: 'mgr1' });
    expect(updFor('tasks')).toBeUndefined();
  });

  it('an AGENT commit is REFUSED', async () => {
    const res = await confirmTask({ task: TASK }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown', async () => {
    updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(confirmTask({ task: TASK }, { actor: MGR, mode: MODES.COMMIT })).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.confirmTask' });
    expect(setDoc).not.toHaveBeenCalled();
  });
});
