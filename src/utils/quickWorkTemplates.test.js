import { describe, it, expect } from 'vitest';
import {
    QUICK_WORK_BUILTIN_TEMPLATES,
    HELP_TITLE_PREFIX,
    MAX_USER_TEMPLATES,
    MAX_TEMPLATE_LABEL,
    normalizeUserTemplates,
    userTemplateToOption,
    buildTemplateOptions,
    resolveQuickWorkEntry,
    canSubmitQuickWork,
} from './quickWorkTemplates';

describe('normalizeUserTemplates', () => {
    it('trims, collapses inner whitespace, and drops blanks', () => {
        expect(normalizeUserTemplates(['  Sandėlis  ', '', '   ', 'Du   tarpai']))
            .toEqual(['Sandėlis', 'Du tarpai']);
    });

    it('de-duplicates case-insensitively, keeping first occurrence', () => {
        expect(normalizeUserTemplates(['Tvarka', 'tvarka', 'TVARKA', 'Kita']))
            .toEqual(['Tvarka', 'Kita']);
    });

    it('caps the count at MAX_USER_TEMPLATES', () => {
        const many = Array.from({ length: MAX_USER_TEMPLATES + 5 }, (_, i) => `T${i}`);
        expect(normalizeUserTemplates(many)).toHaveLength(MAX_USER_TEMPLATES);
    });

    it('caps each label length at MAX_TEMPLATE_LABEL', () => {
        const [out] = normalizeUserTemplates(['x'.repeat(MAX_TEMPLATE_LABEL + 20)]);
        expect(out).toHaveLength(MAX_TEMPLATE_LABEL);
    });

    it('returns [] for non-array / malformed input', () => {
        expect(normalizeUserTemplates(undefined)).toEqual([]);
        expect(normalizeUserTemplates(null)).toEqual([]);
        expect(normalizeUserTemplates('Tvarka')).toEqual([]);
    });
});

describe('userTemplateToOption / buildTemplateOptions', () => {
    it('namespaces custom ids so they cannot collide with built-ins', () => {
        expect(userTemplateToOption('Sandėlis')).toEqual({ id: 'custom:Sandėlis', label: 'Sandėlis', custom: true });
    });

    it('lists built-ins first, then sanitised user templates', () => {
        const opts = buildTemplateOptions(['Sandėlis', 'sandėlis', '  ']);
        expect(opts.slice(0, QUICK_WORK_BUILTIN_TEMPLATES.length)).toEqual(QUICK_WORK_BUILTIN_TEMPLATES);
        expect(opts.filter((o) => o.custom)).toEqual([{ id: 'custom:Sandėlis', label: 'Sandėlis', custom: true }]);
    });

    it('keeps a help template in the built-in set', () => {
        expect(QUICK_WORK_BUILTIN_TEMPLATES.some((t) => t.kind === 'help')).toBe(true);
    });
});

describe('resolveQuickWorkEntry', () => {
    it('with no template, the typed text IS the title and there is no comment', () => {
        expect(resolveQuickWorkEntry({ template: null, text: '  Ploviau langus ' }))
            .toEqual({ title: 'Ploviau langus', comment: null });
    });

    it('with a static template, the label is the title and the text is the comment', () => {
        expect(resolveQuickWorkEntry({ template: { label: 'Tvarkos' }, text: '  rakinau garažą ' }))
            .toEqual({ title: 'Tvarkos', comment: 'rakinau garažą' });
    });

    it('a template with empty text yields a null comment', () => {
        expect(resolveQuickWorkEntry({ template: { label: 'Auto darbai' }, text: '   ' }))
            .toEqual({ title: 'Auto darbai', comment: null });
    });

    it('the help template prefixes the chosen member name', () => {
        expect(resolveQuickWorkEntry({ template: { label: 'Pagalba', kind: 'help' }, helpName: 'Jonas K.', text: 'krovėm' }))
            .toEqual({ title: `${HELP_TITLE_PREFIX}Jonas K.`, comment: 'krovėm' });
    });

    it('help with no member falls back to the bare label (never a dangling prefix)', () => {
        expect(resolveQuickWorkEntry({ template: { label: 'Pagalba', kind: 'help' }, helpName: '', text: '' }))
            .toEqual({ title: 'Pagalba', comment: null });
    });
});

describe('canSubmitQuickWork', () => {
    it('free-write requires non-empty text', () => {
        expect(canSubmitQuickWork({ template: null, text: '' })).toBe(false);
        expect(canSubmitQuickWork({ template: null, text: '   ' })).toBe(false);
        expect(canSubmitQuickWork({ template: null, text: 'ką nors' })).toBe(true);
    });

    it('a static template is always submittable (comment optional)', () => {
        expect(canSubmitQuickWork({ template: { label: 'Tvarkos' }, text: '' })).toBe(true);
    });

    it('the help template needs a chosen member', () => {
        expect(canSubmitQuickWork({ template: { label: 'Pagalba', kind: 'help' }, helpUserId: '' })).toBe(false);
        expect(canSubmitQuickWork({ template: { label: 'Pagalba', kind: 'help' }, helpUserId: 'u2' })).toBe(true);
    });
});
