import {
    doc,
    writeBatch,
} from 'firebase/firestore';

export function applyTimerTransitionPlan(db, plan) {
    if (!Array.isArray(plan?.writes) || plan.writes.length === 0) {
        throw new Error('Timer transition plan has no writes');
    }

    const batch = writeBatch(db);
    for (const write of plan.writes) {
        const ref = doc(db, write.path);
        if (write.type === 'update') {
            batch.update(ref, write.data);
        } else if (write.type === 'set') {
            if (write.merge) batch.set(ref, write.data, { merge: true });
            else batch.set(ref, write.data);
        } else {
            throw new Error(`Unsupported timer transition write: ${write.type}`);
        }
    }
    return batch.commit();
}
