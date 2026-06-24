import { cn } from '../../utils/cn';

// One tag-filter pill — a toggle shown immediately (no dropdown). The active one is brand-filled,
// the rest are bordered chips. 44px min target (touch, DESIGN_SYSTEM §9) with a visible focus ring;
// `aria-pressed` carries the on/off state for assistive tech.
function Pill({ active, onClick, children }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'inline-flex min-h-touch items-center rounded-full px-4 text-body font-medium transition',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                active
                    ? 'bg-brand text-white'
                    : 'border border-line bg-surface-card text-ink hover:bg-surface-sunken'
            )}
        >
            {children}
        </button>
    );
}

/**
 * TagFilterPills — an immediate (no-dropdown) single-select tag filter rendered as a pill row.
 *
 * The pills are sourced from the tags that ACTUALLY occur in the caller's list (passed in `tags`),
 * never a static catalogue — so a tag with no tasks never offers a dead filter. When `tags` is
 * empty the whole row renders nothing (the caller need not gate on it). A leading "Visi" pill
 * resets the filter to '' (= show all).
 *
 * @param {string[]} tags   - distinct tag values present in the list (already deduped/sorted).
 * @param {string}   value  - the currently selected tag ('' = all).
 * @param {(value: string) => void} onChange - called with the chosen tag ('' for the "Visi" reset).
 * @param {string} [allLabel='Visi'] - label for the reset pill.
 * @param {string} [ariaLabel='Filtruoti pagal žymą'] - group accessible name.
 * @param {string} [className] - wrapper class (e.g. spacing).
 */
export default function TagFilterPills({
    tags,
    value,
    onChange,
    allLabel = 'Visi',
    ariaLabel = 'Filtruoti pagal žymą',
    className,
}) {
    if (!tags || tags.length === 0) return null;
    return (
        <div className={cn('flex flex-wrap items-center gap-2', className)} role="group" aria-label={ariaLabel}>
            <Pill active={value === ''} onClick={() => onChange('')}>
                {allLabel}
            </Pill>
            {tags.map((tag) => (
                <Pill key={tag} active={value === tag} onClick={() => onChange(tag)}>
                    {tag}
                </Pill>
            ))}
        </div>
    );
}
