import { describe, it, expect, vi } from 'vitest';

// Only the PURE timeline geometry is under test — the placement math that decides whether a booked
// entry is drawn at all. The component's Firebase/context collaborators are neutralised the same way
// the taskActions / useOrphanedTaskRecovery suites do it; nothing renders here.
vi.mock('../firebase', () => ({ db: {}, auth: {} }));
vi.mock('firebase/firestore', () => ({
    collection: vi.fn(),
    query: vi.fn(),
    where: vi.fn(),
    onSnapshot: vi.fn(),
}));
vi.mock('../context/UsersContext', () => ({ useUsers: () => ({ activeUsers: [], usersMap: {} }) }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({}) }));

import { getEventStyle, eventTimeLabel } from './AllUsersCalendar';

// The shape WorkPlanner writes for every "Nedirbu — visą dieną" booking: local midnight to the NEXT
// local midnight.
const allDay = (y, m, d) => [new Date(y, m - 1, d, 0, 0), new Date(y, m - 1, d + 1, 0, 0)];

describe('getEventStyle — an entry must never be drawn as nothing', () => {
    it('gives an all-day absence the full 07:00–22:00 track (it used to return null)', () => {
        const [start, end] = allDay(2026, 8, 1);
        expect(getEventStyle(start, end)).toEqual({ left: '0%', width: '100%' });
    });

    it('places an ordinary in-window shift proportionally', () => {
        const style = getEventStyle(new Date(2026, 7, 1, 7, 0), new Date(2026, 7, 1, 22, 0));
        expect(style).toEqual({ left: '0%', width: '100%' });
        const half = getEventStyle(new Date(2026, 7, 1, 7, 0), new Date(2026, 7, 1, 14, 30));
        expect(half.left).toBe('0%');
        expect(parseFloat(half.width)).toBeCloseTo(50, 5);
    });

    it('pins a shift lying wholly before the window to the left edge instead of dropping it', () => {
        const style = getEventStyle(new Date(2026, 7, 1, 5, 0), new Date(2026, 7, 1, 6, 0));
        expect(style).not.toBeNull();
        expect(style.left).toBe('0%');
        expect(parseFloat(style.width)).toBeGreaterThan(0);
    });

    it('keeps an edge marker inside the track when the shift is wholly after the window', () => {
        const style = getEventStyle(new Date(2026, 7, 1, 23, 0), new Date(2026, 7, 2, 0, 30));
        expect(style).not.toBeNull();
        expect(parseFloat(style.left) + parseFloat(style.width)).toBeLessThanOrEqual(100);
    });

    it('still rejects a zero-length or inverted span', () => {
        expect(getEventStyle(new Date(2026, 7, 1, 9, 0), new Date(2026, 7, 1, 9, 0))).toBeNull();
        expect(getEventStyle(new Date(2026, 7, 1, 9, 0), new Date(2026, 7, 1, 8, 0))).toBeNull();
    });
});

describe('eventTimeLabel — an all-day absence is named, not clocked', () => {
    it('reads "Visą dieną" instead of 00:00–00:00', () => {
        const [start, end] = allDay(2026, 8, 1);
        expect(eventTimeLabel(start, end)).toBe('Visą dieną');
    });

    it('keeps the clock range for a normal shift', () => {
        expect(eventTimeLabel(new Date(2026, 7, 1, 8, 0), new Date(2026, 7, 1, 16, 30)))
            .toBe('08:00–16:30');
    });
});
