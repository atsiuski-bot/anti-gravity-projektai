import { useState, useRef, useEffect, useId, useCallback } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../utils/cn';
import Modal from './Modal';

/**
 * Select — the canonical single-choice dropdown (DESIGN_SYSTEM §8).
 *
 * The one approved replacement for every native `<select>`. A native select cannot honour
 * the app's pop-up rules: the browser draws its option panel at a width and position we do
 * not control, and there is no way to keep its first row from echoing the field label. This
 * module fixes all three:
 *
 *  - **Two presentations, one behaviour** (mirrors `InfoPopover` / the `Modal` §8 rule):
 *    on a normal page it opens an **anchored panel the exact width of the trigger**; when the
 *    trigger sits inside a scrollable modal/table where anchoring would clip (`alwaysSheet`),
 *    or on a phone (`<640px`), it opens a **centred full-screen sheet** through the canonical
 *    `Modal` instead. Either way the panel is never a cramped, clipped, browser-drawn box.
 *  - **The category name is a heading, never the first option.** The field label rides on the
 *    trigger + the panel header; the list holds real choices only (a "Visi…" reset is a real
 *    choice, not a disabled echo of the label).
 *  - **Accessible listbox** (WCAG 2.1 AA, §7): `aria-haspopup="listbox"`, roving
 *    `aria-activedescendant`, full keyboard (↑/↓/Home/End/Enter/Esc), 44px targets, focus
 *    ring, focus restored to the trigger on close.
 *
 * Stacking: the sheet renders through `Modal` with `level="top"`, and `useModalA11y`'s dialog
 * stack means a Select opened from inside a parent modal (e.g. `TaskModal`) becomes the topmost
 * dialog (its Esc/Tab win, focus returns to the trigger on close) without fighting the parent.
 *
 * @param {string} value - the currently selected option value.
 * @param {(value: string) => void} onChange - called with the chosen option's value.
 * @param {{value: string, label: string, disabled?: boolean, isGroup?: boolean,
 *   leading?: React.ReactNode}[]} options - the choices. An item with `isGroup: true` renders as a
 *   non-selectable section heading (keyboard navigation skips it), letting a long list be grouped
 *   under category labels. `leading` is an optional node (e.g. an `Avatar`) shown before the label
 *   in the row AND, for the selected option, on the trigger — the basis of `PersonSelect`.
 * @param {string} [label] - the field/category name; shown as the panel heading + fallback
 *   accessible name. NEVER duplicated as an option row.
 * @param {string} [placeholder] - trigger text when nothing is selected (a prompt, not a choice).
 * @param {React.ElementType} [icon] - optional leading lucide icon on the trigger.
 * @param {boolean} [alwaysSheet=false] - force the centred sheet on every breakpoint (use when
 *   the trigger lives inside a scrollable modal/table where an anchored panel would clip).
 * @param {boolean} [disabled=false]
 * @param {string} [ariaLabel] - explicit accessible name for the trigger (overrides `label`).
 * @param {string} [id] - id for the trigger button (for an external `<label htmlFor>`).
 * @param {string} [className] - wrapper class (width / grid span).
 * @param {string} [buttonClassName] - trigger overrides.
 * @param {(args: {open: boolean, disabled: boolean, selected: object|null, triggerText: string,
 *   toggle: () => void, triggerProps: object}) => React.ReactNode} [renderTrigger] - render a
 *   custom trigger (e.g. a column-filter funnel icon) in place of the default labeled button.
 *   Spread `triggerProps` onto your control to inherit open/close, the trigger keyboard, focus
 *   return, and the listbox ARIA wiring; supply your OWN accessible name. The popup/listbox and
 *   its a11y are unchanged — this only swaps the thing you click to open it.
 */
