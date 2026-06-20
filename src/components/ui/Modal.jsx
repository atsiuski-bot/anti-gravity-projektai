import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';
import IconButton from './IconButton';

/**
 * Modal — the one dialog shell (DESIGN_SYSTEM §8). Replaces the ~10 hand-rolled modal
 * scaffolds with their drifting scrim opacities, radii and z-index values.
 *
 *  - Scrim at the single `feedback.scrim` opacity, on the managed z-ladder.
 *  - `role="dialog"` + `aria-modal` + `aria-labelledby` (when a `title` is given).
 *  - Escape closes; tapping the backdrop closes — both gated by `dismissible`
 *    (pass `dismissible={false}` for a destructive / forced-acknowledge dialog).
 *  - Focus moves into the dialog (or `initialFocusRef`) on open and is restored on close.
 */
const SIZES = { sm: 'max-w-sm', md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-2xl' };

export default function Modal({
    open = true,
    onClose,
    title,
    titleId = 'modal-title',
    ariaLabel,
    children,
    footer,
    size = 'md',
    dismissible = true,
    className,
    initialFocusRef,
}) {
    const dialogRef = useRef(null);
    const restoreFocusRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        restoreFocusRef.current = document.activeElement;
        const target = initialFocusRef?.current || dialogRef.current;
        target?.focus?.();

        const onKey = (e) => {
            if (e.key === 'Escape' && dismissible) onClose?.();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('keydown', onKey);
            restoreFocusRef.current?.focus?.();
        };
    }, [open, dismissible, onClose, initialFocusRef]);

    if (!open) return null;

    // Portal to <body> so the fixed overlay is never trapped by a transformed ancestor
    // (e.g. a swipeable TaskCard applies translateX, which would otherwise contain `fixed`).
    return createPortal(
        <div
            className="fixed inset-0 z-backdrop flex items-center justify-center p-4 bg-feedback-scrim"
            onMouseDown={(e) => {
                if (dismissible && e.target === e.currentTarget) onClose?.();
            }}
        >
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                aria-label={!title ? ariaLabel : undefined}
                tabIndex={-1}
                className={cn(
                    'relative z-modal w-full bg-surface-card rounded-modal shadow-xl',
                    'max-h-[90vh] overflow-y-auto focus:outline-none',
                    SIZES[size] || SIZES.md,
                    className
                )}
            >
                {(title || (dismissible && onClose)) && (
                    <div className="flex items-start justify-between gap-4 p-6 pb-4">
                        {title ? (
                            <h2 id={titleId} className="text-h2 text-ink-strong">
                                {title}
                            </h2>
                        ) : (
                            <span />
                        )}
                        {dismissible && onClose && (
                            <IconButton icon={X} label="Uždaryti" onClick={onClose} className="-mr-2 -mt-2" />
                        )}
                    </div>
                )}
                <div className={cn('px-6 pb-6', !title && !(dismissible && onClose) && 'pt-6')}>{children}</div>
                {footer && <div className="px-6 pb-6 pt-2">{footer}</div>}
            </div>
        </div>,
        document.body
    );
}
