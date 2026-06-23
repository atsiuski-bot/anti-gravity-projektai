import { describe, it, expect, vi, beforeEach } from 'vitest';

// normalizePriority is kept REAL (pure) so canonicalization is genuinely exercised.
vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  updateDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc, setDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { reprioritizeTask, __buildReprioritizePlan } from './reprioritizeTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const HUMAN = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:prio', kind: 'triage' });
const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
});

describe('reprioritizeTask — plan', () => {
  it('canonicalizes the new + old priority and captures before/after', () => {
    const p = __buildReprioritizePlan({ task: { id: 't1', title: 'X', priority: 'Medium' }, priority: 'urgent' });
    expect(p.payload.priority).toBe('URGENT');
    expect(p.before).toEqual({ priority: 'MEDIUM' });
    expect(p.after).toEqual({ priority: 'URGENT' });
    expect(p.noop).toBe(false);
  });

  it('flags a no-op when the priority is unchanged (after canonicalization)', () => {
    expect(__buildReprioritizePlan({ task: { id: 't1', priority: 'HIGH' }, priority: 'high' }).noop).toBe(true);
  });

  it('rejects a missing task', () => {
    expect(() => __buildReprioritizePlan({ priority: 'HIGH' })).toThrow();
  });
});

describe('reprioritizeTask — commit', () => {
  it('writes only priority + updatedAt and appends one decision entry', async () => {
    const res = await reprioritizeTask({ task: { id: 't1', priority: 'LOW' }, priority: 'urgent' }, { actor: HUMAN, mode: MODES.COMMIT, reason: 'triage' });
    const upd = taskUpdate();
    expect(upd.priority).toBe('URGENT');
    expect(Object.keys(upd).sort()).toEqual(['priority', 'updatedAt']);
    expect(res).toMatchObject({ ok: true, mode: 'commit', targetId: 't1' });
  });

  it('an AGENT commit is REFUSED', async () => {
    const res = await reprioritizeTask({ task: { id: 't1', priority: 'LOW' }, priority: 'HIGH' }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('an AGENT may PROPOSE (no write)', async () => {
    const res = await reprioritizeTask({ task: { id: 't1', priority: 'LOW' }, priority: 'HIGH' }, { actor: AGENT, mode: MODES.PROPOSE });
    expect(res).toMatchObject({ ok: true, mode: 'propose' });
    expect(res.proposal.after).toEqual({ priority: 'HIGH' });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown', async () => {
    updateDoc.mockRejectedValueOnce(new Error('offline'));
    await expect(reprioritizeTask({ task: { id: 't1', priority: 'LOW' }, priority: 'HIGH' }, { actor: HUMAN, mode: MODES.COMMIT })).rejects.toThrow('offline');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.reprioritizeTask' });
  });
});
