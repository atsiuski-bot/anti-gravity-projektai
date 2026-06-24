import { describe, it, expect } from 'vitest';
import { filterSortUsers } from './UserManagement';

// filterSortUsers is the pure roster-triage pipeline: quick-filter -> fuzzy search (name+email,
// diacritic-folding, typo-tolerant via the shared task-search core) -> sort. Without a query the
// default sort floats pending approvals then brand-new joiners; with a query it sorts by relevance.

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 24 * 60 * 60 * 1000).toISOString();

const users = [
    { id: 'u1', displayName: 'Jonas Jonaitis', email: 'jonas@example.com', role: 'worker', createdAt: daysAgo(200) },
    { id: 'u2', displayName: 'Ona Žemaitė', email: 'ona@example.com', role: 'manager', createdAt: daysAgo(200) },
    { id: 'u3', displayName: 'Petras Naujokas', email: 'petras@example.com', role: 'worker', createdAt: daysAgo(2) }, // new
    { id: 'u4', displayName: 'Pending Pete', email: 'pp@example.com', role: 'worker', isDisabled: true, status: 'pending', createdAt: daysAgo(1) },
    { id: 'u5', displayName: 'Blocked Bob', email: 'bob@example.com', role: 'worker', isDisabled: true, createdAt: daysAgo(200) },
    { id: 'u6', displayName: 'Admin Ann', email: 'ann@example.com', role: 'admin', createdAt: daysAgo(200) },
];

describe('filterSortUsers — default sort (no query)', () => {
    it('floats pending approvals first, then brand-new workers', () => {
        const out = filterSortUsers(users, '', 'all');
        // u4 pending => first; u3 new worker => second.
        expect(out[0].id).toBe('u4');
        expect(out[1].id).toBe('u3');
    });

    it('sinks blocked (non-pending) accounts to the bottom', () => {
        const out = filterSortUsers(users, '', 'all');
        expect(out[out.length - 1].id).toBe('u5');
    });

    it('keeps document order within a band (stable sort)', () => {
        // u1, u2, u6 are all the "rest" band; they keep their incoming relative order.
        const rest = filterSortUsers(users, '', 'all').filter((u) => ['u1', 'u2', 'u6'].includes(u.id));
        expect(rest.map((u) => u.id)).toEqual(['u1', 'u2', 'u6']);
    });
});

describe('filterSortUsers — quick filters', () => {
    it('workers filter keeps only role === worker', () => {
        const out = filterSortUsers(users, '', 'workers');
        expect(out.every((u) => u.role === 'worker')).toBe(true);
        expect(out.map((u) => u.id).sort()).toEqual(['u1', 'u3', 'u4', 'u5']);
    });

    it('managers filter keeps manager, seniorManager and admin', () => {
        const out = filterSortUsers(users, '', 'managers');
        expect(out.map((u) => u.id).sort()).toEqual(['u2', 'u6']);
    });

    it('pending filter keeps only pending accounts', () => {
        const out = filterSortUsers(users, '', 'pending');
        expect(out.map((u) => u.id)).toEqual(['u4']);
    });

    it('blocked filter keeps blocked but NOT pending accounts', () => {
        const out = filterSortUsers(users, '', 'blocked');
        expect(out.map((u) => u.id)).toEqual(['u5']);
    });
});

describe('filterSortUsers — search', () => {
    it('matches by display name', () => {
        const out = filterSortUsers(users, 'jonas', 'all');
        expect(out.map((u) => u.id)).toContain('u1');
        expect(out.every((u) => u.id === 'u1')).toBe(true);
    });

    it('matches by email', () => {
        const out = filterSortUsers(users, 'ann@example', 'all');
        expect(out.map((u) => u.id)).toEqual(['u6']);
    });

    it('is diacritic-insensitive (zemaite finds Žemaitė)', () => {
        const out = filterSortUsers(users, 'zemaite', 'all');
        expect(out.map((u) => u.id)).toEqual(['u2']);
    });

    it('is typo-tolerant (jonais ~ Jonaitis)', () => {
        const out = filterSortUsers(users, 'jonais', 'all');
        expect(out.map((u) => u.id)).toContain('u1');
    });

    it('search composes with a quick filter (AND)', () => {
        // "pe" matches Petras (worker) and Pending Pete (worker) by name; managers filter excludes both.
        const out = filterSortUsers(users, 'pe', 'managers');
        expect(out).toHaveLength(0);
    });

    it('returns an empty array when nothing matches', () => {
        expect(filterSortUsers(users, 'zzzznomatch', 'all')).toHaveLength(0);
    });
});
