/**
 * Registry completeness — every notification type must fully declare its five delivery dimensions, so
 * a half-wired type (e.g. copy but no sound, or a sound key the player doesn't understand) can't ship.
 */
import { describe, it, expect } from 'vitest';
import {
    NOTIFICATIONS,
    NOTIFICATION_TYPES,
    notificationCategory,
    notificationSound,
    notificationCopy,
    notificationLink,
    notificationActions,
    DIRECT_PUSH_ACTIONS,
    directNotificationActions,
} from './registry.js';

const CATEGORIES = new Set(['action', 'info']);
const SOUNDS = new Set(['alert', 'info', null]); // null = silent (none today, but allowed)

describe('notification registry completeness', () => {
    it('has at least the known types', () => {
        expect(NOTIFICATION_TYPES.length).toBeGreaterThanOrEqual(16);
    });

    it.each(Object.keys(NOTIFICATIONS))('"%s" declares all five delivery dimensions', (type) => {
        const entry = NOTIFICATIONS[type];

        expect(CATEGORIES.has(entry.category), `category must be action|info`).toBe(true);
        expect(SOUNDS.has(entry.sound), `sound must be alert|info|null`).toBe(true);
        expect(typeof entry.push, 'push must be a boolean').toBe('boolean');
        expect(typeof entry.link, 'link must be a string').toBe('string');
        expect(entry.link.startsWith('/'), 'link must be an in-app path').toBe(true);
        // Push buttons are OPTIONAL (most types are tap-only), but when declared they must be an
        // array — the accessor promises callers one, and the SW/server mirror both assume it.
        if ('actions' in entry) {
            expect(Array.isArray(entry.actions), 'actions must be an array when declared').toBe(true);
        }

        // copy(n) must produce non-empty Lithuanian strings for a representative payload.
        const { title, body } = entry.copy({
            type,
            taskTitle: 'Pavyzdinė užduotis',
            day: '2026-06-20',
            decision: 'approved',
            commentText: 'pastaba',
            targetUserName: 'Jonas',
        });
        expect(typeof title).toBe('string');
        expect(title.length).toBeGreaterThan(0);
        expect(typeof body).toBe('string');
        expect(body.length).toBeGreaterThan(0);
    });

    // Pushes sent straight from their own collection trigger declare their buttons here instead —
    // they have no registry entry, so nothing above covers them. The client↔server mirror is locked
    // in firebaseConsistency.test.js; this only pins the shape the accessor promises its callers.
    it.each(Object.keys(DIRECT_PUSH_ACTIONS))('direct push type "%s" declares a usable button array', (type) => {
        const actions = DIRECT_PUSH_ACTIONS[type];
        expect(Array.isArray(actions)).toBe(true);
        expect(actions.length).toBeGreaterThan(0);
        for (const a of actions) {
            expect(typeof a.action).toBe('string');
            expect(a.action.length).toBeGreaterThan(0);
            expect(typeof a.title).toBe('string');
            expect(a.title.length).toBeGreaterThan(0);
        }
        expect(directNotificationActions(type)).toEqual(actions);
    });

    it('the helper accessors agree with the map', () => {
        for (const type of Object.keys(NOTIFICATIONS)) {
            expect(notificationCategory(type)).toBe(NOTIFICATIONS[type].category);
            expect(notificationSound(type)).toBe(NOTIFICATIONS[type].sound);
            expect(notificationLink(type)).toBe(NOTIFICATIONS[type].link);
            expect(notificationActions(type)).toEqual(NOTIFICATIONS[type].actions || []);
        }
    });

    it('unknown types degrade safely', () => {
        expect(notificationCategory('made_up')).toBe('info');
        expect(notificationSound('made_up')).toBe(null);
        // An array, never undefined — a tap-only push, not a crash in the SW payload builder.
        expect(notificationActions('made_up')).toEqual([]);
        expect(directNotificationActions('made_up')).toEqual([]);
        expect(notificationCopy({ type: 'made_up', taskTitle: 'X' })).toEqual({
            title: 'Naujas pranešimas',
            body: 'X',
        });
    });
});
