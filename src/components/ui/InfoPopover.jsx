import { useState, useRef, useEffect, useId } from 'react';
import { Info } from 'lucide-react';
import clsx from 'clsx';
import IconButton from './IconButton';

/**
 * InfoPopover — a small click-to-toggle help bubble behind an info (i) icon.
 *
 * Used to tuck away scope/explanatory notes that would otherwise clutter a header.
 * Click-driven, not hover/`title`, because tooltips never fire on touch (DESIGN_SYSTEM §7).
 * Dismisses on outside pointer-down or Escape, exposes aria-expanded/aria-controls, and
 * inherits the 44x44 touch target + focus ring from the canonical IconButton.
 *
 * @param {string} [label] - accessible name for the trigger button.
 * @param {React.ReactNode} children - the help content shown in the panel.
 * @param {'left'|'right'} [align] - which edge of the trigger the panel aligns to.
 */
export default function InfoPopover({ label = 'Daugiau informacijos', children, align = 'left', className }) {
    const [open, setOpen] = useState(false);
    const containerRef = useRef(null);
    const panelId = useId();

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (e) => {
            if (containerRef.current && !containerRef.current.contains(e.target)) {
                setOpen(false);
            }
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    return (
        <span ref={containerRef} className={clsx('relative inline-flex', className)}>
            <IconButton
                icon={Info}
                label={label}
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={open ? panelId : undefined}
            />
            {open && (
                <span
                    id={panelId}
                    role="note"
                    className={clsx(
                        'absolute top-full z-toast mt-1 block w-72 max-w-[80vw] rounded-card border border-line',
                        'bg-surface-card p-3 text-caption text-ink-muted shadow-lg',
                        align === 'right' ? 'right-0' : 'left-0'
                    )}
                >
                    {children}
                </span>
            )}
        </span>
    );
}
