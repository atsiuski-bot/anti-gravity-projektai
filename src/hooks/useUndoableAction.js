import { useCallback } from 'react';
import { useToast } from '../context/ToastContext';
import { logError } from '../utils/errorLog';

/**
 * useUndoableAction — the one way to make a reversible action undoable (DESIGN_SYSTEM §8).
 *
 * The control-logic principle behind it: a confirm dialog is the right guard for an IRREVERSIBLE
 * action (stop it before it happens); a cleanly REVERSIBLE one-tap state flip is better served by
 * acting immediately and offering an undo for a few seconds (no dialog friction, a compensating
 * inverse as the safety net). WORKZ is realtime + multi-device, so undo is NEVER a deferred write
 * (that would desync other devices and lose the pending op on reload) — the forward action commits
 * now and `undo` applies the inverse. The audited command layer (ADR 0015) already exposes those
 * inverse verbs (completeTask ↔ reopenTask, …), so an undo is itself a first-class, audited decision.
 *
 * For an action whose only OUTWARD side-effect is a notification to someone else (e.g. a manager
 * approving a worker's task), pass `deferredEffect`: the local state change still commits NOW (so
 * other managers see it live), but the outbound notification is HELD for the undo window and only
 * fires if the user does NOT undo. That makes the undo perfectly clean — if undone, the worker is
 * never pinged at all, instead of being pinged and then silently contradicted.
 *
 * Usage:
 *   const runUndoable = useUndoableAction();
 *   await runUndoable({
 *     run:   () => completeTask({ task }, ...),   // the forward action (committed immediately)
 *     undo:  () => reopenTask({ task }, ...),     // the inverse (fired if the user taps Atšaukti)
 *     message: 'Užduotis pažymėta atlikta.',      // the snackbar copy
 *     undoneMessage: 'Atšaukta — užduotis grąžinta.',
 *     deferredEffect: () => notify({ ... }),      // optional: held for the window, skipped on undo
 *   });
 *
 * @returns {(opts: {
 *   run: () => any | Promise<any>,
 *   undo: () => any | Promise<any>,
 *   message: string,
 *   undoneMessage?: string,
 *   undoLabel?: string,
 *   tone?: 'info'|'success'|'warning'|'notification',
 *   duration?: number,
 *   errorMessage?: string,
 *   deferredEffect?: (() => any | Promise<any>) | null,
 * }) => Promise<boolean>} runs the action; resolves true on success, false if `run` threw.
 */
export function useUndoableAction() {
    const { showToast } = useToast();

    return useCallback(async ({
        run,
        undo,
        message,
        undoneMessage = 'Veiksmas atšauktas.',
        undoLabel = 'Atšaukti',
        tone = 'success',
        duration = 6000,
        errorMessage = 'Nepavyko atlikti veiksmo. Bandykite dar kartą.',
        deferredEffect = null,
    }) => {
        try {
            await run();
        } catch (err) {
            logError(err, { source: 'useUndoableAction.run' });
            showToast(errorMessage, { tone: 'warning' });
            return false;
        }

        // Hold the outbound side-effect (e.g. a notification) for the undo window. The timer is
        // intentionally NOT tied to React lifecycle: if the user closes the panel without undoing,
        // the effect must still fire. Undo flips `undone` and cancels it so it never runs.
        let undone = false;
        let deferTimer = null;
        if (deferredEffect) {
            deferTimer = setTimeout(() => {
                if (undone) return;
                Promise.resolve().then(deferredEffect).catch((err) => logError(err, { source: 'useUndoableAction.deferredEffect' }));
            }, duration);
        }

        showToast(message, {
            tone,
            duration,
            action: {
                label: undoLabel,
                onClick: async () => {
                    undone = true;
                    if (deferTimer) clearTimeout(deferTimer);
                    try {
                        await undo();
                        showToast(undoneMessage, { tone: 'info', duration: 2500 });
                    } catch (err) {
                        logError(err, { source: 'useUndoableAction.undo' });
                        showToast('Nepavyko atšaukti. Bandykite dar kartą.', { tone: 'warning' });
                    }
                },
            },
        });
        return true;
    }, [showToast]);
}
