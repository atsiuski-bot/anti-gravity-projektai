import { collection, getDocs, updateDoc, doc } from 'firebase/firestore';
import { db } from '../firebase';

export const runDatabaseMigration = async () => {
    console.log('=== DB Migration v4 ===');
    let updatedCount = 0;
    let errorCount = 0;

    const migrateCollection = async (collectionName) => {
        console.log(`Migrating ${collectionName}...`);
        try {
            const colRef = collection(db, collectionName);
            const snapshot = await getDocs(colRef);
            let collectionUpdated = 0;

            for (const document of snapshot.docs) {
                const data = document.data();
                const updates = {};

                // If assignedUserId is missing, copy from assignedWorkerId
                if (!data.assignedUserId && data.assignedWorkerId) {
                    updates.assignedUserId = data.assignedWorkerId;
                }

                if (Object.keys(updates).length > 0) {
                    try {
                        await updateDoc(doc(db, collectionName, document.id), updates);
                        updatedCount++;
                        collectionUpdated++;
                    } catch (e) {
                        errorCount++;
                        console.error(`Failed to update doc ${document.id} in ${collectionName}:`, e);
                    }
                }
            }
            console.log(`  ✓ ${collectionName}: updated ${collectionUpdated} / ${snapshot.size} docs`);
        } catch (e) {
            errorCount++;
            console.error(`  ✗ Failed to read ${collectionName}:`, e.message);
        }
    };

    await migrateCollection('tasks');
    await migrateCollection('archived_tasks');

    const msg = `Migration v4 complete! Updated ${updatedCount} documents. Errors: ${errorCount}`;
    console.log(msg);
    alert(msg);
};

// Diagnostic: inspect task assignment fields
export const diagnoseTasks = async () => {
    console.log('=== Task Assignment Diagnosis ===');
    const colRef = collection(db, 'tasks');
    const snapshot = await getDocs(colRef);

    let hasAssignedUserId = 0;
    let missingCount = 0;

    for (const document of snapshot.docs) {
        const data = document.data();
        if (data.assignedUserId && data.assignedUserId.length > 0) {
            hasAssignedUserId++;
        } else {
            missingCount++;
        }
    }

    console.log(`Total: ${snapshot.size}, Has assignedUserId: ${hasAssignedUserId}, Missing: ${missingCount}`);
};
