import { useState, useRef, useEffect, useId, useCallback } from 'react';
import { Search, X, ClipboardList, User, Tag } from 'lucide-react';
import { cn } from '../../utils/cn';
import { highlightMatch } from '../../utils/taskSearch';

/**
 * SearchBox — the canonical type-ahead search field (a search combobox), used by the task lists.
 *
 * It is a controlled text input plus an **anchored** suggestion list. The suggestions are a
 * "did-you-mean / quick-complete" affordance: the parent computes them (via
 * `buildTaskSuggestions`) and selecting one simply sets the query to that value, which then
 * filters the list below. The list itself still filters live as you type — the dropdown only
 * speeds up reaching a known title / worker / tag and rescues typos.
 *
 * Why anchored and not the §8 centred sheet: a search-as-you-type field must keep the soft
 * keyboard up and show matches *as the user types*. A full-screen Modal sheet (the rule for the
 * single-choice `Select`) would fight the keyboard and break the typing loop. The §8 preference
 * is an "anchored panel exactly the trigger's width", which is exactly this — a Google-style
 * suggestion list directly under the box. (DECISION 2026-06-23: search autocomplete is the
 * anchored-panel case of §8, never the sheet.)
 *
 * Accessibility (WCAG 2.1 AA, combobox pattern): `role="combobox"` + `aria-expanded` +
 * `aria-controls` + `aria-autocomplete="list"` on the input, roving `aria-activedescendant`,
 * full keyboard (↓/↑/Home/End/Enter/Esc), `role="listbox"`/`role="option"` rows at ≥44px, a
 * visible focus ring, and a labelled clear button.
 *
 * @param {string} value - current query text (controlled).
 * @param {(value: string) => void} onChange - called with the new query (typing or a pick).
 * @param {{value: string, kind: string}[]} [suggestions] - ranked completions from the parent.
 * @param {string} [placeholder]
 * @param {string} ariaLabel - accessible name for the input (required; there is no visible label).
 * @param {string} [id] - id for the input.
 * @param {string} [className] - wrapper width / grid span.
 */

// The little type tag on the right of each suggestion. Color is never the sole signal — every
// row carries an icon + a word, so it reads the same to everyone (§5).
const KIND_META = {
    task: { icon: ClipboardList, label: 'Užduotis' },
    worker: { icon: User, label: 'Vykdytojas' },
    tag: { icon: Tag, label: 'Žyma' },
};

