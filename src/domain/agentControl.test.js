import { describe, it, expect, afterEach } from 'vitest';
import { areAgentsEnabled, setAgentsEnabled } from './agentControl';

// The kill-switch is module-global; reset to the brake-off default after every case.
afterEach(() => setAgentsEnabled(true));

describe('agentControl — kill-switch state', () => {
  it('defaults to ENABLED (the brake is off until engaged)', () => {
    expect(areAgentsEnabled()).toBe(true);
  });

  it('engages on an explicit false and re-enables on true', () => {
    setAgentsEnabled(false);
    expect(areAgentsEnabled()).toBe(false);
    setAgentsEnabled(true);
    expect(areAgentsEnabled()).toBe(true);
  });

  it('treats a missing/undefined flag as ENABLED (client default = brake off)', () => {
    setAgentsEnabled(false);
    setAgentsEnabled(undefined); // e.g. an absent Firestore doc → enabled
    expect(areAgentsEnabled()).toBe(true);
  });

  it('only an explicit false disables (the listener passes `enabled !== false`)', () => {
    setAgentsEnabled(null);
    expect(areAgentsEnabled()).toBe(true);
  });
});
