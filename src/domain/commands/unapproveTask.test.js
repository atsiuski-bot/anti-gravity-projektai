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
import { unapproveTask, __buildUnapprovePlan } from './unapproveTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MGR = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:ua', kind: 'planner' });
const APPROVED = { id: 't1', title: 'Roof', status: 'approved', isApproved: true };

const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('unapproveTask — plan', () => {
  it('restores the prior status + isApproved (captured before the approve)', () => {
    const p = __buildUnapprovePlan({ task: APPROVED, priorStatus: 'unapproved', priorIsApproved: false });
    expect(p.before).toEqual({ status: 'approved', isApproved: true });
    expect(p.after).toEqual({ status: 'unapproved', isApproved: false });
  });
  it('defaults a missing prior status to pending', () => {
    expect(__buildUnapprovePlan({ task: APPROVED }).after).toEqual({ status: 'pending', isApproved: false });
  });
  it('rejects a missing task', () => { expect(() => __buildUnapprovePlan({})).toThrow(); });
});

describe('unapproveTask — commit', () => {
  it('restores prior + clears approvedAt/approvedBy + appends one decision entry', async () => {
    const res = await unapproveTask({ task: APPROVED, priorStatus: 'unapproved', priorIsApproved: false }, { actor: MGR, mode: MODES.COMMIT, reason: 'approval undone' });
    const upd = taskUpdate();
    expect(upd).toMatchObject({ status: 'unapproved', isApproved: false, approvedAt: null, approvedBy: null });
    expect(decisionWrite()).toMatchObject({ command: 'unapproveTask', targetId: 't1', after: { status: 'unapproved', isApproved: false } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED', async () => {
    const res = await unapproveTask({ task: APPROVED, priorStatus: 'unapproved' }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown', async () => {
    updateDoc.mockRejectedValueOnce(new Error('offline'));
    await expect(unapproveTask({ task: APPROVED, priorStatus: 'unapproved' }, { actor: MGR, mode: MODES.COMMIT })).rejects.toThrow('offline');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.unapproveTask' });
  });
});
