import { describe, it, expect } from 'vitest';
import {
  ACTOR_TYPES,
  humanActor,
  agentActor,
  systemActor,
  isHuman,
  isAgent,
  isSystem,
  actorStamp,
} from './actor';

describe('actor model', () => {
  it('builds a human actor from a signed-in user, preferring displayName', () => {
    const a = humanActor({ uid: 'u1', displayName: 'Giedrius', email: 'g@x.lt', role: 'worker' });
    expect(a).toMatchObject({ type: ACTOR_TYPES.HUMAN, id: 'u1', name: 'Giedrius', role: 'worker' });
    expect(isHuman(a)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it('falls back to email then a generic name when displayName is absent', () => {
    expect(humanActor({ uid: 'u1', email: 'g@x.lt' }).name).toBe('g@x.lt');
    expect(humanActor({ uid: 'u1' }).name).toBe('User');
  });

  it('throws when a human actor has no uid', () => {
    expect(() => humanActor(null)).toThrow();
    expect(() => humanActor({})).toThrow();
  });

  it('builds an agent actor with its own principal id and kind', () => {
    const a = agentActor({ id: 'agent:assign-1', kind: 'assignment-planner' });
    expect(a).toMatchObject({ type: ACTOR_TYPES.AGENT, id: 'agent:assign-1', kind: 'assignment-planner' });
    expect(isAgent(a)).toBe(true);
  });

  it('throws when an agent actor has no principal id', () => {
    expect(() => agentActor({})).toThrow();
    expect(() => agentActor()).toThrow();
  });

  it('builds a system actor from a source name', () => {
    const a = systemActor('dailyIntegrityScan');
    expect(a).toMatchObject({ type: ACTOR_TYPES.SYSTEM, id: 'dailyIntegrityScan' });
    expect(isSystem(a)).toBe(true);
  });

  describe('actorStamp', () => {
    it('flattens a human actor into the audit stamp (no kind)', () => {
      const stamp = actorStamp(humanActor({ uid: 'u1', displayName: 'A' }));
      expect(stamp).toEqual({ actorType: 'human', actorId: 'u1', actorName: 'A' });
    });

    it('includes actorKind only for an agent', () => {
      const stamp = actorStamp(agentActor({ id: 'ag1', kind: 'assignment-planner' }));
      expect(stamp).toEqual({
        actorType: 'agent',
        actorId: 'ag1',
        actorName: 'assignment-planner',
        actorKind: 'assignment-planner',
      });
    });

    it('throws on an invalid actor', () => {
      expect(() => actorStamp(null)).toThrow();
      expect(() => actorStamp({ type: 'human' })).toThrow(); // no id
    });
  });
});
