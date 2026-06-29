import { db } from '../firebase';
import { collection, doc, addDoc, updateDoc, deleteDoc } from 'firebase/firestore';
import { logCalendarChange } from './calendarNotifications';
import { notify } from './notify';

/**
 * Single source of truth for acting on a worker's pending calendar request (the `calendar_requests`
 * approval workflow). BOTH approval surfaces route through here — the manager notification bell
 * (ManagerNotifications) and the team "Kalendoriaus istorija" tab (CalendarChangeHistory) — so the
 * two can never drift in WHAT they write: approving must apply the change to `work_hours`, flip the
 * request, log the audit entry, and notify the worker as one indivisible act.
 *
 * The critical Firestore writes (work_hours + the status flip) are awaited and may THROW; each caller
 * wraps the call to surface its own localized banner. `notify`/`logCalendarChange` swallow their own
 * errors (a lost notification must never block the approval that already committed).
 *
 * `actor` is the signed-in approver: `{ uid, displayName, email }`.
 */

// Apply the requested change to the worker's planned hours, mark the request approved, log it, and
// tell the worker. Mirrors the old inline bell handler verbatim — keep the two in lockstep.
export async function approveCalendarRequest(request, actor) {
    const { type, requestedEvent, userId, userName } = request;
    const now = new Date().toISOString();

    if (type === 'add') {
        // requestedEvent carries a synthetic id:null for adds (a real id only exists for edit/delete);
        // strip it so it never lands on the work_hours doc and can't clobber doc.id for a future
        // reader doing {id: doc.id, ...data}.
        const addData = { ...requestedEvent, userId, type: 'planned' };
        delete addData.id;
        await addDoc(collection(db, 'work_hours'), addData);
    } else if (type === 'edit') {
        await updateDoc(doc(db, 'work_hours', requestedEvent.id), {
            start: requestedEvent.start,
            end: requestedEvent.end,
            title: requestedEvent.title,
            isWorkFromHome: requestedEvent.isWorkFromHome,
            isVacation: requestedEvent.isVacation,
            absenceType: requestedEvent.absenceType ?? null,
        });
    } else if (type === 'delete') {
        await deleteDoc(doc(db, 'work_hours', requestedEvent.id));
    }

    await updateDoc(doc(db, 'calendar_requests', request.id), {
        status: 'approved',
        approvedAt: now,
        approvedBy: actor.uid,
    });

    await logCalendarChange(
        { uid: userId, displayName: userName, email: '' },
        type === 'edit' ? 'edit' : type,
        new Date(requestedEvent.start),
        new Date(requestedEvent.end),
    );

    await notify({
        recipientId: userId,
        type: 'calendar_decision',
        decision: 'approved',
        reason: request.reason || null,
        actorUid: actor.uid,
        actorName: actor.displayName || actor.email,
    });
}

// Decline the request (no work_hours touched) and tell the worker.
export async function declineCalendarRequest(request, actor) {
    await updateDoc(doc(db, 'calendar_requests', request.id), {
        status: 'declined',
        declinedAt: new Date().toISOString(),
        declinedBy: actor.uid,
    });

    await notify({
        recipientId: request.userId,
        type: 'calendar_decision',
        decision: 'declined',
        reason: request.reason || null,
        actorUid: actor.uid,
        actorName: actor.displayName || actor.email,
    });
}
