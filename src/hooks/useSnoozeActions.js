import { useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { useUndoableAction } from './useUndoableAction';
import { formatSnoozeUntil } from '../utils/taskSnooze';
import { snoozeTask, unsnoozeTask, captureSnoozeState, restoreSnoozeState } from '../utils/taskSnoozeActions';

/**
 * useSnoozeActions — snooze / un-snooze as immediate, undoable actions (DESIGN_SYSTEM §8): a
 * snooze is cleanly reversible, so it commits at once and the toast offers "Atšaukti" — which
 * matters most for the swipe gesture, where an accidental swipe outdoors must cost one tap.
 */
export function useSnoozeActions() {
    const { currentUser } = useAuth();
    const runUndoable = useUndoableAction();

    const snooze = useCallback((task, untilIso, reason) => {
        const prior = captureSnoozeState(task);
        return runUndoable({
            run: () => snoozeTask(task, untilIso, reason, currentUser),
            undo: () => restoreSnoozeState(task, prior),
            message: `Atidėta iki ${formatSnoozeUntil(untilIso)}.`,
            undoneMessage: 'Atšaukta — veikla vėl sąraše.',
            errorMessage: 'Nepavyko atidėti veiklos. Bandykite dar kartą.',
        });
    }, [currentUser, runUndoable]);

    const unsnooze = useCallback((task) => {
        const prior = captureSnoozeState(task);
        return runUndoable({
            run: () => unsnoozeTask(task),
            undo: () => restoreSnoozeState(task, prior),
            message: 'Veikla grąžinta į sąrašą.',
            undoneMessage: 'Atšaukta — veikla vėl atidėta.',
            errorMessage: 'Nepavyko grąžinti veiklos. Bandykite dar kartą.',
        });
    }, [runUndoable]);

    return { snooze, unsnooze };
}
