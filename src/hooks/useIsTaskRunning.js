import { useAuth } from '../context/AuthContext';

/**
 * Determines if a given task is truly running by checking activeSession
 * (primary) and workStatus (legacy fallback) from the current user's data.
 * 
 * This logic was duplicated in TaskCard.jsx and TaskTable.jsx.
 * 
 * @param {Object} task - The task object to check
 * @returns {boolean} Whether the task is actively running for the current user
 */
export const useIsTaskRunning = (task) => {
    const { currentUser, userData } = useAuth();

    if (!task || !currentUser) return false;

    const isAssignedToMe = currentUser.uid === task.assignedUserId;
    if (!isAssignedToMe || task.timerStatus !== 'running') return false;

    const activeSession = userData?.activeSession;

    if (activeSession) {
        // If there's any active session, only show running if it's this exact task
        return activeSession.type === 'task' && activeSession.taskId === task.id;
    }

    // Fallback to legacy workStatus when no activeSession exists
    if (userData?.workStatus) {
        if (userData.workStatus.status === 'running') {
            return userData.workStatus.activeTaskId === task.id;
        }
        if (userData.workStatus.status === 'idle' || userData.workStatus.status === 'paused') {
            return false;
        }
    }

    return false;
};
