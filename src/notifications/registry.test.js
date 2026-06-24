/**
 * Registry completeness — every notification type must fully declare its four delivery dimensions, so
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
} from './registry.js';

const CATEGORIES = new Set(['action', 'info']);
const SOUNDS = new Set(['alert', 'info', null]); // null = silent (none today, but allowed)

describe('notification registry completeness', () => {
    it('has at least the known types', () => {
        expect(NOTIFICATION_TYPES.length).toBeGreaterThanOrEqual(16);
    });

    it.each(Object.keys(NOTIFICATIONS))('"%s" declares all four delivery dimensions', (type) => {
        const entry = NOTIFICATIONS[type];

        expect(CATEGORIES.has(entry.category), `category must be action|info`).toBe(true);
        expect(SOUNDS.has(entry.sound), `sound must be alert|info|null`).toBe(true);
        expect(typeof entry.push, 'push must be a boolean').toBe('boolean');
        expect(typeof entry.link, 'link must be a string').toBe('string');
        expect(entry.link.startsWith('/'), 'link must be an in-app path').toBe(true);

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

    it('the helper accessors agree with the map', () => {
        for (const type of Object.keys(NOTIFICATIONS)) {
            expect(notificationCategory(type)).toBe(NOTIFICATIONS[type].category);
            expect(notificationSound(type)).toBe(NOTIFICATIONS[type].sound);
            expect(notificationLink(type)).toBe(NOTIFICATIONS[type].link);
        }
    });

    it('unknown types degrade safely', () => {
        expect(notificationCategory('made_up')).toBe('info');
        expect(notificationSound('made_up')).toBe(null);
        expect(notificationCopy({ type: 'made_up', taskTitle: 'X' })).toEqual({
            title: 'Naujas pranešimas',
            body: 'X',
        });
    });
});
