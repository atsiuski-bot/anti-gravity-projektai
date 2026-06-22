import { useEffect } from 'react';

/**
 * useModalA11y — the one accessible-dialog behaviour shared by every modal/dialog shell
 * (DESIGN_SYSTEM §7/§8). Centralises what hand-rolled dialogs kept getting wrong:
 *
 *  - moves focus into the dialog (or `initialFocusRef`) when it opens,
 *  - restores focus to the previously-focused element on close (only if it still exists —
 *    a destructive confirm can unmount the trigger),
 *  - closes on `Escape` when `dismissible`,
 *  - traps `Tab`/`Shift+Tab` inside the dialog so focus can never leak to the obscured
 *    page behind the scrim (WCAG 2.4.3).
 *
 * Stacked dialogs are handled: a module-level stack tracks the open dialogs and only the
 * topmost one reacts to keys, so a globally-mounted timer alarm appearing over an open
 * details modal doesn't fight it for focus or close both on a single Escape.
 *
 * Stack membership lives in its own effect keyed solely on `[open, dialogRef]`, so an
 * unstable `onClose` identity (inline arrows that change on every parent re-render) re-binds
 * only the cheap keydown listener and never reorders the stack — the genuinely-topmost
 * dialog stays topmost.
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

// Open dialog nodes, deepest last. Only the topmost handles Escape/Tab.
const dialogStack = [];

export function useModalA11y(dialogRef, { open = true, onClose, dismissible = true, initialFocusRef } = {}) {
    // Stack membership + focus, tied to actual open/close only. Keeping `onClose` out of these
    // deps is deliberate: the stack must not reorder when a parent re-render hands a new
    // onClose closure to a background dialog (which would displace the real topmost one).
    useEffect(() => {
        if (!open) return undefined;

        const dialog = dialogRef.current;
        const previouslyFocused = document.activeElement;
        if (dialog) dialogStack.push(dialog);

        const initialTarget = initialFocusRef?.current || dialog;
        initialTarget?.focus?.();

        return () => {
            if (dialog) {
                const idx = dialogStack.lastIndexOf(dialog);
                if (idx !== -1) dialogStack.splice(idx, 1);
            }
            // Only restore if the trigger still exists — a destructive confirm may have
            // unmounted it, and focusing a detached node silently drops focus to <body>.
            if (previouslyFocused && previouslyFocused.isConnected) previouslyFocused.focus?.();
        };
    }, [open, dialogRef, initialFocusRef]);

    // Keydown (Escape + Tab trap). May re-bind freely when onClose/dismissible change; it
    // reads the live topmost from the module stack, so re-binding never affects ordering.
    useEffect(() => {
        if (!open) return undefined;

        const dialog = dialogRef.current;
        const isTopmost = () => dialogStack[dialogStack.length - 1] === dialog;

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
            // Only the topmost dialog reacts — lower dialogs stay inert behind the scrim.
            if (!dialog || !isTopmost()) return;

            if (e.key === 'Escape') {
                if (dismissible) {
                    e.stopPropagation();
                    onClose?.();
                }
                return;
            }
            if (e.key !== 'Tab') return;

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
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [open, dismissible, onClose, dialogRef]);
}

export default useModalA11y;
