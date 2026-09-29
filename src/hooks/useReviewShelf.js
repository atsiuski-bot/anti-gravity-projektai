import { useCallback, useMemo } from 'react';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { getShelfIds, setOnReviewShelf } from '../utils/reviewShelf';
import { isManagerRole } from '../utils/formatters';
import { logError } from '../utils/errorLog';

/**
 * useReviewShelf — the signed-in manager's "Peržiūrai" shelf (see utils/reviewShelf.js).
 *
 * The shelf lives on the caller's own users doc, which AuthContext already listens to live, so this
 * hook reads it from `userData` (pending local writes included — a tap shows immediately) and needs
 * no listener of its own. Workers get an inert shelf (`enabled: false`): reviewing a finished task
 * for later is a koordinatorius activity, and every surface gates its control on `enabled`.
 *
 * @returns {{ enabled: boolean, ids: string[], isShelved: (taskId: string) => boolean,
 *            toggle: (task: { id: string }) => Promise<void>, remove: (taskId: string) => Promise<boolean> }}
 */
export function useReviewShelf() {
    const { currentUser, userData, userRole } = useAuth();
    const { showToast } = useToast();
    const uid = currentUser?.uid;
    const enabled = !!uid && isManagerRole(userRole);
    const ids = useMemo(() => (enabled ? getShelfIds(userData) : []), [enabled, userData]);
    const idSet = useMemo(() => new Set(ids), [ids]);
    const isShelved = useCallback((taskId) => idSet.has(taskId), [idSet]);

    const toggle = useCallback(async (task) => {
        if (!enabled || !task?.id) return;
        const on = !idSet.has(task.id);
        try {
            await setOnReviewShelf(uid, task.id, on);
            showToast(on ? 'Pridėta į „Peržiūrai“.' : 'Pašalinta iš „Peržiūrai“.', { tone: 'success', duration: 2500 });
        } catch (err) {
            logError(err, { source: 'useReviewShelf.toggle' });
            showToast('Nepavyko atnaujinti „Peržiūrai“ sąrašo. Bandykite dar kartą.', { tone: 'warning' });
        }
    }, [enabled, idSet, uid, showToast]);

    const remove = useCallback(async (taskId) => {
        if (!enabled || !taskId) return false;
        try {
            await setOnReviewShelf(uid, taskId, false);
            return true;
        } catch (err) {
            logError(err, { source: 'useReviewShelf.remove' });
            showToast('Nepavyko pašalinti iš „Peržiūrai“. Bandykite dar kartą.', { tone: 'warning' });
            return false;
        }
    }, [enabled, uid, showToast]);

    return { enabled, ids, isShelved, toggle, remove };
}
