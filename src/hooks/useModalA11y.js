import { useEffect } from 'react';

/**
 * useModalA11y — the one accessible-dialog behaviour shared by every modal/dialog shell
 * (DESIGN_SYSTEM §7/§8). Centralises what hand-rolled dialogs kept getting wrong:
 *
 *  - moves focus into the dialog (or `initialFocusRef`) when it opens,
 *  - restores focus to the previously-focused element on close,
 *  - closes on `Escape` when `dismissible`,
 *  - traps `Tab`/`Shift+Tab` inside the dialog so focus can never leak to the obscured
 *    page behind the scrim (WCAG 2.4.3).
 *
 * The dialog container must be a real element with `tabIndex={-1}` so it can hold focus
 * when it has no focusable children.
 *
 * @param {React.RefObject<HTMLElement>} dialogRef - ref on the dialog container.
 * @param {object} opts
 * @param {boolean} [opts.open=true] - whether the dialog is mounted/visible.
 * @param {() => void} [opts.onClose] - called on Escape (only when dismissible).
 * @param {boolean} [opts.dismissible=true] - Escape closes when true.
 * @param {React.RefObject<HTMLElement>} [opts.initialFocusRef] - element to focus on open.
 */
const FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'textarea:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useModalA11y(dialogRef, { open = true, onClose, dismissible = true, initialFocusRef } = {}) {
    useEffect(() => {
        if (!open) return undefined;

        const previouslyFocused = document.activeElement;
        const dialog = dialogRef.current;
        const initialTarget = initialFocusRef?.current || dialog;
        initialTarget?.focus?.();

        const getFocusable = () => {
            if (!dialog) return [];
            // Visible, focusable descendants in DOM order. `offsetParent === null` filters
            // out display:none / detached nodes (good enough for these dialogs).
            return Array.prototype.filter.call(
                dialog.querySelectorAll(FOCUSABLE_SELECTOR),
                (el) => el.offsetParent !== null || el === document.activeElement
            );
        };

        const onKeyDown = (e) => {
            if (e.key === 'Escape' && dismissible) {
                onClose?.();
                return;
            }
            if (e.key !== 'Tab' || !dialog) return;

            const focusable = getFocusable();
            if (focusable.length === 0) {
                // Nothing focusable inside — keep focus on the dialog itself.
                e.preventDefault();
                dialog.focus?.();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            const active = document.activeElement;

            if (e.shiftKey) {
                if (active === first || active === dialog || !dialog.contains(active)) {
                    e.preventDefault();
                    last.focus();
                }
            } else if (active === last || active === dialog || !dialog.contains(active)) {
                e.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            previouslyFocused?.focus?.();
        };
    }, [open, dismissible, onClose, dialogRef, initialFocusRef]);
}

export default useModalA11y;
