import { useState, useRef, useEffect, useId } from 'react';
import { Info } from 'lucide-react';
import clsx from 'clsx';
import IconButton from './IconButton';
import Modal from './Modal';

/**
 * InfoPopover — a small click-to-toggle help bubble behind an info (i) icon.
 *
 * Used to tuck away scope/explanatory notes that would otherwise clutter a header.
 * Click-driven, not hover/`title`, because tooltips never fire on touch (DESIGN_SYSTEM §7).
 *
 * Two presentations, one behaviour: on `≥sm` it is the compact anchored bubble; on phones it
 * opens as a centred full-screen dialog through the canonical Modal, so it matches the
 * app-wide "pop-ups are shown full-screen, centred on mobile" rule instead of a cramped
 * bubble that can clip off the edge of a small screen.
 *
 * @param {string} [label] - accessible name for the trigger button.
 * @param {React.ReactNode} children - the help content shown in the panel.
 * @param {'left'|'right'} [align] - which edge of the trigger the bubble aligns to (desktop).
 */
export default function InfoPopover({ label = 'Daugiau informacijos', children, align = 'left', className }) {
    const [open, setOpen] = useState(false);
    const [isMobile, setIsMobile] = useState(false);
    const containerRef = useRef(null);
    const panelId = useId();

    // Track the breakpoint so we can switch between the anchored bubble and the full-screen
    // Modal. `<sm` mirrors Tailwind's `sm` breakpoint (640px).
    useEffect(() => {
        const mq = window.matchMedia('(max-width: 639px)');
        const update = () => setIsMobile(mq.matches);
        update();
        mq.addEventListener('change', update);
        return () => mq.removeEventListener('change', update);
    }, []);

    // Desktop bubble: dismiss on outside pointer-down / Escape. The mobile Modal handles its
    // own dismissal, so this listener only runs for the anchored bubble.
    useEffect(() => {
        if (!open || isMobile) return undefined;
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
    }, [open, isMobile]);

    return (
        <span ref={containerRef} className={clsx('relative inline-flex', className)}>
            <IconButton
                icon={Info}
                label={label}
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                aria-controls={open && !isMobile ? panelId : undefined}
            />
            {open && !isMobile && (
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
            {open && isMobile && (
                <Modal open onClose={() => setOpen(false)} title={label} size="sm">
                    <div role="note" className="text-body text-ink-muted">
                        {children}
                    </div>
                </Modal>
            )}
        </span>
    );
}