export default function SearchBox({
    value,
    onChange,
    suggestions = [],
    placeholder = 'Ieškoti…',
    ariaLabel,
    id,
    className,
}) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const wrapperRef = useRef(null);
    const inputRef = useRef(null);
    const reactId = useId();
    const inputId = id || `${reactId}-input`;
    const listId = `${reactId}-listbox`;
    const optionId = (i) => `${reactId}-opt-${i}`;

    const hasText = value.trim().length > 0;
    const showList = open && hasText && suggestions.length > 0;

    // Reset the roving highlight whenever the suggestion set changes (new keystroke), so Enter
    // never fires a stale row. We don't auto-highlight row 0: Enter on raw input should just
    // submit the typed text, not silently swap in the top suggestion.
    useEffect(() => {
        setActiveIndex(-1);
    }, [value]);

    const closeList = useCallback(() => {
        setOpen(false);
        setActiveIndex(-1);
    }, []);

    const pick = useCallback((suggestion) => {
        if (!suggestion) return;
        onChange(suggestion.value);
        closeList();
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [onChange, closeList]);

    const clear = useCallback(() => {
        onChange('');
        closeList();
        requestAnimationFrame(() => inputRef.current?.focus());
    }, [onChange, closeList]);

    // Dismiss the anchored list on an outside pointer-down (mirrors Select's anchored path).
    useEffect(() => {
        if (!showList) return undefined;
        const onPointerDown = (e) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target)) closeList();
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [showList, closeList]);

    const moveActive = useCallback((dir) => {
        setActiveIndex((curr) => {
            const n = suggestions.length;
            if (n === 0) return -1;
            if (curr === -1) return dir > 0 ? 0 : n - 1;
            return (curr + dir + n) % n;
        });
    }, [suggestions.length]);

    const onKeyDown = (e) => {
        switch (e.key) {
            case 'ArrowDown':
                if (!showList) { if (hasText) setOpen(true); return; }
                e.preventDefault();
                moveActive(1);
                break;
            case 'ArrowUp':
                if (!showList) return;
                e.preventDefault();
                moveActive(-1);
                break;
            case 'Home':
                if (showList) { e.preventDefault(); setActiveIndex(0); }
                break;
            case 'End':
                if (showList) { e.preventDefault(); setActiveIndex(suggestions.length - 1); }
                break;
            case 'Enter':
                // Pick the highlighted suggestion if one is active; otherwise let the typed text
                // stand (the list is already filtered) and just close the dropdown.
                if (showList && activeIndex >= 0 && activeIndex < suggestions.length) {
                    e.preventDefault();
                    pick(suggestions[activeIndex]);
                } else {
                    closeList();
                }
                break;
            case 'Escape':
                // First Escape closes the suggestion list; a second (list already closed) clears.
                if (showList) { e.preventDefault(); closeList(); }
                else if (hasText) { e.preventDefault(); clear(); }
                break;
            default:
                break;
        }
    };

    return (
        <div ref={wrapperRef} className={cn('relative', className)}>
            <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
                aria-hidden="true"
            />
            <input
                ref={inputRef}
                id={inputId}
                type="text"
                role="combobox"
                value={value}
                onChange={(e) => { onChange(e.target.value); setOpen(true); }}
                onFocus={() => hasText && setOpen(true)}
                onKeyDown={onKeyDown}
                placeholder={placeholder}
                aria-label={ariaLabel}
                aria-expanded={showList}
                aria-controls={showList ? listId : undefined}
                aria-activedescendant={showList && activeIndex >= 0 && activeIndex < suggestions.length ? optionId(activeIndex) : undefined}
                aria-autocomplete="list"
                enterKeyHint="search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck="false"
                className={cn(
                    'w-full min-h-touch rounded-input border border-line bg-surface-card pl-10 text-body-lg text-ink',
                    hasText ? 'pr-11' : 'pr-4',
                    'py-2 focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2'
                )}
            />
            {hasText && (
                <button
                    type="button"
                    onClick={clear}
                    aria-label="Išvalyti paiešką"
                    className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-input text-ink-muted hover:bg-surface-sunken hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </button>
            )}

            {showList && (
                <ul
                    id={listId}
                    role="listbox"
                    aria-label={ariaLabel}
                    className="absolute inset-x-0 top-full z-toast mt-1 max-h-72 overflow-y-auto rounded-card border border-line bg-surface-card py-1 shadow-lg animate-in fade-in slide-in-from-top-2"
                >
                    {suggestions.map((s, i) => {
                        const meta = KIND_META[s.kind] || KIND_META.task;
                        const KindIcon = meta.icon;
                        const isActive = i === activeIndex;
                        const parts = highlightMatch(s.value, value);
                        return (
                            <li
                                key={`${s.kind}-${s.value}-${i}`}
                                id={optionId(i)}
                                role="option"
                                aria-selected={isActive}
                                onMouseEnter={() => setActiveIndex(i)}
                                // pointerdown (not click): fire the pick before the input's blur/outside
                                // handler can tear the list down. preventDefault keeps input focus.
                                onPointerDown={(e) => { e.preventDefault(); pick(s); }}
                                className={cn(
                                    'flex min-h-touch cursor-pointer items-center gap-2 px-3 py-2.5 text-body',
                                    isActive ? 'bg-brand/10 text-ink-strong' : 'text-ink'
                                )}
                            >
                                <Search className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate">
                                    {parts ? (
                                        <>
                                            {parts.before}
                                            <mark className="bg-transparent font-semibold text-ink-strong">{parts.match}</mark>
                                            {parts.after}
                                        </>
                                    ) : s.value}
                                </span>
                                <span className="inline-flex shrink-0 items-center gap-1 text-caption text-ink-muted">
                                    <KindIcon className="h-3.5 w-3.5" aria-hidden="true" />
                                    {meta.label}
                                </span>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
