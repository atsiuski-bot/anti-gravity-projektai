import { collection, getDocs, query, where, updateDoc, doc, setDoc, deleteDoc } from 'firebase/firestore';
import { db } from '../firebase';

/**
 * Migration utility to fix old deleted tasks that don't have proper flags.
 * This finds tasks that should be deleted but don't have the new isDeleted flag or 'deleted' status.
 * 
 * Run this ONCE to migrate old data.
 */
export const migrateOldDeletedTasks = async () => {
    try {
        console.log('Starting migration of old deleted tasks...');

        // Check BOTH collections for tasks that need fixing

        // 1. Check archived_tasks for tasks missing the deleted status
        const archivedQ = query(collection(db, 'archived_tasks'));
        const archivedSnap = await getDocs(archivedQ);

        let updatedArchived = 0;
        for (const taskDoc of archivedSnap.docs) {
            const task = taskDoc.data();

            // If it has deletedAt but not the new flags, update it
            if (task.deletedAt && !task.isDeleted && task.status !== 'deleted') {
                await updateDoc(doc(db, 'archived_tasks', taskDoc.id), {
                    status: 'deleted',
                    isDeleted: true,
                    updatedAt: new Date().toISOString()
                });
                updatedArchived++;
                console.log(`Updated archived task: ${task.title}`);
            }
        }

        // 2. Check active tasks for old-style deleted tasks that should be archived
        const activeQ = query(
            collection(db, 'tasks'),
            where('completed', '==', true)
        );
        const activeSnap = await getDocs(activeQ);

        let movedToArchive = 0;
        for (const taskDoc of activeSnap.docs) {
            const task = { id: taskDoc.id, ...taskDoc.data() };

            // If it has deletedAt, it's an old deleted task that should be in archive
            if (task.deletedAt) {
                const { id, ...taskData } = task;

                // Move to archived_tasks with proper flags
                await setDoc(doc(db, 'archived_tasks', id), {
                    ...taskData,
                    status: 'deleted',
                    isDeleted: true,
                    updatedAt: new Date().toISOString()
                });

                // Delete from active tasks
                await deleteDoc(doc(db, 'tasks', id));

                movedToArchive++;
                console.log(`Moved to archive: ${task.title}`);
            }
        }

        const message = `Migracija baigta!\n\nAtnaujinta archyve: ${updatedArchived}\nPerkelti į archyvą: ${movedToArchive}\n\nPrašome atnaujinti puslapį.`;
        console.log(message);
        alert(message);

    } catch (error) {
        console.error('Error during migration:', error);
        alert('Klaida migracijos metu: ' + error.message);
    }
};
