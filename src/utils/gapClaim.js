import { doc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { notifyMany } from './notify';
import { overseerRecipients } from './teamScope';
import { logError } from './errorLog';
import { formatMinutesToTimeString, getLithuanianDateString } from './timeUtils';
import { formatTime } from './formatters';

/**
 * ADR 0025 — escalate a work gap the system REFUSED to auto-credit.
 *
 * Recovery credits the heartbeat-proven stretch and then asks isCreditableUntrackedGap about the
 * unproven tail. A tail over MAX_UNTRACKED_GAP_MINUTES (or spanning two work days) is refused, which
 * is right: such an interval is as likely a forgotten timer as real work, and the previous 16h bound
 * once paid 623 minutes for a night's sleep. What was WRONG is where the refusal went — an opt-in
 * offer in one device's localStorage, shown once, to the worker alone. Real worked time was forfeited
 * in silence (Povilas, 2026-07-29: 3h51m, found only because he complained the next day).
 *
 * This makes the refusal an obligation somebody holds: every overseer of the worker gets an ACTION
 * notification they can settle in one tap. The worker's own localStorage offer is deliberately left
 * in place — the two are idempotent (both land on the same deterministic
 * `sess_gap_{taskId}_{fromMs}` row), so whoever acts first simply settles it.
 */

// One human line the manager reads in the bell: whose time, when, how long, and why it was not
// credited automatically. Built here (not in the card) so the in-app row and the OS push — which can
// only render the stored fields — tell the identical story. Exported for the unit tests.
export const gapClaimSummary = ({ fromIso, toIso, gapMinutes, taskTitle }) => {
    const day = getLithuanianDateString(fromIso);
    const span = `${formatTime(fromIso)}–${formatTime(toIso)}`;
    const dur = formatMinutesToTimeString(Math.round(gapMinutes));
    return `Neužfiksuotas darbo laikas: ${day} ${span} (${dur}) — „${taskTitle || 'Veikla'}“.`
        + ' Programa jo neužskaitė automatiškai, nes tarpas per ilgas. Patvirtinkite arba atmeskite.';
};

/**
 * Raise the claim to every overseer of the worker.
 *
 * The recipients are resolved by READING the worker's own user doc rather than taking them from React
 * context: the two recovery hooks carry only `currentUser`, and threading `userData` through both
 * (plus their tests) to obtain a field the worker can simply read is churn for no gain. Offline the
 * read is served from the persistent cache — the user doc is fetched on every boot — so the very
 * offline condition that creates a gap does not defeat this.
 *
 * BEST-EFFORT, and never throws: this runs inside crash recovery, where a failure must not abort the
 * pause/credit that already succeeded. A failure IS recorded durably, because a refused gap that
 * reached nobody is exactly the silent loss this exists to end.
 *
 * @param {Object} args
 * @param {Object} args.task    - { id, title } the run that was recovered.
 * @param {Object} args.worker  - the signed-in worker (uid + display name); the time is theirs.
 * @param {string} args.fromIso - gap start (the last proven instant).
 * @param {string} args.toIso   - gap end (the recovery instant).
 * @param {number} args.gapMinutes
 * @param {string} args.cause   - why auto-credit declined, for triage.
 * @param {string} args.engine  - 'legacy' | 'canonical'; the two paths must behave the same.
 * @returns {Promise<{ok: boolean, recipients: number, error?: string}>}
 */
export const raiseRefusedGapClaim = async ({
    task, worker, fromIso, toIso, gapMinutes, cause, engine,
} = {}) => {
    if (!task?.id || !worker?.uid || !fromIso || !toIso) {
        return { ok: false, recipients: 0, error: 'missing' };
    }

    let recipients = [];
    try {
        const snap = await getDoc(doc(db, 'users', worker.uid));
        recipients = overseerRecipients(snap.exists() ? snap.data() : null);
    } catch (err) {
        logError(err, { source: 'readFail:raiseRefusedGapClaim', taskId: task.id });
        return { ok: false, recipients: 0, error: 'read' };
    }

    // Nobody above them. Not an error — a worker can legitimately have no overseer — but it does mean
    // the escalation did not happen, so it must leave a trace instead of reporting success. The
    // worker's own claim offer is still their route.
    if (recipients.length === 0) {
        logError(new Error('refused gap has no overseer to escalate to'), {
            source: 'gapClaim:noRecipients', taskId: task.id, userId: worker.uid, fromIso, toIso,
        });
        return { ok: false, recipients: 0, error: 'no-overseer' };
    }

    const workerName = worker.displayName || worker.email || 'Meistras';
    try {
        await notifyMany(recipients, {
            type: 'time_gap_claim',
            // The worker is both the subject and the author: notify() uses `userId` as the provenance
            // field the rules check, and UserChip renders the pair on the card.
            userId: worker.uid,
            userName: workerName,
            taskId: task.id,
            taskTitle: task.title || 'Užduotis',
            // The interval under negotiation. `gapFrom/To` rather than `startTime/endTime` so nothing
            // downstream mistakes an unsettled CLAIM for a credited session.
            gapFromIso: fromIso,
            gapToIso: toIso,
            gapMinutes: Math.round(gapMinutes),
            gapCause: cause || 'unknown',
            gapEngine: engine || 'unknown',
            commentText: gapClaimSummary({ fromIso, toIso, gapMinutes, taskTitle: task.title }),
        });
        return { ok: true, recipients: recipients.length };
    } catch (err) {
        logError(err, { source: 'writeFail:raiseRefusedGapClaim', taskId: task.id, fromIso, toIso });
        return { ok: false, recipients: recipients.length, error: 'write' };
    }
};
