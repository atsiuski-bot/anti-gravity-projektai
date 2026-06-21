import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { isManagerRole } from '../utils/formatters';
import AdminBootstrap from '../components/AdminBootstrap';
import { runDailyAutomation } from '../utils/automationUtils';
import { Spinner } from '../components/ui/Loading';
const ManagerView = React.lazy(() => import('./ManagerView'));
const WorkerView = React.lazy(() => import('./WorkerView'));

export default function Dashboard() {
    const { userRole } = useAuth();

    useEffect(() => {
        const runAutomation = async () => {
            // Only managers/admins may run the team-wide automation: it promotes and
            // archives EVERY user's tasks, which the security rules (correctly) permit
            // only for managers. A worker running it would hit permission-denied on the
            // first colleague's task AND, via the once-per-day shouldRunAutomation()
            // localStorage flag, suppress the manager's run for the rest of the day.
            // Mirrors the manager-gated trigger in Layout.jsx. `userRole` is in the deps
            // so the effect re-runs once auth resolves the role (it is undefined at mount).
            if (isManagerRole(userRole)) {
                console.log("[Dashboard] Running daily automation...");
                await runDailyAutomation();
            }
        };
        runAutomation();
    }, [userRole]);

    return (
        <>
            <AdminBootstrap />
            <React.Suspense fallback={
                <div className="flex items-center justify-center p-8">
                    <Spinner />
                </div>
            }>
                {isManagerRole(userRole) ? <ManagerView /> : <WorkerView />}
            </React.Suspense>
        </>
    );
}
