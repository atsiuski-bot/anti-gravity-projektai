/**
 * Quick-work finish templates — the one-tap categories offered when a worker ends a "greitas
 * darbas" session (mirrors the call-classify modal). Picking a template makes its label the
 * session TITLE; the free-text box then becomes an optional COMMENT. With no template picked the
 * typed text is the title itself (the legacy behaviour), so a worker can always free-write.
 *
 * This module is PURE (no React, no Firestore) so the title/comment resolution and the user-
 * template sanitisation are unit-testable and shared by the modal and the profile editor.
 *
 * Data shape:
 *  - Built-in templates are fixed (below). `kind: 'help'` is special: it expands a person picker so
 *    the title reads "Pagalba: <vardas>" rather than a bare label.
 *  - Each worker may add their OWN templates in their profile; they persist as a string[] on
 *    users/{uid}.quickWorkTemplates and are appended to the built-ins at render time.
 */

// The fixed categories every worker sees. Order is the display order. `hint` is the small muted
// sub-label shown under the name. `kind: 'help'` triggers the member picker.
export const QUICK_WORK_BUILTIN_TEMPLATES = [
    { id: 'order', label: 'Tvarkos', hint: 'rakinimai, tvarkymai' },
    { id: 'admin', label: 'Administracija', hint: 'app, susirinkimai' },
    { id: 'auto', label: 'Auto darbai' },
    { id: 'help', label: 'Pagalba', kind: 'help', hint: 'pasirinkite narį' },
];

// Title prefix for the "Pagalba" template once a member is chosen ("Pagalba: Jonas K.").
export const HELP_TITLE_PREFIX = 'Pagalba: ';

// Bounds for the per-user custom templates (keeps the picker tidy and the stored array small).
export const MAX_USER_TEMPLATES = 12;
export const MAX_TEMPLATE_LABEL = 40;

/**
 * Sanitise the raw `quickWorkTemplates` array read off the user doc: trim, collapse inner
 * whitespace, cap label length, drop blanks, de-duplicate case-insensitively, and bound the
 * count. Always returns a plain string[] (never throws on malformed stored data).
 */
export function normalizeUserTemplates(raw) {
    if (!Array.isArray(raw)) return [];
    const seen = new Set();
    const out = [];
    for (const item of raw) {
        const label = String(item ?? '')
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, MAX_TEMPLATE_LABEL);
        if (!label) continue;
        const key = label.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(label);
        if (out.length >= MAX_USER_TEMPLATES) break;
    }
    return out;
}

/**
 * Wrap a user's custom template label in the same option shape as a built-in, so the picker can
 * render both uniformly. Custom ids are namespaced (`custom:<label>`) so they never collide with a
 * built-in id.
 */
export function userTemplateToOption(label) {
    return { id: `custom:${label}`, label, custom: true };
}

/** The full ordered option list shown in the finish modal: built-ins then the user's own. */
export function buildTemplateOptions(userTemplates) {
    return [
        ...QUICK_WORK_BUILTIN_TEMPLATES,
        ...normalizeUserTemplates(userTemplates).map(userTemplateToOption),
    ];
}

/**
 * Resolve what gets SAVED from the modal selection.
 *  - No template  -> the typed text IS the title; no comment (legacy free-write path).
 *  - A template   -> the template label (or "Pagalba: <name>") is the title, and the typed text
 *                    becomes an optional comment.
 * Title is trimmed; comment is null when empty.
 *
 * @param {{template?: {label:string, kind?:string}|null, helpName?:string, text?:string}} args
 * @returns {{title:string, comment:string|null}}
 */
export function resolveQuickWorkEntry({ template = null, helpName = '', text = '' } = {}) {
    const trimmed = String(text ?? '').trim();
    if (template) {
        let title;
        if (template.kind === 'help') {
            const name = String(helpName ?? '').trim();
            // No member chosen yet -> fall back to the bare label rather than a dangling prefix.
            title = name ? `${HELP_TITLE_PREFIX}${name}` : template.label;
        } else {
            title = template.label;
        }
        return { title: String(title).trim(), comment: trimmed || null };
    }
    return { title: trimmed, comment: null };
}

/**
 * Whether "Patvirtinti" should be enabled for the current selection: a non-help template is
 * always submittable; "Pagalba" needs a member; with no template the free text must be non-empty.
 */
export function canSubmitQuickWork({ template = null, helpUserId = '', text = '' } = {}) {
    if (template) {
        if (template.kind === 'help') return !!helpUserId;
        return true;
    }
    return String(text ?? '').trim().length > 0;
}
