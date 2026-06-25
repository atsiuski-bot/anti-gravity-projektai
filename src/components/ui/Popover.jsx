import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import IconButton from './IconButton';

/**
 * Popover — a desktop anchored dropdown surface (DESIGN_SYSTEM §8 sanctioned exception, the same
 * "anchor on desktop" affordance `Select`/`DatePicker` already use; phones keep the centred `Modal`).
 *
 * It is NON-modal: the page behind stays live (no scrim, no focus trap), unlike `Modal`. It renders
 * through a portal to <body> and positions itself from the anchor's bounding box, because the bell
 * lives under `AppHeader`'s `backdrop-blur` — a containing block that would clip an in-flow absolute
 * panel. Fixed + measured coordinates escape that and pin to the viewport.
 *
 *  - Right edge aligns to the anchor's right edge (grows LEFT, like GitHub/Slack/Linear), clamped so
 *    it never overflows the viewport; `maxHeight` is the room below the anchor (≤70vh) and the list
 *    scrolls inside while the header stays pinned.
 *  - Dismissal: Escape, or a pointerdown outside the panel AND the anchor. Escape and the close `X`
 *    return focus to the anchor; an outside click does not steal it.
 *  - While a `Modal` is open ABOVE the popover (e.g. a delete-confirm launched from a card), that
 *    modal OWNS dismissal — a click into it must not tear the popover (and its host subtree) down
 *    mid-interaction, which would drop the modal's own state and the click's handler. We detect this
 *    by the presence of any live `[aria-modal="true"]` and defer.
 *  - Sits on `z-nav` (above the sticky header, below the modal/toast ladder), so a launched modal and
 *    transient toasts both layer over it correctly.
 *
 * @param {{current: HTMLElement|null}} anchorRef - the trigger element to anchor to.
 * @param {boolean} open
 * @param {() => void} onClose
 * @param {string} title - the pinned heading; also the accessible name.
 * @param {string} [id] - the panel's DOM id (so the trigger can `aria-controls` it).
 * @param {number} [width] - panel width in px (default 400).
 */
const GAP = 8;       // px below the anchor
const MARGIN = 8;    // px minimum viewport inset on every side
const DEFAULT_WIDTH = 400;

export default function Popover({ anchorRef, open, onClose, title, id = 'popover', width = DEFAULT_WIDTH, hideHeader = false, children }) {
    const panelRef = useRef(null);
    const [pos, setPos] = useState(null);
    const titleId = `${id}-title`;

    // Position from the anchor's rect; recompute on open, on resize, and on ANY ancestor scroll
    // (capture) so the panel stays pinned to the bell. useLayoutEffect → positioned before first paint.
    useLayoutEffect(() => {
        if (!open) { setPos(null); return undefined; }
        const recompute = () => {
            const a = anchorRef.current;
            if (!a) return;
            const r = a.getBoundingClientRect();
            const left = Math.min(
                Math.max(r.right - width, MARGIN),
                Math.max(MARGIN, window.innerWidth - width - MARGIN),
            );
            // Never claim more vertical room than exists below the anchor — capped at 70vh, floored at
            // 0 — so a short desktop window scrolls the list internally instead of overflowing the page.
            const maxHeight = Math.max(0, Math.min(
                Math.round(window.innerHeight * 0.7),
                window.innerHeight - r.bottom - GAP - MARGIN,
            ));
            const top = r.bottom + GAP;
            // Bail out of the re-render when nothing moved (the bell sits in a sticky header, so most
            // scrolls leave it put) — keeps this cheap even on the panel's own internal scrolling.
            setPos((prev) => (prev && prev.top === top && prev.left === left && prev.maxHeight === maxHeight) ? prev : { top, left, maxHeight });
        };
        // Internal panel scrolling can't move the anchor — skip the layout read for those events.
        const onScroll = (e) => { if (panelRef.current && panelRef.current.contains(e.target)) return; recompute(); };
        recompute();
        window.addEventListener('resize', recompute);
        window.addEventListener('scroll', onScroll, true);
        return () => {
            window.removeEventListener('resize', recompute);
            window.removeEventListener('scroll', onScroll, true);
        };
    }, [open, width, anchorRef]);

    // Move focus into the panel on open (the rAF lands after the position re-render has mounted it).
    useEffect(() => {
        if (!open) return undefined;
        const raf = requestAnimationFrame(() => panelRef.current?.focus());
        return () => cancelAnimationFrame(raf);
    }, [open]);

    // Escape + outside-pointerdown dismissal. Listeners live only while open.
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            // A modal launched from inside the popover owns dismissal — never close under it.
            if (document.querySelector('[aria-modal="true"]')) return;
            const p = panelRef.current;
            const a = anchorRef.current;
            if (p && !p.contains(e.target) && a && !a.contains(e.target)) onClose?.();
        };
        const onKey = (e) => {
            // A modal open ABOVE the popover (e.g. the delete-confirm launched from a card) owns Escape
            // too — mirror the pointerdown guard so one Escape doesn't tear the popover (and the modal's
            // host subtree) down. The topmost Modal's own handler closes just the modal.
            if (e.key !== 'Escape' || document.querySelector('[aria-modal="true"]')) return;
            onClose?.();
            requestAnimationFrame(() => anchorRef.current?.focus());
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [open, onClose, anchorRef]);

    if (!open || !pos) return null;

    const closeAndRestore = () => { onClose?.(); requestAnimationFrame(() => anchorRef.current?.focus()); };

    return createPortal(
        <div
            ref={panelRef}
            id={id}
            role="dialog"
            aria-modal="false"
            aria-labelledby={hideHeader ? undefined : titleId}
            aria-label={hideHeader ? title : undefined}
            tabIndex={-1}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width, maxHeight: pos.maxHeight, transformOrigin: 'top right' }}
            className="z-nav flex flex-col overflow-hidden rounded-card border border-line bg-surface-card shadow-lg animate-in fade-in zoom-in-95 slide-in-from-top-2 focus:outline-none"
        >
            {!hideHeader && (
                <div className="flex flex-shrink-0 items-center justify-between border-b border-line px-4 py-3">
                    <h2 id={titleId} className="text-body font-semibold text-ink-strong">{title}</h2>
                    <IconButton icon={X} label="Uždaryti" onClick={closeAndRestore} className="-mr-1" />
                </div>
            )}
            <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-3">
                {children}
            </div>
        </div>,
        document.body,
    );
}
