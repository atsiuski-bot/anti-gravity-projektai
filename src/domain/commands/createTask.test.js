import { describe, it, expect, vi, beforeEach } from 'vitest';

// Integration test: createTask -> real kernel -> real decisionLog, against in-memory Firestore fakes.
// timeUtils + priority are kept REAL (pure) so canonicalization is genuinely exercised.
vi.mock('../../firebase', () => ({ db: {}, auth: {} }));

let mintCounter = 0;
vi.mock('firebase/firestore', () => ({
  // doc(collectionRef) mints an id; doc(db, col, id) addresses an existing path.
  doc: vi.fn((...args) => {
    if (args.length === 1) {
      const col = (args[0] && args[0]._col) || 'unknown';
      const id = `mintedId_${mintCounter++}`;
      return { _path: `${col}/${id}`, _col: col, _id: id, id };
    }
    const [, col, id] = args;
    return { _path: `${col}/${id}`, _col: col, _id: id, id };
  }),
  collection: vi.fn((_db, name) => ({ _col: name })),
  setDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../utils/errorLog', () => ({ logError: vi.fn() }));

import { setDoc } from 'firebase/firestore';
import { logError } from '../../utils/errorLog';
import { createTask, __buildCreatePlan } from './createTask';
import { MODES } from '../command';
import { humanActor, agentActor } from '../actor';

const HUMAN = humanActor({ uid: 'mgr1', displayName: 'Manager', role: 'manager' });
const AGENT = agentActor({ id: 'ag:create', kind: 'planner' });

const taskWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'tasks');
const decisionWrite = () => setDoc.mock.calls.find(([ref]) => ref && ref._col === 'decision_log')?.[1];

beforeEach(() => {
  vi.clearAllMocks();
  setDoc.mockResolvedValue(undefined);
});

describe('createTask — plan', () => {
  it('canonicalizes priority + estimate, mints an id, and stamps provenance from the actor', () => {
    const p = __buildCreatePlan({ fields: { title: '  Roof  ', priority: 'medium', estimatedTime: '2h', assignedUserId: 'w2' } }, HUMAN);
    expect(typeof p.targetId).toBe('string');
    expect(p.payload.title).toBe('Roof');
    expect(p.payload.priority).toBe('MEDIUM');         // normalized to canonical uppercase
    expect(p.payload.estimatedTimeMinutes).toBe(120);  // parsed from "2h"
    expect(p.payload.assignedUserId).toBe('w2');
    expect(p.payload.status).toBe('pending');          // default
    expect(p.payload.completed).toBe(false);
    expect(p.payload.createdBy).toBe('mgr1');          // from the actor, not the fields
    expect(p.payload.creatorName).toBe('Manager');
    expect(Array.isArray(p.payload.comments)).toBe(true);
    expect(p.after).toEqual({ assignedUserId: 'w2', title: 'Roof', status: 'pending' });
  });

  it('never persists assignedUserName (read-derived) and defaults a blank title', () => {
    const p = __buildCreatePlan({ fields: { assignedUserName: 'Ghost', assignedUserId: 'w2' } }, HUMAN);
    expect('assignedUserName' in p.payload).toBe(false);
    expect(p.payload.title).toBe('Veikla'); // blank -> default
  });

  it('preserves a caller-provided status and auditor', () => {
    const p = __buildCreatePlan({ fields: { title: 'X', estimatedTime: '1h', status: 'unapproved', taskAuditor: 'mgrX' } }, HUMAN);
    expect(p.payload.status).toBe('unapproved');
    expect(p.payload.taskAuditor).toBe('mgrX');
  });
});

describe('createTask — propose (no writes)', () => {
  it('a human proposal returns the plan and writes nothing', async () => {
    const res = await createTask({ fields: { title: 'X', estimatedTime: '1h', assignedUserId: 'w2' } }, { actor: HUMAN, mode: MODES.PROPOSE });
    expect(res).toMatchObject({ ok: true, mode: 'propose', command: 'createTask' });
    expect(res.proposal.after.title).toBe('X');
    expect(setDoc).not.toHaveBeenCalled();
  });
});

describe('createTask — commit', () => {
  it('writes the task doc and appends one decision entry, returning the new id', async () => {
    const res = await createTask(
      { fields: { title: 'New job', estimatedTime: '30min', assignedUserId: 'w2', status: 'pending' } },
      { actor: HUMAN, mode: MODES.COMMIT, idempotencyKey: 'op_create_1', reason: 'created via task editor' },
    );

    const [ref, payload] = taskWrite();
    expect(ref._col).toBe('tasks');
    expect(payload.title).toBe('New job');
    expect(payload.assignedUserId).toBe('w2');
    expect(payload.createdBy).toBe('mgr1');

    const decision = decisionWrite();
    expect(decision).toMatchObject({
      command: 'createTask', targetType: 'task', actorType: 'human', actorId: 'mgr1',
      before: null, after: { assignedUserId: 'w2', title: 'New job', status: 'pending' },
    });
    expect(decision.targetId).toBe(res.targetId); // audit names the real new id
    expect(res).toMatchObject({ ok: true, mode: 'commit' });
    expect(typeof res.targetId).toBe('string');
  });

  it('an AGENT commit is REFUSED (human-only boundary) — nothing is written', async () => {
    const res = await createTask({ fields: { title: 'X', estimatedTime: '1h' } }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(res.reason).toMatch(/agent-commit-not-permitted/);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('a failed task write is durably logged and rethrown (no audit)', async () => {
    setDoc.mockRejectedValueOnce(new Error('permission-denied'));
    await expect(
      createTask({ fields: { title: 'X', estimatedTime: '1h' } }, { actor: HUMAN, mode: MODES.COMMIT }),
    ).rejects.toThrow('permission-denied');
    expect(logError).toHaveBeenCalledWith(expect.any(Error), { source: 'commands.createTask' });
    // only the (failed) task write was attempted; the audit setDoc was never reached
    expect(setDoc.mock.calls.filter(([ref]) => ref && ref._col === 'decision_log')).toHaveLength(0);
  });
});
