import { describe, it, expect } from 'vitest';
import { canSeeWholeTeam, isScopedOverseer, isOverseenBy, scopeRoster } from './teamScope';

// These pure predicates back the scoped-overseer boundary in the security-sensitive client surfaces:
// ActiveWorkSessions' force-end control and (audit R-08) the ManagerNotifications calendar bell, whose
// scopedCalendarNotifications filter is `canSeeWholeTeam(userData) ? all : n.userId === uid ||
// isOverseenBy(usersMap[n.userId], uid)`. The server rules are the real boundary; these keep the client
// from listing a row it could not dismiss (and from hiding one it could).

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
