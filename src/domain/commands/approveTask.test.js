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
import { approveTask, __buildApprovePlan } from './approveTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MANAGER = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:approve', kind: 'planner' });

const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('approveTask — plan', () => {
  it('sets the approval gate fields, stamping approvedBy from the actor', () => {
    const p = __buildApprovePlan({ task: { id: 't1', title: 'Roof', status: 'unapproved', isApproved: false } }, MANAGER);
    expect(p.payload).toMatchObject({ status: 'approved', isApproved: true, approvedBy: 'mgr1' });
    expect(typeof p.payload.approvedAt).toBe('string');
    expect(p.before).toEqual({ status: 'unapproved', isApproved: false });
    expect(p.after).toEqual({ status: 'approved', isApproved: true, approvedBy: 'mgr1' });
  });

  it('tolerates a minimal task (id + title only — the notification path)', () => {
    const p = __buildApprovePlan({ task: { id: 't1', title: 'X' } }, MANAGER);
    expect(p.before).toEqual({ status: null, isApproved: false });
  });

  it('rejects a missing task', () => {
    expect(() => __buildApprovePlan({}, MANAGER)).toThrow();
  });
});

describe('approveTask — commit', () => {
  it('writes the approval and appends one decision entry', async () => {
    const res = await approveTask({ task: { id: 't1', title: 'Roof', status: 'unapproved' } }, { actor: MANAGER, mode: MODES.COMMIT, reason: 'approved from task card' });
    expect(taskUpdate()).toMatchObject({ status: 'approved', isApproved: true, approvedBy: 'mgr1' });
    expect(decisionWrite()).toMatchObject({ command: 'approveTask', targetId: 't1', actorId: 'mgr1', after: { status: 'approved', isApproved: true, approvedBy: 'mgr1' } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED — nothing is written', async () => {
    const res = await approveTask({ task: { id: 't1' } }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown (no audit)', async () => {
    updateDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(approveTask({ task: { id: 't1' } }, { actor: MANAGER, mode: MODES.COMMIT })).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.approveTask' });
    expect(setDoc).not.toHaveBeenCalled();
  });
});
