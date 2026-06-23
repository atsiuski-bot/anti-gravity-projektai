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
import { reopenTask, __buildReopenPlan } from './reopenTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const HUMAN = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:reopen', kind: 'planner' });

const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('reopenTask — plan', () => {
  it('resets completion + confirmation + soft-delete flags back to pending', () => {
    const p = __buildReopenPlan({ task: { id: 't1', status: 'confirmed', completed: true, timerMinutes: 0 } });
    expect(p.payload).toMatchObject({
      status: 'pending', completed: false, completedAt: null, completedBy: null,
      confirmedBy: null, confirmedAt: null, isDeleted: false, deletedAt: null, deletedBy: null,
    });
    expect(p.before).toEqual({ status: 'confirmed', completed: true });
    expect(p.after).toEqual({ status: 'pending', completed: false });
  });

  it('re-arms the timer to paused when time was logged, else clears it', () => {
    expect(__buildReopenPlan({ task: { id: 't1', timerMinutes: 45 } }).payload.timerStatus).toBe('paused');
    expect(__buildReopenPlan({ task: { id: 't1', timerMinutes: 0 } }).payload.timerStatus).toBeNull();
  });

  it('rejects a missing task', () => {
    expect(() => __buildReopenPlan({})).toThrow();
  });
});

describe('reopenTask — commit', () => {
  it('writes the reset and appends one decision entry', async () => {
    const res = await reopenTask({ task: { id: 't1', status: 'confirmed', completed: true, timerMinutes: 30 } }, { actor: HUMAN, mode: MODES.COMMIT, reason: 'reverted to active' });
    expect(taskUpdate().status).toBe('pending');
    expect(taskUpdate().timerStatus).toBe('paused');
    const decision = decisionWrite();
    expect(decision).toMatchObject({ command: 'reopenTask', targetId: 't1', actorId: 'mgr1', after: { status: 'pending', completed: false } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED — nothing is written', async () => {
    const res = await reopenTask({ task: { id: 't1', timerMinutes: 0 } }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown (no audit)', async () => {
    updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(reopenTask({ task: { id: 't1', timerMinutes: 0 } }, { actor: HUMAN, mode: MODES.COMMIT })).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.reopenTask' });
    expect(setDoc).not.toHaveBeenCalled();
  });
});
