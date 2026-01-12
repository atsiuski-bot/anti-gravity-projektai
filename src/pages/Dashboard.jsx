import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import ManagerView from './ManagerView';
import WorkerView from './WorkerView';
import AdminBootstrap from '../components/AdminBootstrap';
import { checkAndPromoteTasks, shouldRunAutomation, archiveOldTasks } from '../utils/automationUtils';

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
            {userRole === 'manager' || userRole === 'admin' ? <ManagerView /> : <WorkerView />}
        </>
    );
}
