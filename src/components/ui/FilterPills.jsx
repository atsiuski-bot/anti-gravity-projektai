import { cn } from '../../utils/cn';
import UserChip from '../UserChip';

// One filter pill — a toggle shown immediately (no dropdown). The active one is brand-filled,
// the rest are bordered chips. 44px min target (touch, DESIGN_SYSTEM §9) with a visible focus ring;
// `aria-pressed` carries the on/off state for assistive tech.
function Pill({ active, onClick, children, compactStart }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={cn(
                'inline-flex min-h-touch items-center rounded-full text-body font-medium transition',
                compactStart ? 'pl-1.5 pr-4' : 'px-4',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring focus-visible:ring-offset-2',
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
 * FilterPills — an immediate (no-dropdown) single-select filter rendered as a pill row.
 *
 * Generic over WHAT it filters: each option is a `{value, label}` (a tag, an assignee, …). The
 * options are sourced from the values that ACTUALLY occur in the caller's list, never a static
 * catalogue — so a value with no matching item never offers a dead filter. When `options` is empty
 * the whole row renders nothing (the caller need not gate on it). A leading reset pill ("Visi")
 * clears the filter to '' (= show all).
 *
 * When an option carries a `userId`, the pill renders the person the way the rest of the app does —
 * a `UserChip` (avatar + formatted name), `bare` so it inherits the pill's own chrome and typography
 * instead of drawing a pill inside a pill. Text-only options (tags) are unchanged.
 *
 * @param {{value: string, label: string, userId?: string}[]} options - distinct, deduped/sorted choices present in the list.
 * @param {string}   value  - the currently selected option value ('' = all).
 * @param {(value: string) => void} onChange - called with the chosen value ('' for the reset pill).
 * @param {string} [allLabel='Visi'] - label for the reset pill.
 * @param {string} [ariaLabel='Filtruoti'] - group accessible name.
 * @param {string} [className] - wrapper class (e.g. spacing).
 */
export default function FilterPills({
    options,
    value,
    onChange,
    allLabel = 'Visi',
    ariaLabel = 'Filtruoti',
    className,
}) {
    if (!options || options.length === 0) return null;
    return (
        <div className={cn('flex flex-wrap items-center gap-2', className)} role="group" aria-label={ariaLabel}>
            <Pill active={value === ''} onClick={() => onChange('')}>
                {allLabel}
            </Pill>
            {options.map((opt) => (
                <Pill
                    key={opt.value}
                    active={value === opt.value}
                    onClick={() => onChange(opt.value)}
                    compactStart={!!opt.userId}
                >
                    {opt.userId
                        ? <UserChip userId={opt.userId} name={opt.label} bare linkToProfile={false} />
                        : opt.label}
                </Pill>
            ))}
        </div>
    );
}
