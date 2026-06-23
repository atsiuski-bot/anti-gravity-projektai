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
import { unconfirmTask, __buildUnconfirmPlan } from './unconfirmTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MGR = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:u', kind: 'planner' });
const TASK = { id: 't1', title: 'Roof', status: 'confirmed', confirmedBy: 'mgr1' };

const updFor = (col) => updateDoc.mock.calls.find(([ref]) => ref && ref._col === col)?.[1];
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('unconfirmTask — plan', () => {
  it('captures before/after (back to awaiting confirmation)', () => {
    const p = __buildUnconfirmPlan({ task: TASK });
    expect(p.before).toEqual({ status: 'confirmed', confirmedBy: 'mgr1' });
    expect(p.after).toEqual({ status: 'completed', confirmedBy: null });
  });
  it('rejects a missing task', () => { expect(() => __buildUnconfirmPlan({})).toThrow(); });
});

describe('unconfirmTask — commit', () => {
  it('clears confirmation back to completed + appends one decision entry', async () => {
    const res = await unconfirmTask({ task: TASK }, { actor: MGR, mode: MODES.COMMIT, reason: 'confirm undone' });
    const upd = updFor('tasks');
    expect(upd).toMatchObject({ status: 'completed', confirmedBy: null, confirmedAt: null });
    expect(decisionWrite()).toMatchObject({ command: 'unconfirmTask', targetId: 't1', after: { status: 'completed', confirmedBy: null } });
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED', async () => {
    const res = await unconfirmTask({ task: TASK }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown', async () => {
    updateDoc.mockRejectedValueOnce(new Error('offline'));
    await expect(unconfirmTask({ task: TASK }, { actor: MGR, mode: MODES.COMMIT })).rejects.toThrow('offline');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.unconfirmTask' });
  });
});
