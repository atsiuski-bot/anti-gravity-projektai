import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import AdminBootstrap from '../components/AdminBootstrap';
import { shouldRunAutomation, checkAndPromoteTasks, archiveOldTasks } from '../utils/automationUtils';
const ManagerView = React.lazy(() => import('./ManagerView'));
const WorkerView = React.lazy(() => import('./WorkerView'));

export default function Dashboard() {
    const { userRole } = useAuth();

    useEffect(() => {
        const runAutomation = async () => {
            if (shouldRunAutomation()) {
                console.log("[Dashboard] Running daily automation...");
                await checkAndPromoteTasks();
                await archiveOldTasks();
            }
        };
        runAutomation();
    }, []);

    return (
        <>
            <AdminBootstrap />
            <React.Suspense fallback={
                <div className="flex items-center justify-center p-8">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900"></div>
                </div>
            }>
                {userRole === 'manager' || userRole === 'admin' ? <ManagerView /> : <WorkerView />}
            </React.Suspense>
        </>
    );
}
