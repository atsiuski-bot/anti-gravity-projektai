import { useState, useRef, useEffect, useCallback, useId } from 'react';
import {
    format,
    addMonths,
    addDays,
    startOfMonth,
    endOfMonth,
    startOfWeek,
    endOfWeek,
    isSameDay,
    isSameMonth,
    eachDayOfInterval,
} from 'date-fns';
import { lt } from 'date-fns/locale';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '../../utils/cn';
import IconButton from './IconButton';
import { getLithuanianDateString } from '../../utils/timeUtils';

/**
 * DatePicker — the canonical Lithuanian-localized date control (DESIGN_SYSTEM §8).
 *
 * Why this exists: native `<input type="date">` draws its drop-down calendar (month names,
 * weekdays) in the *browser's* UI language, not the page's `lang`. On an English-language
 * browser every native date field showed English months, regardless of our `lang="lt"`. This
 * component renders the whole calendar ourselves through `date-fns` + the `lt` locale, so the
 * months are always Lithuanian on every machine.
 *
 * Value contract is a plain `yyyy-MM-dd` string (same as the native input it replaces), so it
 * is a near drop-in. `onChange` receives the new string directly (not a DOM event).
 *
 * Accessibility: a labelable trigger button (associate via `id` + a `<label htmlFor>` or pass
 * `aria-label`), a `dialog`-role popover, full keyboard navigation inside the grid (arrows,
 * Home/End, PageUp/PageDown, Enter/Space, Escape), roving tabindex, ≥44px targets, visible
 * focus rings. `min`/`max` (also `yyyy-MM-dd`) disable out-of-range days.
 *
 * @param {string} [id] - id for the trigger button so a `<label htmlFor>` can name it.
 * @param {string} value - selected date as `yyyy-MM-dd`, or '' when empty.
 * @param {(value: string) => void} onChange - called with the new `yyyy-MM-dd` string.
 * @param {string} [min] - earliest selectable date (`yyyy-MM-dd`).
 * @param {string} [max] - latest selectable date (`yyyy-MM-dd`).
 * @param {boolean} [disabled]
 * @param {boolean} [clearable] - when true and a date is set, a "×" button clears it back to ''
 *   (opt-in, because most call sites are required or range-filter fields where clearing is wrong).
 * @param {string} [placeholder] - shown when `value` is empty.
 * @param {string} [displayFormat] - date-fns pattern for the trigger label (default `yyyy MMM d`,
 *   abbreviated so the day never truncates in narrow side-by-side range filters).
 * @param {string} [className] - extends the trigger's class list.
 */

const WEEKDAY_LABELS = ['Pr', 'An', 'Tr', 'Kt', 'Pn', 'Št', 'Sk'];

const pad = (n) => String(n).padStart(2, '0');

