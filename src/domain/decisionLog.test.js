import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocking mirrors the established convention (taskActions / sessionEditActions tests): neutralise
// the firebase module graph and run the WRITE against an in-memory Firestore fake so the exact
// payload + doc path are inspectable; mock errorLog to assert the best-effort durable-log call.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ _path: `${col}/${id}`, _col: col, _id: id })),
  setDoc: vi.fn(() => Promise.resolve()),
}));

vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));

import { doc, setDoc } from 'firebase/firestore';
import { logError } from '../utils/errorLog';
import { appendDecision, DECISION_LOG_COLLECTION } from './decisionLog';
import { humanActor } from './actor';

const ACTOR = humanActor({ uid: 'u1', displayName: 'Audrius', role: 'admin' });

beforeEach(() => {
  vi.clearAllMocks();
  setDoc.mockResolvedValue(undefined);
});

describe('appendDecision', () => {
  it('writes one record keyed by the idempotency key, stamped with the actor', async () => {
    const res = await appendDecision({
      idempotencyKey: 'op_abc',
      command: 'assignTask',
      actor: ACTOR,
      targetType: 'task',
      targetId: 't1',
      reason: 'load balancing',
      before: { assignedUserId: null },
      after: { assignedUserId: 'w1' },
    });

    // doc id is the idempotency key in the decision_log collection.
    expect(doc).toHaveBeenCalledWith({}, DECISION_LOG_COLLECTION, 'op_abc');
    const [, written] = setDoc.mock.calls[0];
    expect(written).toMatchObject({
      actorType: 'human',
      actorId: 'u1',
      actorName: 'Audrius',
      command: 'assignTask',
      targetType: 'task',
      targetId: 't1',
      reason: 'load balancing',
      mode: 'commit',
      correlationId: 'op_abc', // defaults to the idempotency key
    });
    expect(typeof written.ts).toBe('string');
    expect(res).toMatchObject({ id: 'op_abc' });
  });

  it('honours an explicit correlationId', async () => {
    await appendDecision({ idempotencyKey: 'op_1', command: 'c', actor: ACTOR, correlationId: 'batch-77' });
    expect(setDoc.mock.calls[0][1].correlationId).toBe('batch-77');
  });

  it('never throws: a setDoc failure returns null and is sent to the crash log', async () => {
    setDoc.mockRejectedValueOnce(new Error('network'));
    const res = await appendDecision({ idempotencyKey: 'op_x', command: 'assignTask', actor: ACTOR });
    expect(res).toBeNull();
    expect(logError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ source: expect.stringContaining('decisionLog.appendDecision') }),
    );
  });

  it('tags a permission-denied (expected retry/rollout class) distinctly from an unexpected loss', async () => {
    setDoc.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    await appendDecision({ idempotencyKey: 'k1', command: 'assignTask', actor: ACTOR });
    expect(logError).toHaveBeenLastCalledWith(expect.any(Error), { source: 'decisionLog.appendDecision.denied' });

    setDoc.mockRejectedValueOnce(new Error('quota')); // no code -> a genuine, unexpected audit loss
    await appendDecision({ idempotencyKey: 'k2', command: 'assignTask', actor: ACTOR });
    expect(logError).toHaveBeenLastCalledWith(expect.any(Error), { source: 'decisionLog.appendDecision.AUDIT_LOST' });
  });

  it('never throws on invalid input or a malformed actor — returns null and logs', async () => {
    expect(await appendDecision({ command: 'c', actor: ACTOR })).toBeNull(); // missing key
    expect(await appendDecision({ idempotencyKey: 'k', actor: ACTOR })).toBeNull(); // missing command
    // A truthy-but-malformed actor makes actorStamp throw; it must degrade to a logged null, not throw.
    expect(await appendDecision({ idempotencyKey: 'k', command: 'c', actor: { type: 'human' } })).toBeNull();
    expect(logError).toHaveBeenCalled();
  });
});
