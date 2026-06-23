import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  collection: vi.fn((_db, name) => ({ _col: name })),
  query: vi.fn((...args) => args),
  where: vi.fn(() => 'where'),
  updateDoc: vi.fn(() => Promise.resolve()),
  deleteDoc: vi.fn(() => Promise.resolve()),
  setDoc: vi.fn(() => Promise.resolve()),
  getDocs: vi.fn(() => Promise.resolve({ docs: [] })),
}));
vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { updateDoc, deleteDoc, setDoc, getDocs } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { deleteTask, __buildDeletePlan } from './deleteTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const MGR = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:del', kind: 'planner' });
const TASK = { id: 't1', title: 'Roof', status: 'in-progress' };

const updFor = (col) => updateDoc.mock.calls.find(([ref]) => ref && ref._col === col)?.[1];
const deletedPaths = () => deleteDoc.mock.calls.map(([ref]) => ref && ref._path);
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  updateDoc.mockResolvedValue(undefined);
  deleteDoc.mockResolvedValue(undefined);
  setDoc.mockResolvedValue(undefined);
  getDocs.mockResolvedValue({ docs: [] });
});

describe('deleteTask — plan', () => {
  it('captures before/after + the mode', () => {
    expect(__buildDeletePlan({ task: TASK, keepWorkHours: true }).after).toEqual({ isDeleted: true, mode: 'kept-hours' });
    expect(__buildDeletePlan({ task: TASK, keepWorkHours: false }).after).toEqual({ isDeleted: true, mode: 'hard' });
    expect(__buildDeletePlan({ task: TASK }).before).toEqual({ status: 'in-progress', isDeleted: false });
  });
  it('rejects a missing task', () => {
    expect(() => __buildDeletePlan({})).toThrow();
  });
});

describe('deleteTask — soft delete (keepWorkHours)', () => {
  it('marks the active task completed+deleted, auto-confirming for a manager', async () => {
    await deleteTask({ task: TASK, keepWorkHours: true, isManager: true }, { actor: MGR, mode: MODES.COMMIT });
    const upd = updFor('tasks');
    expect(upd).toMatchObject({ status: 'confirmed', completed: true, isDeleted: true, deletedBy: 'mgr1', confirmedBy: 'mgr1', timerStatus: 'stopped' });
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(decisionWrite()).toMatchObject({ command: 'deleteTask', targetId: 't1', after: { isDeleted: true, mode: 'kept-hours' } });
  });

  it('a worker soft-delete lands as completed (no confirmedBy)', async () => {
    await deleteTask({ task: TASK, keepWorkHours: true, isManager: false }, { actor: humanActor({ uid: 'w1', role: 'worker' }), mode: MODES.COMMIT });
    expect(updFor('tasks')).toMatchObject({ status: 'completed', confirmedBy: null });
  });

  it('an already-archived task is soft-deleted in archived_tasks', async () => {
    await deleteTask({ task: { ...TASK, isArchived: true }, keepWorkHours: true, isManager: true }, { actor: MGR, mode: MODES.COMMIT });
    expect(updFor('archived_tasks')).toMatchObject({ status: 'deleted', isDeleted: true });
    expect(updFor('tasks')).toBeUndefined();
  });
});

describe('deleteTask — hard delete', () => {
  it('removes from both collections and marks work_sessions deleted', async () => {
    getDocs.mockResolvedValueOnce({ docs: [{ id: 's1' }, { id: 's2' }] });
    await deleteTask({ task: TASK, keepWorkHours: false, isManager: true }, { actor: MGR, mode: MODES.COMMIT });
    expect(deletedPaths()).toEqual(expect.arrayContaining(['tasks/t1', 'archived_tasks/t1']));
    // both sessions marked deleted
    const sessionUpdates = updateDoc.mock.calls.filter(([ref]) => ref && ref._col === 'work_sessions');
    expect(sessionUpdates).toHaveLength(2);
    expect(sessionUpdates[0][1]).toMatchObject({ isDeleted: true });
    expect(decisionWrite()).toMatchObject({ command: 'deleteTask', after: { mode: 'hard' } });
  });

  it('a session-marking failure does NOT abort the delete (best-effort)', async () => {
    getDocs.mockRejectedValueOnce(new Error('sessions query failed'));
    await expect(deleteTask({ task: TASK, keepWorkHours: false, isManager: true }, { actor: MGR, mode: MODES.COMMIT })).resolves.toMatchObject({ ok: true });
    expect(deletedPaths()).toEqual(expect.arrayContaining(['tasks/t1', 'archived_tasks/t1']));
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.deleteTask.markSessions' });
  });
});

describe('deleteTask — policy + errors', () => {
  it('an AGENT commit is REFUSED — nothing is written', async () => {
    const res = await deleteTask({ task: TASK, keepWorkHours: true, isManager: true }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(updateDoc).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed delete write is durably logged and rethrown (no audit)', async () => {
    deleteDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(deleteTask({ task: TASK, keepWorkHours: false, isManager: true }, { actor: MGR, mode: MODES.COMMIT })).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.deleteTask' });
    expect(setDoc).not.toHaveBeenCalled();
  });
});
