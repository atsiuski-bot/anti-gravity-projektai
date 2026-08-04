import { describe, it, expect } from 'vitest';
import {
    APP_INSTANCE_ID,
    DEVICE_ID,
    isOwnedByThisDevice,
    isOwnedByThisInstance,
} from './appInstance';

// Two identities live in one stamped string, and they answer different questions. Getting the split
// wrong is expensive in both directions: too coarse and a bystander tab beats a run it merely
// watches (ghost minutes reach pay); too fine and every sign-in on a second device stops the timer
// the worker is running on their phone (the reported incident). These pin both edges.

describe('the composed owner — device identity under instance identity', () => {
    it('carries the persisted device segment ahead of the per-boot one', () => {
        expect(APP_INSTANCE_ID.startsWith(`${DEVICE_ID}::`)).toBe(true);
        expect(DEVICE_ID).not.toContain('::');
    });

    it('treats its own stamp as both this instance and this device', () => {
        expect(isOwnedByThisInstance(APP_INSTANCE_ID)).toBe(true);
        expect(isOwnedByThisDevice(APP_INSTANCE_ID)).toBe(true);
    });

    it('recognises an EARLIER BOOT of this device as the same device, but not the same instance', () => {
        // This is the whole point of persisting the device segment: a reload or PWA restart must
        // still be able to recover the run it left behind.
        const previousBoot = `${DEVICE_ID}::inst_earlier_boot`;
        expect(isOwnedByThisDevice(previousBoot)).toBe(true);
        expect(isOwnedByThisInstance(previousBoot)).toBe(false);
    });

    it('does NOT claim a run anchored by another device', () => {
        const phone = 'dev_some_phone::inst_abc';
        expect(isOwnedByThisDevice(phone)).toBe(false);
        expect(isOwnedByThisInstance(phone)).toBe(false);
    });

    it('does NOT claim an unstamped run — unprovable ownership is not ownership', () => {
        // Runs anchored before this scheme. Recovery must decline rather than guess, because the
        // wrong guess stops a timer somebody is actively running.
        for (const absent of [undefined, null, '']) {
            expect(isOwnedByThisDevice(absent)).toBe(false);
            expect(isOwnedByThisInstance(absent)).toBe(false);
        }
    });

    it('is not fooled by a device id that merely PREFIXES ours', () => {
        // Matching on the split segment, not a startsWith, so `dev_ab` never matches `dev_abc`.
        expect(isOwnedByThisDevice(`${DEVICE_ID}x::inst_1`)).toBe(false);
        expect(isOwnedByThisDevice(DEVICE_ID.slice(0, -1))).toBe(false);
    });
});
