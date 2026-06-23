import { useState, useRef, useEffect, useId, useCallback, useMemo } from 'react';
import { Clock, History, Bookmark } from 'lucide-react';
import { cn } from '../../utils/cn';
import { highlightMatch } from '../../utils/taskSearch';

/**
 * TitleSuggestInput — the create-form title field as an accessible type-ahead combobox.
 *
 * It is the "technology fills it for you" centrepiece. As the creator types it offers two kinds of
 * completion, fed in by the parent and merged into one list:
 *   - `history`  — the creator's own past task titles, each showing that job's typical time, so
 *                  picking a recurring job fills both name and (if unset) its usual duration;
 *   - `template` — curated task templates (manager-only), badged "Šablonas"; picking one applies
 *                  the template's FULL preset (description, assignee, priority, time, …).
 * The list only ever SUGGESTS; free text is always allowed (a brand-new job is just typed).
 *
 * The parent owns what a pick does: `onSelect(item)` fires with the chosen suggestion object and
 * the parent sets the form state (this component does NOT mutate `value` on a pick, because a
 * template pick must set the title to the template's own title, not the row's display label).
 *
 * A11y mirrors the blessed SearchBox combobox (DESIGN_SYSTEM §8 anchored-panel case): a controlled
 * input with `role="combobox"`, `aria-expanded` / `aria-controls` / `aria-autocomplete="list"`,
 * roving `aria-activedescendant`, full keyboard (↓/↑/Home/End/Enter/Esc), `role="listbox"`/`option`
 * rows ≥44px, a visible focus ring, and an anchored panel exactly the input's width (never the
 * full-screen sheet, which would fight the keyboard during type-ahead).
 *
 * @param {string} value - current title text (controlled).
 * @param {(value: string) => void} onChange - called on every keystroke with the new text.
 * @param {(item: object) => void} [onSelect] - called when a suggestion is PICKED (distinct from
 *        typing); the parent applies it.
 * @param {{value: string, kind?: 'history'|'template', time?: string, matchText?: string}[]} [suggestions]
 *        - candidate completions, already ranked by the parent; filtered to the typed text here.
 * @param {boolean} [disabled]
 * @param {string} ariaLabel - accessible name (required; there is no visible label).
 * @param {string} [placeholder]
 * @param {string} [id]
 * @param {string} [className]
 */

const MAX_SUGGESTIONS = 8;

// Diacritic-insensitive fold so "skalbimas" matches "Skalbimas" and "ą/č/ę…" match their bare
// forms — Lithuanian titles are full of them.
const fold = (s) =>
    (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '');

