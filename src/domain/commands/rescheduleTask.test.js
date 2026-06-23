import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  updateDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { rescheduleTask, __buildReschedulePlan } from './rescheduleTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const HUMAN = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:resched', kind: 'triage' });
const taskUpdate = () => updateDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
});

describe('rescheduleTask — plan', () => {
  it('captures before/after deadline', () => {
    const p = __buildReschedulePlan({ task: { id: 't1', deadline: '2026-06-25' }, deadline: '2026-06-30' });
    expect(p.payload.deadline).toBe('2026-06-30');
    expect(p.before).toEqual({ deadline: '2026-06-25' });
    expect(p.after).toEqual({ deadline: '2026-06-30' });
    expect(p.noop).toBe(false);
  });

  it('clearing the deadline ("") is supported and flagged no-op only when already empty', () => {
    expect(__buildReschedulePlan({ task: { id: 't1', deadline: '2026-06-25' }, deadline: '' }).payload.deadline).toBe('');
    expect(__buildReschedulePlan({ task: { id: 't1' }, deadline: '' }).noop).toBe(true);
  });

  it('rejects a missing task', () => {
    expect(() => __buildReschedulePlan({ deadline: '2026-06-30' })).toThrow();
  });
});

describe('rescheduleTask — commit', () => {
  it('writes only deadline + updatedAt', async () => {
    await rescheduleTask({ task: { id: 't1', deadline: '' }, deadline: '2026-07-01' }, { actor: HUMAN, mode: MODES.COMMIT, reason: 'reschedule' });
    const upd = taskUpdate();
    expect(upd.deadline).toBe('2026-07-01');
    expect(Object.keys(upd).sort()).toEqual(['deadline', 'updatedAt']);
  });

  it('an AGENT commit is REFUSED; PROPOSE is allowed', async () => {
    expect((await rescheduleTask({ task: { id: 't1' }, deadline: '2026-07-01' }, { actor: AGENT, mode: MODES.COMMIT })).refused).toBe(true);
    expect((await rescheduleTask({ task: { id: 't1' }, deadline: '2026-07-01' }, { actor: AGENT, mode: MODES.PROPOSE })).ok).toBe(true);
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('a failed write is durably logged and rethrown', async () => {
    updateDoc.mockRejectedValueOnce(new Error('offline'));
    await expect(rescheduleTask({ task: { id: 't1' }, deadline: '2026-07-01' }, { actor: HUMAN, mode: MODES.COMMIT })).rejects.toThrow('offline');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.rescheduleTask' });
  });
});
