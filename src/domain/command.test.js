import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Isolate the KERNEL from the audit sink: mock decisionLog so we assert the kernel's contract
// (mode handling, authorization, idempotency threading, apply ordering) without touching Firestore.
vi.mock('./decisionLog', () => ({
  appendDecision: vi.fn(({ idempotencyKey }) => Promise.resolve({ id: idempotencyKey })),
}));

// Mock the durable crash log so the kernel's defensive audit-catch (which calls logError) does not
// pull the real firebase module graph into this isolated kernel test.
vi.mock('../utils/errorLog', () => ({ logError: vi.fn() }));

import { appendDecision } from './decisionLog';
import { defineCommand, MODES } from './command';
import { humanActor, agentActor } from './actor';
import { setAgentsEnabled } from './agentControl';

const HUMAN = humanActor({ uid: 'u1', displayName: 'A' });
const AGENT = agentActor({ id: 'ag1', kind: 'planner' });

// A trivial command whose plan/apply are spies, so we can watch exactly when each runs.
const makeCmd = (over = {}) => {
  const plan = vi.fn((input) => ({
    targetId: input.id,
    summary: `do ${input.id}`,
    before: { v: 0 },
    after: { v: 1 },
    effect: { id: input.id },
  }));
  const apply = vi.fn(() => Promise.resolve());
  const cmd = defineCommand({ name: 'testCmd', targetType: 'thing', plan, apply, ...over });
  return { cmd, plan, apply };
};

beforeEach(() => vi.clearAllMocks());

describe('defineCommand — construction', () => {
  it('requires name, plan and apply', () => {
    expect(() => defineCommand({ name: 'x', plan: () => {} })).toThrow();
    expect(() => defineCommand({ plan: () => {}, apply: () => {} })).toThrow();
  });
  it('exposes the command name + targetType on the returned runner', () => {
    const { cmd } = makeCmd();
    expect(cmd.commandName).toBe('testCmd');
    expect(cmd.targetType).toBe('thing');
  });
});

describe('defineCommand — actor + mode contract', () => {
  it('requires ctx.actor', async () => {
    const { cmd } = makeCmd();
    await expect(cmd({ id: 't1' }, {})).rejects.toThrow(/actor/);
  });

  it('DEFAULTS to propose: no apply, no audit, returns the plan as a proposal', async () => {
    const { cmd, plan, apply } = makeCmd();
    const res = await cmd({ id: 't1' }, { actor: HUMAN }); // no mode given
    expect(res).toMatchObject({ ok: true, mode: MODES.PROPOSE, command: 'testCmd' });
    expect(res.proposal).toMatchObject({ targetId: 't1', after: { v: 1 } });
    expect(plan).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();
    expect(appendDecision).not.toHaveBeenCalled();
  });

  it('an unrecognised mode is also treated as propose (never writes by accident)', async () => {
    const { cmd, apply } = makeCmd();
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: 'something-else' });
    expect(res.mode).toBe(MODES.PROPOSE);
    expect(apply).not.toHaveBeenCalled();
  });

  it('commit applies the effect THEN appends the audit entry, sharing the same plan', async () => {
    const { cmd, plan, apply } = makeCmd();
    const order = [];
    apply.mockImplementation(() => { order.push('apply'); return Promise.resolve(); });
    appendDecision.mockImplementation(({ idempotencyKey }) => { order.push('audit'); return Promise.resolve({ id: idempotencyKey }); });

    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.COMMIT, idempotencyKey: 'op_1', reason: 'why' });

    expect(plan).toHaveBeenCalledTimes(1); // ONE plan feeds both apply and audit
    expect(order).toEqual(['apply', 'audit']); // effect before audit
    expect(res).toMatchObject({ ok: true, mode: MODES.COMMIT, idempotencyKey: 'op_1', decisionId: 'op_1' });
    expect(appendDecision).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'op_1', command: 'testCmd', targetType: 'thing', targetId: 't1',
      reason: 'why', before: { v: 0 }, after: { v: 1 },
    }));
  });

  it('mints an idempotency key when the caller omits one', async () => {
    const { cmd } = makeCmd();
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.COMMIT });
    expect(res.idempotencyKey).toMatch(/^op_/);
    expect(appendDecision.mock.calls[0][0].idempotencyKey).toBe(res.idempotencyKey);
  });
});