export default function Select({
    value,
    onChange,
    options = [],
    label,
    placeholder,
    icon: Icon,
    alwaysSheet = false,
    disabled = false,
    ariaLabel,
    id,
    className,
    buttonClassName,
    renderTrigger,
}) {
    const [open, setOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const wrapperRef = useRef(null);
    const triggerRef = useRef(null);
    const listRef = useRef(null);
    const reactId = useId();
    const listId = `${reactId}-listbox`;
    const optionId = (i) => `${reactId}-opt-${i}`;

    const selected = options.find((o) => o.value === value) || null;
    const triggerText = selected ? selected.label : (placeholder ?? label ?? '');
    const isPlaceholder = !selected;

    // `alwaysSheet` forces the centred sheet everywhere; otherwise <640px (Tailwind `sm`,
    // matching InfoPopover) gets the sheet and wider screens get the anchored panel.
    const useSheet = alwaysSheet || isMobile;

    useEffect(() => {
        const mq = window.matchMedia('(max-width: 639px)');
        const update = () => setIsMobile(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);

    const openMenu = useCallback(() => {
        if (disabled) return;
        const selIdx = options.findIndex((o) => o.value === value && !o.disabled && !o.isGroup);
        const startIdx = selIdx >= 0 ? selIdx : options.findIndex((o) => !o.disabled && !o.isGroup);
        setActiveIndex(startIdx);
        setOpen(true);
    }, [disabled, options, value]);

    const closeMenu = useCallback((focusTrigger = true) => {
        setOpen(false);
        if (focusTrigger) requestAnimationFrame(() => triggerRef.current?.focus());
    }, []);

    const selectOption = useCallback((opt) => {
        if (!opt || opt.disabled || opt.isGroup) return;
        if (opt.value !== value) onChange?.(opt.value);
        closeMenu();
    }, [onChange, value, closeMenu]);

    const moveActive = useCallback((dir) => {
        setActiveIndex((curr) => {
            const n = options.length;
            if (n === 0) return -1;
            let i = curr;
            for (let step = 0; step < n; step += 1) {
                i = (i + dir + n) % n;
                if (!options[i].disabled && !options[i].isGroup) return i;
            }
            return curr;
        });
    }, [options]);

    // Anchored panel only: move focus into the listbox after it paints. The sheet path lets the
    // canonical Modal do this via `initialFocusRef`, so we skip it there to avoid a double focus.
    useEffect(() => {
        if (!open || useSheet) return undefined;
        const raf = requestAnimationFrame(() => listRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open, useSheet]);

    // Anchored panel dismissal on outside pointer-down. (The sheet's Modal owns its own
    // backdrop/Escape dismissal, so this listener never runs in that mode.)
    useEffect(() => {
        if (!open || useSheet) return undefined;
        const onPointerDown = (e) => {
            if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open, useSheet]);

    const onListKeyDown = (e) => {
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                moveActive(1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                moveActive(-1);
                break;
            case 'Home':
                e.preventDefault();
                setActiveIndex(options.findIndex((o) => !o.disabled && !o.isGroup));
                break;
            case 'End':
                e.preventDefault();
                for (let i = options.length - 1; i >= 0; i -= 1) {
                    if (!options[i].disabled && !options[i].isGroup) {
                        setActiveIndex(i);
                        break;
                    }
                }
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (activeIndex >= 0) selectOption(options[activeIndex]);
                break;
            case 'Escape':
                // Anchored panel closes itself here; the sheet lets the event bubble to the
                // Modal's own Escape handler (the topmost dialog) instead.
                if (!useSheet) {
                    e.preventDefault();
                    closeMenu();
                }
                break;
            case 'Tab':
                // Anchored panel: a Tab away dismisses and lets focus proceed. The sheet's Modal
                // traps Tab, so leave it alone there.
                if (!useSheet) setOpen(false);
                break;
            default:
                break;
        }
    };

    const onTriggerKeyDown = (e) => {
        if (disabled) return;
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openMenu();
        }
    };

    const listbox = (
        <ul
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label={label || ariaLabel}
            aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
            onKeyDown={onListKeyDown}
            className={cn('overflow-y-auto py-1 focus:outline-none', useSheet ? 'max-h-[60vh]' : 'max-h-72')}
        >
            {options.map((opt, i) => {
                if (opt.isGroup) {
                    return (
                        <li
                            key={`group-${opt.label}-${i}`}
                            role="presentation"
                            className="px-3 pb-1 pt-3 text-caption font-semibold uppercase tracking-wide text-ink-muted first:pt-1"
                        >
                            {opt.label}
                        </li>
                    );
                }
                const isSel = opt.value === value;
                const isActive = i === activeIndex;
                return (
                    <li
                        key={`${opt.value}-${i}`}
                        id={optionId(i)}
                        role="option"
                        aria-selected={isSel}
                        aria-disabled={opt.disabled || undefined}
                        onMouseEnter={() => !opt.disabled && setActiveIndex(i)}
                        onClick={() => selectOption(opt)}
                        className={cn(
                            'flex min-h-touch cursor-pointer items-center gap-2 px-3 py-2.5 text-body',
                            opt.disabled && 'cursor-not-allowed opacity-60',
                            isActive && !opt.disabled && 'bg-brand/10',
                            isSel ? 'font-semibold text-ink-strong' : 'text-ink'
                        )}
                    >
                        <Check
                            className={cn('h-4 w-4 shrink-0', isSel ? 'text-brand' : 'invisible')}
                            aria-hidden="true"
                        />
                        {opt.leading && <span className="shrink-0">{opt.leading}</span>}
                        <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                    </li>
                );
            })}
        </ul>
    );

    // Trigger attributes shared by the default button and any custom `renderTrigger`. `ref` is
    // extracted by React even when spread, so a custom trigger inherits focus-return + keyboard +
    // listbox ARIA for free. The accessible name is deliberately NOT here: the default button
    // sets it from `ariaLabel || label`, and a custom trigger supplies its own (so a column funnel
    // can say "Filtruoti pagal …" without being overridden).
    const toggle = () => (open ? closeMenu(false) : openMenu());
    const triggerProps = {
        ref: triggerRef,
        type: 'button',
        id,
        disabled,
        onClick: toggle,
        onKeyDown: onTriggerKeyDown,
        'aria-haspopup': 'listbox',
        'aria-expanded': open,
        'aria-controls': open ? listId : undefined,
    };

    return (
        <div ref={wrapperRef} className={cn('relative', className)}>
            {renderTrigger ? (
                renderTrigger({ open, disabled, selected, triggerText, toggle, triggerProps })
            ) : (
                <button
                    {...triggerProps}
                    aria-label={ariaLabel || label}
                    className={cn(
                        'flex min-h-touch w-full items-center gap-2 rounded-input border border-line bg-surface-card px-3 py-2 text-left text-body text-ink',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                        'disabled:opacity-50 disabled:pointer-events-none',
                        open && 'border-brand ring-2 ring-brand',
                        buttonClassName
                    )}
                >
                    {selected?.leading
                        ? <span className="shrink-0">{selected.leading}</span>
                        : (Icon && <Icon className="h-4 w-4 shrink-0 text-ink-muted" aria-hidden="true" />)}
                    <span className={cn('min-w-0 flex-1 truncate', isPlaceholder && 'text-ink-muted')}>
                        {triggerText}
                    </span>
                    <ChevronDown
                        className={cn('h-4 w-4 shrink-0 text-ink-muted transition-transform', open && 'rotate-180')}
                        aria-hidden="true"
                    />
                </button>
            )}

            {/* Anchored panel — exactly the trigger's width (DESIGN_SYSTEM §8). Only for triggers
                that are NOT inside a clipping scroll container. */}
            {open && !useSheet && (
                <div className="absolute inset-x-0 top-full z-toast mt-1 overflow-hidden rounded-card border border-line bg-surface-card shadow-lg animate-in fade-in slide-in-from-top-2">
                    {label && (
                        <div className="px-3 pb-1 pt-2 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                            {label}
                        </div>
                    )}
                    {listbox}
                </div>
            )}

            {/* Centred full-screen sheet — the fallback when anchoring would clip, and the phone
                default. Routed through the canonical Modal (§8). */}
            {open && useSheet && (
                <Modal
                    open
                    onClose={() => closeMenu()}
                    title={label || ariaLabel}
                    ariaLabel={ariaLabel || label}
                    size="sm"
                    level="top"
                    initialFocusRef={listRef}
                >
                    {listbox}
                </Modal>
            )}
        </div>
    );
}
