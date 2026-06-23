import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';

/**
 * Fire a recurring template's task NOW (the manager's "Sukurti dabar" / run-now control), via the
 * server callable that shares the scheduled generator's logic: same idempotent de-dup (one task per
 * template per Vilnius day), same sourceTemplateId provenance, same absence detection + reassignment
 * notification. Running it server-side (admin SDK) keeps the manual path identical to the automatic
 * one instead of forking the rules into the client.
 *
 * @param {string} templateId - the template to materialize now (required).
 * @returns {Promise<{created: boolean, taskId?: string, deduped?: boolean, needsReassignment?: boolean, reason?: string}>}
 */
export const runRecurringNow = async (templateId) => {
    const fn = httpsCallable(functions, 'runRecurringTasksNow');
    const res = await fn({ templateId });
    return res.data;
};
