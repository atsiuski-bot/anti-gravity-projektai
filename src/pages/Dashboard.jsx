import React from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { isManagerRole } from '../utils/formatters';
import AdminBootstrap from '../components/AdminBootstrap';
import { Spinner } from '../components/ui/Loading';
import { lazyWithRecovery } from '../utils/appUpdate';
const ManagerView = lazyWithRecovery(() => import('./ManagerView'));
const WorkerView = lazyWithRecovery(() => import('./WorkerView'));
const ProfilePage = lazyWithRecovery(() => import('./ProfilePage'));

export default function Dashboard() {
    const { userRole } = useAuth();
    const { activeTab } = useNavigation();
    const showProfile = activeTab === 'profile';

    // The once-per-day client automation that used to run here has moved to scheduled Cloud
    // Functions (escalateTaskPriorities, archiveFinishedTasks). See the note in Layout.jsx.

    return (
        <>
            <AdminBootstrap />
            <React.Suspense fallback={
                <div className="flex items-center justify-center p-8">
                    <Spinner />
                </div>
            }>
                {/* Keep the role view MOUNTED while on the profile page (its data listeners and
                    cached scroll survive), just visually hidden — so returning is instant. */}
                <div className={showProfile ? 'hidden' : undefined}>
                    {isManagerRole(userRole) ? <ManagerView /> : <WorkerView />}
                </div>
                {showProfile && <ProfilePage />}
            </React.Suspense>
        </>
    );
}
