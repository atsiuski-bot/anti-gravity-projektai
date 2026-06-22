import React, { useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { isManagerRole } from '../utils/formatters';
import { canSeeWholeTeam } from '../utils/teamScope';
import AdminBootstrap from '../components/AdminBootstrap';
import { runDailyAutomation } from '../utils/automationUtils';
import { Spinner } from '../components/ui/Loading';
const ManagerView = React.lazy(() => import('./ManagerView'));
const WorkerView = React.lazy(() => import('./WorkerView'));
const ProfilePage = React.lazy(() => import('./ProfilePage'));

export default function Dashboard() {
    const { userRole, userData } = useAuth();
    const { activeTab } = useNavigation();
    const showProfile = activeTab === 'profile';

    useEffect(() => {
        const runAutomation = async () => {
            // Only WHOLE-TEAM viewers (admins / unscoped managers) run the team-wide automation:
            // it promotes and archives EVERY user's tasks. A scoped manager neither may do that
            // (the tightened rules deny writes outside their team) nor should consume the
            // once-per-day latch with a partial run. Mirrors the gate in Layout.jsx. `userData`
            // is in the deps so the effect re-runs once auth resolves it (undefined at mount).
            if (canSeeWholeTeam(userData)) {
                console.log("[Dashboard] Running daily automation...");
                await runDailyAutomation();
            }
        };
        runAutomation();
    }, [userData]);

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