describe('defineCommand — audit failure must NOT abort an applied command (the best-effort guarantee)', () => {
  it('a null (failed) audit append still resolves ok with decisionId:null, effect applied', async () => {
    const { cmd, apply } = makeCmd();
    appendDecision.mockResolvedValueOnce(null); // the audit write failed (e.g. rule not deployed)
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.COMMIT });
    expect(apply).toHaveBeenCalledTimes(1); // the effect was applied
    expect(res).toMatchObject({ ok: true, mode: MODES.COMMIT, decisionId: null });
  });

  it('a THROWN audit append is also tolerated — the kernel owns the never-abort guarantee', async () => {
    // appendDecision is contracted not to throw, but the kernel must survive it if a future change
    // reintroduces a throw: a done effect can never be rolled back by an audit failure.
    const { cmd, apply } = makeCmd();
    appendDecision.mockRejectedValueOnce(new Error('audit blew up'));
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.COMMIT });
    expect(apply).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, mode: MODES.COMMIT, decisionId: null });
  });
});

describe('defineCommand — agent kill-switch (global brake)', () => {
  // The switch is module-global state; restore the brake-off default after each case so the
  // gate cannot leak into the other suites (which run agents through propose/commit freely).
  afterEach(() => setAgentsEnabled(true));

  it('refuses an agent COMMIT when agents are disabled — before authorize/plan/apply run', async () => {
    const authorize = vi.fn(() => true);
    const { cmd, plan, apply } = makeCmd({ authorize });
    setAgentsEnabled(false);
    const res = await cmd({ id: 't1' }, { actor: AGENT, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true, reason: 'AGENTS_DISABLED', command: 'testCmd' });
    expect(authorize).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(appendDecision).not.toHaveBeenCalled();
  });

  it('also refuses an agent PROPOSE when disabled (a killed agent does nothing)', async () => {
    const { cmd, plan } = makeCmd();
    setAgentsEnabled(false);
    const res = await cmd({ id: 't1' }, { actor: AGENT, mode: MODES.PROPOSE });
    expect(res).toMatchObject({ ok: false, refused: true, reason: 'AGENTS_DISABLED' });
    expect(plan).not.toHaveBeenCalled();
  });

  it('does NOT gate human actors when the switch is engaged', async () => {
    const { cmd } = makeCmd();
    setAgentsEnabled(false);
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.PROPOSE });
    expect(res.ok).toBe(true);
  });

  it('lets agents through again once the switch is re-enabled', async () => {
    const { cmd } = makeCmd();
    setAgentsEnabled(false);
    setAgentsEnabled(true);
    const res = await cmd({ id: 't1' }, { actor: AGENT, mode: MODES.PROPOSE });
    expect(res.ok).toBe(true);
  });
});

describe('defineCommand — authorization (soft refusal)', () => {
  it('a string verdict refuses with that reason and writes nothing', async () => {
    const { cmd, plan, apply } = makeCmd({ authorize: () => 'nope, not allowed' });
    const res = await cmd({ id: 't1' }, { actor: HUMAN, mode: MODES.COMMIT });
    expect(res).toMatchObject({ ok: false, refused: true, reason: 'nope, not allowed' });
    expect(plan).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(appendDecision).not.toHaveBeenCalled();
  });

  it('authorize sees the actor and mode (enables agent-may-propose-not-commit policy)', async () => {
    const authorize = vi.fn((_input, { actor, mode }) =>
      actor.type === 'agent' && mode === MODES.COMMIT ? 'agent cannot commit' : true);
    const { cmd, apply } = makeCmd({ authorize });

    // Agent PROPOSE is allowed.
    const proposed = await cmd({ id: 't1' }, { actor: AGENT, mode: MODES.PROPOSE });
    expect(proposed.ok).toBe(true);

    // Agent COMMIT is refused — and never applies.
    const refused = await cmd({ id: 't1' }, { actor: AGENT, mode: MODES.COMMIT });
    expect(refused).toMatchObject({ ok: false, refused: true });
    expect(apply).not.toHaveBeenCalled();
  });
});
