// Firestore writes for standing duties (see ./duties.js for the model). A duty lives at
// duties/{id}; every "covered through" mark is also appended to duties/{id}/marks so the history of
// who marked what, and when, survives a later correction. Nothing here touches work time.

import { addDoc, collection, doc, serverTimestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Create a duty. `ownerId` is the person responsible; rules let a coordinator create only their
 * own, and an admin create one for anyone.
 */
export async function createDuty({ title, intervalDays, ownerId }, actorId) {
    return addDoc(collection(db, 'duties'), {
        title: title.trim(),
        intervalDays,
        ownerId,
        coveredThrough: null,
        lastNote: null,
        lastMarkedAt: null,
        lastMarkedBy: null,
        archived: false,
        createdBy: actorId,
        createdAt: serverTimestamp(),
    });
}

/** Edit a duty's title / cadence (and, for an admin, its owner). */
export async function updateDuty(dutyId, { title, intervalDays, ownerId }) {
    const patch = { title: title.trim(), intervalDays };
    if (ownerId) patch.ownerId = ownerId;
    return updateDoc(doc(db, 'duties', dutyId), patch);
}

/** Hide a duty from the list. Never a hard delete: its mark history stays readable. */
export async function archiveDuty(dutyId) {
    return updateDoc(doc(db, 'duties', dutyId), { archived: true });
}

/**
 * Record "done through `coveredThrough` (inclusive)". The duty's watermark and the history entry are
 * written in ONE batch, so the list and its history can never disagree.
 */
export async function markDuty(dutyId, { coveredThrough, note }, actorId) {
    const cleanNote = String(note || '').trim() || null;
    const batch = writeBatch(db);
    batch.update(doc(db, 'duties', dutyId), {
        coveredThrough,
        lastNote: cleanNote,
        lastMarkedAt: serverTimestamp(),
        lastMarkedBy: actorId,
    });
    batch.set(doc(collection(db, 'duties', dutyId, 'marks')), {
        coveredThrough,
        note: cleanNote,
        markedBy: actorId,
        markedAt: serverTimestamp(),
    });
    return batch.commit();
}
