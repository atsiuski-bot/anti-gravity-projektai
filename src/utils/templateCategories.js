/**
 * templateCategories — a small, data-derived taxonomy for grouping task templates.
 *
 * As templates grow (already 17 and climbing), a flat list gets hard to scan. Categories let the
 * loader group templates under section headings. The taxonomy below is derived from the real
 * recurring themes in the corpus (piro, ugnies šou / fakyrai, kostiumai, mašinos, gamyba/printai,
 * skulptūros, palapinės/workshopai, weekly routines, onboarding).
 *
 * A template MAY carry an explicit `category` (set when saving); when it doesn't,
 * `getTemplateCategory` INFERS one from its name + title keywords, so the existing 17 templates
 * group sensibly with zero backfill and managers can still override by editing.
 */

// Display order matters (sections render in this order). 'kita' is the catch-all and renders last.
export const TEMPLATE_CATEGORIES = [
    { id: 'piro', label: 'Piro / Fejerverkai' },
    { id: 'ugnies_sou', label: 'Ugnies šou / Fakyrai' },
    { id: 'kostiumai', label: 'Kostiumai / Kostiumoteka' },
    { id: 'skulpturos', label: 'Skulptūros / Dekoracijos' },
    { id: 'palapines', label: 'Palapinės / Workshopai' },
    { id: 'transportas', label: 'Transportas / Mašinos' },
    { id: 'gamyba', label: 'Gamyba / Printai' },
    { id: 'rutinos', label: 'Savaitinės rutinos' },
    { id: 'onboarding', label: 'Onboarding' },
    { id: 'kita', label: 'Kita' },
];

export const CATEGORY_LABELS = Object.fromEntries(TEMPLATE_CATEGORIES.map((c) => [c.id, c.label]));

// Diacritic-fold + lowercase (no regex character class — brittle to author), so keyword matching
// is insensitive to Lithuanian diacritics ("šou" → "sou", "mašinų" → "masinu").
const fold = (s) =>
    (s || '')
        .normalize('NFD')
        .split('')
        .filter((c) => {
            const code = c.charCodeAt(0);
            return code < 0x300 || code > 0x36f;
        })
        .join('')
        .toLowerCase();

// Ordered keyword rules — FIRST match wins, so more specific categories are listed before broader
// ones (e.g. "ugnies sou"/"fakyr" before plain piro; "ugnies skulptur" lands in skulptūros, not
// ugnies_sou, because ugnies_sou keys on "ugnies sou"/"fakyr", not bare "ugnies").
const CATEGORY_RULES = [
    { id: 'onboarding', keys: ['onboard', 'naujo vykdytojo', 'vykdytojo ivedim', 'naujoko'] },
    { id: 'ugnies_sou', keys: ['fakyr', 'ugnies sou', 'liepsno', 'wool', ' poi', 'poi '] },
    { id: 'skulpturos', keys: ['skulptur', 'dekorac'] },
    { id: 'palapines', keys: ['palapin', 'worksop', 'workshop'] },
    { id: 'transportas', keys: ['masin', 'transport', 'fura', 'parvez', 'padang'] },
    { id: 'piro', keys: ['piro', 'fejerverk', 'pirotechnik', 'fontan', 'fakel'] },
    { id: 'gamyba', keys: ['print', 'spaud', 'graviru', 'kepur', '3d'] },
    { id: 'kostiumai', keys: ['kostium', 'drabuzi', 'skalb'] },
    { id: 'rutinos', keys: ['savaitin', 'pirmadien', 'einamosios'] },
];

/**
 * Infer a category id from a template's name + task title.
 * @param {{templateName?: string, data?: {title?: string}}} template
 * @returns {string} a category id (falls back to 'kita')
 */
export function inferTemplateCategory(template) {
    const hay = fold(`${template?.templateName || ''} ${template?.data?.title || ''}`);
    for (const rule of CATEGORY_RULES) {
        if (rule.keys.some((k) => hay.includes(k))) return rule.id;
    }
    return 'kita';
}

/**
 * The category to group a template under: its explicit `category` if set & valid, else inferred.
 */
export function getTemplateCategory(template) {
    const explicit = template?.category;
    if (explicit && CATEGORY_LABELS[explicit]) return explicit;
    return inferTemplateCategory(template);
}