export default function TitleSuggestInput({
    value,
    onChange,
    onSelect,
    suggestions = [],
    disabled = false,
    ariaLabel,
    placeholder,
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

    const trimmed = (value || '').trim();

    // Candidate rows: suggestions whose text contains the typed text (folded), excluding one that
    // is already exactly what's typed (nothing to complete). De-duplicated by display value and
    // capped so the panel stays scannable. The parent's order (templates first) is preserved.
    const filtered = useMemo(() => {
        if (!trimmed) return [];
        const q = fold(trimmed);
        const out = [];
        const seen = new Set();
        for (const s of suggestions) {
            if (!s || !s.value) continue;
            const fv = fold(s.value);
            const haystack = fold(s.matchText || s.value);
            if (!haystack.includes(q)) continue;
            if (fv === q) continue; // already typed in full
            if (seen.has(fv)) continue;
            seen.add(fv);
            out.push(s);
            if (out.length >= MAX_SUGGESTIONS) break;
        }
        return out;
    }, [suggestions, trimmed]);

    const showList = open && !disabled && filtered.length > 0;

    // Reset the roving highlight on each keystroke so Enter never fires a stale row, and we never
    // auto-highlight row 0 (Enter on raw text should keep the typed text, not swap in a guess).
    useEffect(() => {
        setActiveIndex(-1);
    }, [value]);

    const closeList = useCallback(() => {
        setOpen(false);
        setActiveIndex(-1);
    }, []);

    const pick = useCallback(
        (item) => {
            if (!item) return;
            onSelect?.(item);
            closeList();
            requestAnimationFrame(() => inputRef.current?.focus());
        },
        [onSelect, closeList]
    );

    // Dismiss the anchored list on an outside pointer-down (mirrors SearchBox / Select).
    useEffect(() => {
        if (!showList) return undefined;
        const onPointerDown = (e) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target)) closeList();
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [showList, closeList]);

    const moveActive = useCallback(
        (dir) => {
            setActiveIndex((curr) => {
                const n = filtered.length;
                if (n === 0) return -1;
                if (curr === -1) return dir > 0 ? 0 : n - 1;
                return (curr + dir + n) % n;
            });
        },
        [filtered.length]
    );

    const onKeyDown = (e) => {
        switch (e.key) {
            case 'ArrowDown':
                if (!showList) {
                    if (filtered.length > 0) setOpen(true);
                    return;
                }
                e.preventDefault();
                moveActive(1);
                break;
            case 'ArrowUp':
                if (!showList) return;
                e.preventDefault();
                moveActive(-1);
                break;
            case 'Home':
                if (showList) {
                    e.preventDefault();
                    setActiveIndex(0);
                }
                break;
            case 'End':
                if (showList) {
                    e.preventDefault();
                    setActiveIndex(filtered.length - 1);
                }
                break;
            case 'Enter':
                // Pick the highlighted row if one is active; otherwise keep the typed text and
                // just close the panel. Either way we swallow Enter so it never submits the form.
                if (showList && activeIndex >= 0 && activeIndex < filtered.length) {
                    e.preventDefault();
                    pick(filtered[activeIndex]);
                } else if (showList) {
                    e.preventDefault();
                    closeList();
                }
                break;
            case 'Escape':
                if (showList) {
                    e.preventDefault();
                    closeList();
                }
                break;
            default:
                break;
        }
    };

    return (
        <div ref={wrapperRef} className={cn('relative', className)}>
            <input
                ref={inputRef}
                id={inputId}
                type="text"
                role="combobox"
                value={value}
                onChange={(e) => {
                    onChange(e.target.value);
                    setOpen(true);
                }}
                onFocus={() => filtered.length > 0 && setOpen(true)}
                onKeyDown={onKeyDown}
                disabled={disabled}
                placeholder={placeholder}
                aria-label={ariaLabel}
                aria-expanded={showList}
                aria-controls={showList ? listId : undefined}
                aria-activedescendant={
                    showList && activeIndex >= 0 && activeIndex < filtered.length
                        ? optionId(activeIndex)
                        : undefined
                }
                aria-autocomplete="list"
                autoComplete="off"
                className="w-full rounded-lg border border-line px-3 py-3 text-base text-ink focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand disabled:bg-surface-sunken"
            />

            {showList && (
                <ul
                    id={listId}
                    role="listbox"
                    aria-label={ariaLabel}
                    className="absolute inset-x-0 top-full z-toast mt-1 max-h-72 overflow-y-auto rounded-card border border-line bg-surface-card py-1 shadow-lg animate-in fade-in slide-in-from-top-2"
                >
                    {filtered.map((item, i) => {
                        const isActive = i === activeIndex;
                        const isTemplate = item.kind === 'template';
                        const parts = highlightMatch(item.value, trimmed);
                        const RowIcon = isTemplate ? Bookmark : History;
                        return (
                            <li
                                key={`${item.kind || 'history'}-${item.value}-${i}`}
                                id={optionId(i)}
                                role="option"
                                aria-selected={isActive}
                                onMouseEnter={() => setActiveIndex(i)}
                                // pointerdown (not click): fire the pick before the input's blur /
                                // outside handler tears the list down; preventDefault keeps focus.
                                onPointerDown={(e) => {
                                    e.preventDefault();
                                    pick(item);
                                }}
                                className={cn(
                                    'flex min-h-touch cursor-pointer items-center gap-2 px-3 py-2.5 text-body',
                                    isActive ? 'bg-brand/10 text-ink-strong' : 'text-ink'
                                )}
                            >
                                <RowIcon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />
                                <span className="min-w-0 flex-1 truncate">
                                    {parts ? (
                                        <>
                                            {parts.before}
                                            <mark className="bg-transparent font-semibold text-ink-strong">
                                                {parts.match}
                                            </mark>
                                            {parts.after}
                                        </>
                                    ) : (
                                        item.value
                                    )}
                                </span>
                                {isTemplate ? (
                                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-brand/10 px-2 text-caption font-medium text-brand">
                                        <Bookmark className="h-3 w-3" aria-hidden="true" />
                                        Šablonas
                                    </span>
                                ) : (
                                    item.time && (
                                        <span className="inline-flex shrink-0 items-center gap-1 text-caption text-ink-muted tabular-nums">
                                            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                                            {item.time}
                                        </span>
                                    )
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
