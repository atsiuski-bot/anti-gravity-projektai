import { useState, useRef, useEffect } from 'react';
import { Search } from 'lucide-react';
import { cn } from '../../utils/cn';
import IconButton from './IconButton';
import SearchBox from './SearchBox';

/**
 * SearchPopover — desktop-only collapsed search. A `Search` icon button that opens an anchored
 * bubble holding the canonical `SearchBox`, so the manager data-grid can reclaim the toolbar's
 * width while keeping full type-ahead search one click away.
 *
 * Desktop-only by construction: callers render it inside a `hidden md:flex` strip; on phones the
 * full inline `SearchBox` stays in the mobile toolbar (a search-as-you-type field must keep the
 * keyboard up, so it is never collapsed behind an icon there).
 *
 * Dismissal mirrors `InfoPopover` (outside pointer-down + a second toggle click). Escape is
 * deferred to `SearchBox` first: it `preventDefault()`s when it closes its suggestion list or
 * clears the query, so the popover only closes on an Escape that `SearchBox` did NOT consume —
 * one Escape never both clears the text and closes the bubble.
 *
 * @param {string} value - current query (controlled).
 * @param {(v: string) => void} onChange
 * @param {{value: string, kind: string}[]} [suggestions] - ranked completions from the parent.
 * @param {string} [placeholder]
 * @param {string} [label] - accessible name for the trigger and the field.
 * @param {string} [className] - wrapper class.
 */
export default function SearchPopover({
    value,
    onChange,
    suggestions = [],
    placeholder,
    label = 'Ieškoti užduočių',
    className,
}) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef(null);
    const triggerRef = useRef(null);
    const active = value.trim().length > 0;

    // Move focus into the search input when the bubble opens.
    useEffect(() => {
        if (!open) return undefined;
        const raf = requestAnimationFrame(() => containerRef.current?.querySelector('input')?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    // Dismiss on an outside pointer-down (mirrors InfoPopover's anchored bubble).
    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    // Only close the popover on an Escape SearchBox already handled — it preventDefaults when it
    // closes its list or clears the query, so we leave those to it and close on the "empty" Escape.
    const onKeyDown = (e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
            setOpen(false);
            requestAnimationFrame(() => triggerRef.current?.focus());
        }
    };

    return (
        <div ref={containerRef} className={cn('relative inline-flex', className)} onKeyDown={onKeyDown}>
            <IconButton
                ref={triggerRef}
                icon={Search}
                label={label}
                variant={active ? 'primary' : 'default'}
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
            />
            {open && (
                <div className="absolute right-0 top-full z-toast mt-1 w-80 max-w-[80vw] rounded-card border border-line bg-surface-card p-2 shadow-lg">
                    <SearchBox
                        value={value}
                        onChange={onChange}
                        suggestions={suggestions}
                        placeholder={placeholder}
                        ariaLabel={label}
                    />
                </div>
            )}
        </div>
    );
}
