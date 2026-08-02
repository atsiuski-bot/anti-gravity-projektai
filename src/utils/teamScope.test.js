import { describe, it, expect } from 'vitest';
import { canSeeWholeTeam, isScopedOverseer, isOverseenBy, overseerRecipients, scopeRoster } from './teamScope';

// These pure predicates back the scoped-overseer boundary in the security-sensitive client surfaces:
// ActiveWorkSessions' force-end control and (audit R-08) the ManagerNotifications calendar bell, whose
// scopedCalendarNotifications filter is `canSeeWholeTeam(userData) ? all : n.userId === uid ||
// isOverseenBy(usersMap[n.userId], uid)`. The server rules are the real boundary; these keep the client
// from listing a row it could not dismiss (and from hiding one it could).

// overseerRecipients answers "who may settle a person-level decision about this user" (ADR 0025's
// refused-gap claim). It must agree with isOverseenBy's precedence: notifying somebody the RULES would
// not let read the underlying row produces a card they cannot act on.
describe('teamScope — overseerRecipients', () => {
    it('prefers the stamped closure', () => {
        expect(overseerRecipients({ overseerIds: ['m1', 'snr1'], teamManagerIds: ['m2'] }))
            .toEqual(['m1', 'snr1']);
    });
    it('falls back to the union of the direct fields before the closure exists', () => {
        expect(overseerRecipients({ teamManagerIds: ['m1'], seniorManagerIds: ['snr1'] }))
            .toEqual(['m1', 'snr1']);
    });
    it('falls back to the legacy defaultManager last', () => {
        expect(overseerRecipients({ defaultManager: 'm9' })).toEqual(['m9']);
    });
    it('de-duplicates and drops empties', () => {
        expect(overseerRecipients({ teamManagerIds: ['m1', 'm1', ''], seniorManagerIds: ['m1'] }))
            .toEqual(['m1']);
    });
    it('returns an empty array — never null — when there is nobody above the user', () => {
        // The caller must be able to distinguish "escalated" from "reached nobody"; a null here would
        // crash the notify fan-out instead.
        expect(overseerRecipients({})).toEqual([]);
        expect(overseerRecipients(null)).toEqual([]);
    });
    it('agrees with isOverseenBy on the same user doc', () => {
        const target = { teamManagerIds: ['m1'], seniorManagerIds: ['snr1'] };
        for (const uid of overseerRecipients(target)) {
            expect(isOverseenBy(target, uid)).toBe(true);
        }
    });
});

describe('teamScope — canSeeWholeTeam', () => {
    it('admins and UNSCOPED managers see the whole team', () => {
        expect(canSeeWholeTeam({ role: 'admin' })).toBe(true);
        expect(canSeeWholeTeam({ role: 'manager' })).toBe(true);
        expect(canSeeWholeTeam({ role: 'manager', scopedManager: false })).toBe(true);
    });
    it('scoped managers, senior managers, and workers do NOT', () => {
        expect(canSeeWholeTeam({ role: 'manager', scopedManager: true })).toBe(false);
        expect(canSeeWholeTeam({ role: 'seniorManager' })).toBe(false);
        expect(canSeeWholeTeam({ role: 'worker' })).toBe(false);
        expect(canSeeWholeTeam(null)).toBe(false);
    });
});

describe('teamScope — isScopedOverseer', () => {
    it('is true for a scoped manager or a senior manager, false otherwise', () => {
        expect(isScopedOverseer({ role: 'manager', scopedManager: true })).toBe(true);
        expect(isScopedOverseer({ role: 'seniorManager' })).toBe(true);
        expect(isScopedOverseer({ role: 'manager' })).toBe(false);
        expect(isScopedOverseer({ role: 'admin' })).toBe(false);
    });
});

describe('teamScope — isOverseenBy (the calendar-notification scope predicate)', () => {
    it('true when the viewer is in the target overseer closure', () => {
        expect(isOverseenBy({ overseerIds: ['mgr-1', 'snr-1'] }, 'mgr-1')).toBe(true);
    });
    it('false when the viewer is outside the closure', () => {
        expect(isOverseenBy({ overseerIds: ['mgr-1'] }, 'mgr-2')).toBe(false);
    });
    it('falls back to direct membership before the CF stamps the closure', () => {
        expect(isOverseenBy({ teamManagerIds: ['mgr-1'] }, 'mgr-1')).toBe(true);
        expect(isOverseenBy({ seniorManagerIds: ['snr-1'] }, 'snr-1')).toBe(true);
    });
    it('a populated closure wins over direct fields (does not fall back)', () => {
        // overseerIds present + non-empty → the direct fields are ignored.
        expect(isOverseenBy({ overseerIds: ['mgr-1'], teamManagerIds: ['mgr-2'] }, 'mgr-2')).toBe(false);
    });
    it('is fail-closed for a missing target — the roster-miss case (usersMap[uid] === undefined)', () => {
        expect(isOverseenBy(undefined, 'mgr-1')).toBe(false);
        expect(isOverseenBy(null, 'mgr-1')).toBe(false);
        expect(isOverseenBy({ overseerIds: ['mgr-1'] }, undefined)).toBe(false);
    });
});

describe('teamScope — scopeRoster', () => {
    const users = [
        { id: 'w-in', overseerIds: ['mgr-1'] },
        { id: 'w-out', overseerIds: ['mgr-2'] },
        { id: 'mgr-1' },
    ];
    it('returns everyone for a whole-team viewer', () => {
        expect(scopeRoster(users, { role: 'admin' }, 'admin-1')).toHaveLength(3);
    });
    it('returns subtree members plus self for a scoped overseer', () => {
        const scoped = scopeRoster(users, { role: 'manager', scopedManager: true }, 'mgr-1');
        expect(scoped.map(u => u.id).sort()).toEqual(['mgr-1', 'w-in']);
    });
});
