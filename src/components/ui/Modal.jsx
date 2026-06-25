import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';
import { useModalA11y } from '../../hooks/useModalA11y';
import IconButton from './IconButton';

/**
 * Modal — the one dialog shell (DESIGN_SYSTEM §8). The single source of truth for how every
 * pop-up / dialog / notification overlay is presented, so they can never drift apart again.
 *
 *  - The `feedback.scrim` dims the whole viewport, on the managed z-ladder. The dialog is a
 *    content-sized card **centred over that scrim** — on phones it is centred over the full
 *    screen (never anchored to a corner or to a trigger), capped at `max-h-[90vh]` with the
 *    body scrolling; it is not stretched edge-to-edge.
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby` (from `title`/`ariaLabelledby`), with
 *    `aria-label` as the fallback accessible name.
 *  - `dismissible` (default true) is the master switch: it gates Escape, the header close `X`,
 *    AND the backdrop tap. Pass `dismissible={false}` for a destructive / forced-acknowledge
 *    dialog (no Escape, no `X`, no backdrop close).
 *  - `closeOnBackdrop` (default true) decouples the backdrop tap from Escape so a form that
 *    holds unsaved input can stay Escape-dismissible while a stray backdrop tap can no longer
 *    discard it. Backdrop closes only when `dismissible && closeOnBackdrop`; Escape and the `X`
 *    stay governed by `dismissible` alone. A non-destructive content dialog keeps the default
 *    (tap-to-dismiss); a form passes `closeOnBackdrop={false}`.
 *  - Focus moves into the dialog (or `initialFocusRef`) on open and is restored on close.
 *  - `bare` strips the default header + body padding so a caller can supply its own full-bleed
 *    chrome (e.g. the coloured time-warning / time-limit headers) while still inheriting the
 *    shared scrim, focus-trap and z-ladder. Bare children own the layout: header
 *    (`flex-shrink-0`), body (`flex-1 overflow-y-auto`), footer (`flex-shrink-0`).
 *  - `level="top"` raises the overlay above any other open modal — for the forced time-limit
 *    alarm, which can fire while a task modal is already open.
 */
const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl' };

export default function Modal({
    open = true,
    onClose,
    title,
    titleId = 'modal-title',
    ariaLabel,
    ariaLabelledby,
    role = 'dialog',
    children,
    footer,
    size = 'md',
    dismissible = true,
    closeOnBackdrop = true,
    bare = false,
    level = 'modal',
    className,
    initialFocusRef,
    align = 'center',
    hideCloseButton = false,
}) {
    const dialogRef = useRef(null);

    // Focus-in, focus restore, Escape, and a Tab focus-trap — all shared (WCAG 2.4.3).
    useModalA11y(dialogRef, { open, onClose, dismissible, initialFocusRef });

    if (!open) return null;

    const labelledBy = title ? titleId : ariaLabelledby;
    const showClose = dismissible && onClose && !hideCloseButton;
    const showChrome = !bare && (title || showClose);

    // Portal to <body> so the fixed overlay is never trapped by a transformed ancestor
    // (e.g. a swipeable TaskCard applies translateX, which would otherwise contain `fixed`).
    return createPortal(
        <div
            className={cn(
                'fixed inset-0 flex justify-center bg-feedback-scrim p-4 animate-in fade-in',
                align === 'top' ? 'items-start' : 'items-center',
                level === 'top' ? 'z-top' : 'z-backdrop'
            )}
            onMouseDown={(e) => {
                if (dismissible && closeOnBackdrop && e.target === e.currentTarget) onClose?.();
            }}
        >
            <div
                ref={dialogRef}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-label={!labelledBy ? ariaLabel : undefined}
                tabIndex={-1}
                className={cn(
                    'relative z-modal flex w-full flex-col overflow-hidden rounded-modal bg-surface-card shadow-xl',
                    'max-h-[90vh] focus:outline-none',
                    // Card settles in (fade + slight zoom) as the scrim fades behind it.
                    'animate-in fade-in zoom-in-95',
                    SIZES[size] || SIZES.md,
                    className
                )}
            >
                {showChrome && (
                    <div className="flex flex-shrink-0 items-start justify-between gap-4 p-6 pb-4">
                        {title ? (
                            <h2 id={titleId} className="text-h2 text-ink-strong">
                                {title}
                            </h2>
                        ) : (
                            <span />
                        )}
                        {showClose && (
                            <IconButton icon={X} label="Uždaryti" onClick={onClose} className="-mr-2 -mt-2" />
                        )}
                    </div>
                )}
                {bare ? (
                    children
                ) : (
                    <>
                        <div className={cn('flex-1 overflow-y-auto px-6 pb-6', !showChrome && 'pt-6')}>{children}</div>
                        {footer && <div className="flex-shrink-0 px-6 pb-6 pt-2">{footer}</div>}
                    </>
                )}
            </div>
        </div>,
        document.body
    );
}