/** Parse a `yyyy-MM-dd` string to a *local* midnight Date (never UTC, to avoid off-by-one). */
function parseDateStr(str) {
    if (!str || typeof str !== 'string') return null;
    const [y, m, d] = str.split('-').map(Number);
    if (!y || !m || !d) return null;
    const date = new Date(y, m - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
}

/** Serialize a Date back to `yyyy-MM-dd` from its local fields. */
function toDateStr(date) {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Clamp a candidate date string into the [min, max] window (string compare is sort-safe here). */
function isOutOfRange(dateStr, min, max) {
    if (min && dateStr < min) return true;
    if (max && dateStr > max) return true;
    return false;
}

export default function DatePicker({
    id,
    value,
    onChange,
    min,
    max,
    disabled = false,
    clearable = false,
    placeholder = 'Pasirinkite datą',
    displayFormat = 'yyyy MMM d',
    className,
    ...rest
}) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef(null);
    const triggerRef = useRef(null);
    const gridRef = useRef(null);
    const dialogId = useId();

    const selectedDate = parseDateStr(value);
    const todayStr = getLithuanianDateString();

    // The month currently on screen, and the day that holds keyboard focus inside the grid.
    // Both seed from the selected value, else today.
    const initialFocus = selectedDate || parseDateStr(todayStr) || new Date();
    const [viewMonth, setViewMonth] = useState(startOfMonth(initialFocus));
    const [focusedDate, setFocusedDate] = useState(initialFocus);

    // Re-seed the view/focus each time the popover opens, so it always lands on the current
    // value (or today) rather than wherever the user last browsed.
    useEffect(() => {
        if (!open) return;
        const seed = parseDateStr(value) || parseDateStr(todayStr) || new Date();
        setViewMonth(startOfMonth(seed));
        setFocusedDate(seed);
    }, [open, value, todayStr]);

    // Dismiss on outside pointer-down / Escape, and restore focus to the trigger on Escape.
    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    // Move DOM focus to the focused day whenever it changes while open (roving tabindex).
    useEffect(() => {
        if (!open || !gridRef.current) return;
        const btn = gridRef.current.querySelector(`[data-date="${toDateStr(focusedDate)}"]`);
        if (btn) btn.focus();
    }, [open, focusedDate, viewMonth]);

    const commit = useCallback(
        (date) => {
            onChange?.(toDateStr(date));
            setOpen(false);
            // Return focus to the trigger so keyboard users keep their place.
            requestAnimationFrame(() => triggerRef.current?.focus());
        },
        [onChange]
    );

    const moveFocus = useCallback(
        (next) => {
            setFocusedDate(next);
            if (!isSameMonth(next, viewMonth)) setViewMonth(startOfMonth(next));
        },
        [viewMonth]
    );

    const onGridKeyDown = (e) => {
        let handled = true;
        switch (e.key) {
            case 'ArrowLeft':
                moveFocus(addDays(focusedDate, -1));
                break;
            case 'ArrowRight':
                moveFocus(addDays(focusedDate, 1));
                break;
            case 'ArrowUp':
                moveFocus(addDays(focusedDate, -7));
                break;
            case 'ArrowDown':
                moveFocus(addDays(focusedDate, 7));
                break;
            case 'Home':
                moveFocus(startOfWeek(focusedDate, { weekStartsOn: 1 }));
                break;
            case 'End':
                moveFocus(endOfWeek(focusedDate, { weekStartsOn: 1 }));
                break;
            case 'PageUp':
                moveFocus(addMonths(focusedDate, -1));
                break;
            case 'PageDown':
                moveFocus(addMonths(focusedDate, 1));
                break;
            case 'Enter':
            case ' ': {
                const ds = toDateStr(focusedDate);
                if (!isOutOfRange(ds, min, max)) commit(focusedDate);
                break;
            }
            case 'Escape':
                setOpen(false);
                requestAnimationFrame(() => triggerRef.current?.focus());
                break;
            default:
                handled = false;
        }
        if (handled) e.preventDefault();
    };

    // The 6-week grid (Monday-first) covering the visible month.
    const gridStart = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 1 });
    const gridEnd = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 1 });
    const days = eachDayOfInterval({ start: gridStart, end: gridEnd });

    const triggerLabel = selectedDate
        ? format(selectedDate, displayFormat, { locale: lt })
        : placeholder;

    // Show the clear "×" only when clearing makes sense — opted in, a date is set, and the field is
    // editable. When shown it replaces the calendar glyph (one control on the right edge, never two)
    // and the trigger reserves right padding so the label never slides under it.
    const showClear = clearable && !!selectedDate && !disabled;

    return (
        <div ref={containerRef} className="relative">
            <button
                ref={triggerRef}
                id={id}
                type="button"
                disabled={disabled}
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-controls={open ? dialogId : undefined}
                className={cn(
                    'flex w-full items-center justify-between gap-2 min-h-touch',
                    'rounded-input border border-line bg-surface-card py-2 pl-3 text-body-lg text-left',
                    showClear ? 'pr-12' : 'pr-3',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                    'disabled:opacity-50 disabled:pointer-events-none',
                    !selectedDate && 'text-ink-muted',
                    className
                )}
                {...rest}
            >
                <span className="truncate capitalize">{triggerLabel}</span>
                {!showClear && <CalendarDays className="w-5 h-5 shrink-0 text-ink-muted" aria-hidden="true" />}
            </button>

            {showClear && (
                <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation();
                        onChange?.('');
                        // Keep keyboard users on the field after clearing.
                        requestAnimationFrame(() => triggerRef.current?.focus());
                    }}
                    aria-label="Išvalyti datą"
                    className={cn(
                        'absolute right-1 top-1/2 -translate-y-1/2 flex h-11 w-11 items-center justify-center',
                        'rounded-input text-ink-muted hover:bg-surface-sunken hover:text-ink',
                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand'
                    )}
                >
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}

            {open && (
                <div
                    id={dialogId}
                    role="dialog"
                    aria-modal="false"
                    aria-label="Pasirinkite datą"
                    className={cn(
                        'absolute left-0 top-full z-toast mt-1 w-[22rem] max-w-[calc(100vw-1rem)]',
                        'rounded-card border border-line bg-surface-card p-3 shadow-lg',
                        'animate-in fade-in slide-in-from-top-2 duration-150'
                    )}
                >
                    {/* Month navigation */}
                    <div className="mb-2 flex items-center justify-between">
                        <IconButton
                            icon={ChevronLeft}
                            label="Ankstesnis mėnuo"
                            onClick={() => setViewMonth((m) => addMonths(m, -1))}
                        />
                        <span className="text-body font-bold text-ink-strong capitalize" aria-live="polite">
                            {format(viewMonth, 'LLLL yyyy', { locale: lt })}
                        </span>
                        <IconButton
                            icon={ChevronRight}
                            label="Kitas mėnuo"
                            onClick={() => setViewMonth((m) => addMonths(m, 1))}
                        />
                    </div>

                    {/* Weekday header */}
                    <div className="grid grid-cols-7 gap-0.5" aria-hidden="true">
                        {WEEKDAY_LABELS.map((wd) => (
                            <div key={wd} className="py-1 text-center text-caption font-semibold text-ink-muted">
                                {wd}
                            </div>
                        ))}
                    </div>

                    {/* Day grid */}
                    <div
                        ref={gridRef}
                        role="grid"
                        onKeyDown={onGridKeyDown}
                        className="grid grid-cols-7 gap-0.5"
                    >
                        {days.map((day) => {
                            const dayStr = toDateStr(day);
                            const inMonth = isSameMonth(day, viewMonth);
                            const isSelected = selectedDate && isSameDay(day, selectedDate);
                            const isToday = dayStr === todayStr;
                            const isFocused = isSameDay(day, focusedDate);
                            const outOfRange = isOutOfRange(dayStr, min, max);

                            return (
                                <button
                                    key={dayStr}
                                    type="button"
                                    role="gridcell"
                                    data-date={dayStr}
                                    tabIndex={isFocused ? 0 : -1}
                                    disabled={outOfRange}
                                    aria-selected={isSelected || undefined}
                                    aria-current={isToday ? 'date' : undefined}
                                    aria-label={format(day, 'PPPP', { locale: lt })}
                                    onClick={() => commit(day)}
                                    className={cn(
                                        'flex h-11 w-full items-center justify-center rounded-input text-body tabular-nums',
                                        'transition duration-fast',
                                        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                                        'disabled:opacity-30 disabled:pointer-events-none',
                                        !inMonth && 'text-ink-muted/60',
                                        inMonth && !isSelected && 'text-ink hover:bg-surface-sunken',
                                        isSelected && 'bg-brand text-white font-bold',
                                        isToday && !isSelected && 'ring-1 ring-inset ring-brand font-bold'
                                    )}
                                >
                                    {day.getDate()}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
