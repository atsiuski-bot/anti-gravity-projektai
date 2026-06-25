import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { Users, ChevronDown, ChevronUp } from 'lucide-react';
import { startOfWeek, endOfWeek } from 'date-fns';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import { getLithuanianNow, getLithuanianDateString, clampSessionMinutes, sanitizeReportMinutes } from '../utils/timeUtils';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { isScopedOverseer, scopeRoster } from '../utils/teamScope';
import UserChip from './UserChip';

export default function CombinedHoursSummary() {
    const { currentUser, userData } = useAuth();
    const { users: allUsers, loading: usersLoading } = useUsers();
    // Scoped manager: only their team's rows + roster. Admin/unscoped manager: whole company.
    const scoped = isScopedOverseer(userData);
    const uid = currentUser?.uid;
    const users = useMemo(() => scopeRoster(allUsers, userData, uid), [allUsers, scoped, uid]); // eslint-disable-line react-hooks/exhaustive-deps -- userData read via the stable `scoped` flag
    const [tasks, setTasks] = useState([]);
    const [workHours, setWorkHours] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [breakSessions, setBreakSessions] = useState([]);
    const [error, setError] = useState('');
    const [isCollapsed, setIsCollapsed] = useState(true);

    useEffect(() => {
        if (!currentUser || usersLoading) return;

        // Team filter for a scoped manager (array-contains on the row's denormalized
        // teamManagerIds); null = whole-company (admin / unscoped manager). work_hours is the
        // shift calendar and stays public, so it is intentionally NOT scoped.
        const scope = scoped && uid ? where('teamManagerIds', 'array-contains', uid) : null;

        const now = getLithuanianNow();

        // Standard week starts Monday
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
        const weekStartStr = getLithuanianDateString(weekStart);
        const weekEndStr = getLithuanianDateString(weekEnd);

        // 1. Users come from UsersContext — no listener needed here

        // 2. Listen to Tasks (Active)
        let activeTasks = [];
        let archivedTasks = [];
        const updateAllTasks = () => {
            setTasks([...activeTasks, ...archivedTasks]);
        };

        const activeTasksQuery = scope ? query(collection(db, 'tasks'), scope) : query(collection(db, 'tasks'));
        const unsubActive = onSnapshot(activeTasksQuery, (snap) => {
            activeTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        }, (error) => {
            console.error("CombinedHoursSummary: Active Tasks Listener Error:", error);
        });

        // Add query to limit archived tasks to the current week
        const archivedQuery = query(collection(db, 'archived_tasks'), where('archivedAt', '>=', weekStartStr), ...(scope ? [scope] : []));

        const unsubArchived = onSnapshot(archivedQuery, (snap) => {
            archivedTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        }, (error) => {
            console.error("CombinedHoursSummary: Archived Tasks Listener Error:", error);
        });

        // 3. Listen to Work Hours (Planned Calendar Events)
        const workHoursQuery = query(collection(db, 'work_hours'));
        const unsubWorkHours = onSnapshot(workHoursQuery, (snapshot) => {
            const hoursData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(wh => {
                    const start = new Date(wh.start);
                    // Filter generally relevant events, precise overlap check can be done later if needed, 
                    // but simple range check is efficient for now.
                    return start >= weekStart && start <= weekEnd;
                });
            setWorkHours(hoursData);
        }, (err) => {
            console.error('Error fetching work hours:', err);
            setError('Nepavyko užkrauti duomenų');
        });

        // 4. Listen to Work Sessions — server-side date filter
        const sessionsQuery = query(
            collection(db, 'work_sessions'),
            where('date', '>=', weekStartStr),
            where('date', '<=', weekEndStr),
            ...(scope ? [scope] : [])
        );
        const unsubSessions = onSnapshot(sessionsQuery, (snapshot) => {
            const sessionsData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(s => !s.isDeleted);
            setWorkSessions(sessionsData);
        }, (error) => {
            console.error("CombinedHoursSummary: Work Sessions Listener Error:", error);
        });

        // 5. Listen to Break Sessions — server-side date filter
        const breakQuery = query(
            collection(db, 'break_sessions'),
            where('date', '>=', weekStartStr),
            where('date', '<=', weekEndStr),
            ...(scope ? [scope] : [])
        );
        const unsubBreakSessions = onSnapshot(breakQuery, (snapshot) => {
            const breakData = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }));
            setBreakSessions(breakData);
        }, (error) => {
            console.error("CombinedHoursSummary: Break Sessions Listener Error:", error);
        });

        return () => {
            unsubActive();
            unsubArchived();
            unsubWorkHours();
            unsubSessions();
            unsubBreakSessions();
        };
    }, [currentUser, usersLoading, scoped, uid]);

    // Calculate stats
    const combinedStats = useMemo(() => {
        const stats = [];
        let maxVal = 0;
        const now = getLithuanianNow();
        const wStart = startOfWeek(now, { weekStartsOn: 1 });
        const wEnd = endOfWeek(now, { weekStartsOn: 1 });

        users.forEach(user => {
            let plannedHours = 0;
            let workedMinutes = 0;

            // Calculate weekly scheduled hours (Calendar). Approved leave (any absence type, all of
            // which keep isVacation true) is time OFF, not planned work — counting it would inflate
            // the planned bar and make a holiday week read as planned hours, the same exclusion
            // Reports and DailyWorkProgress already apply.
            workHours.forEach(wh => {
                if (wh.userId === user.id && !wh.isVacation) {
                    const whStart = new Date(wh.start);
                    const whEnd = new Date(wh.end);
                    const duration = (whEnd - whStart) / (1000 * 60 * 60);
                    plannedHours += duration;
                }
            });

            // Calculate weekly actual worked minutes
            // 1. From Sessions
            workSessions.forEach(session => {
                if (session.userId === user.id) {
                    workedMinutes += sanitizeReportMinutes(session.durationMinutes, { allowLarge: session.isManualAdjustment });
                }
            });

            // 2. From Tasks (Manual Minutes only — NOT Quick Work / Calls)
            // Call and Quick Work tasks already have dedicated work_sessions logged,
            // so including their manualMinutes here would double-count.
            tasks.forEach(t => {
                if (t.assignedUserId === user.id && t.manualMinutes > 0 && !t.isSystemTask && !t.isQuickWork) {
                    const compDate = t.completedAt ? new Date(t.completedAt) : (t.archivedAt ? new Date(t.archivedAt) : null);
                    if (compDate && compDate >= wStart && compDate <= wEnd) {
                        workedMinutes += sanitizeReportMinutes(t.manualMinutes, { allowLarge: true });
                    }
                }
            });

            // 3. Breaks are tracked SEPARATELY — never folded into workedMinutes. The worked
            // bar must mean actual work so it is comparable to the planned bar (which never
            // contains breaks); summing breaks in would silently overstate the comparison.
            let breakMinutes = 0;
            breakSessions.forEach(session => {
                if (session.userId === user.id) {
                    breakMinutes += sanitizeReportMinutes(session.durationMinutes);
                }
            });

            // Add current active break time if user is taking a break right now
            if (user.breakState?.isTakingBreak && user.breakState?.lastStartedAt) {
                const bStart = new Date(user.breakState.lastStartedAt);
                const currentDiff = clampSessionMinutes((now - bStart) / (1000 * 60));
                if (currentDiff > 0) {
                    breakMinutes += currentDiff;
                }
            }

            const workedHours = workedMinutes / 60;
            const breakHours = breakMinutes / 60;
            if (plannedHours > maxVal) maxVal = plannedHours;
            if (workedHours > maxVal) maxVal = workedHours;

            stats.push({
                id: user.id,
                name: user.displayName || user.email,
                color: user.color || WORKER_FALLBACK_COLOR,
                plannedHours,
                workedHours,
                breakHours
            });
        });

        // Add buffer to max value for visual spacing
        return { data: stats, max: Math.max(maxVal, 40) }; // Minimum scale 40h
    }, [users, workHours, workSessions, tasks, breakSessions]);

    // NOTE: the live "Aktyvi veikla" list used to be duplicated here. It now lives solely in
    // ActiveWorkSessions (mounted right after this panel), which has the more correct task-time
    // logic (calculateCurrentTotalMinutes) and a faster refresh, so this component stays focused
    // on the weekly planned-vs-worked bars.

    if (usersLoading) return null;
    if (error) return null;

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                aria-label="Komandos savaitės veiklos"
                className="w-full flex items-center justify-between p-4 min-h-touch bg-surface-sunken hover:bg-surface-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
            >
                <div className="flex items-center gap-2">
                    <Users className="w-5 h-5 text-brand" aria-hidden="true" />
                    <h3 className="font-semibold text-ink-strong">Komandos savaitės valandų suma</h3>
                </div>
                {isCollapsed
                    ? <ChevronDown className="w-5 h-5 text-ink-muted" aria-hidden="true" />
                    : <ChevronUp className="w-5 h-5 text-ink-muted" aria-hidden="true" />}
            </button>

            {!isCollapsed && (
                <div className="p-4 space-y-6 animate-in fade-in slide-in-from-top-2">
                    {/* Weekly Hours Bars */}
                    <div>
                        {combinedStats.data.length === 0 ? (
                            <p className="text-body italic text-ink-muted">Nėra duomenų.</p>
                        ) : (
                            combinedStats.data.map(user => (
                                <div key={user.id} className="mb-5 last:mb-0 flex items-center gap-4">
                                    {/* User name — left side, fixed width so all bars start on the same column */}
                                    <div className="w-36 shrink-0 flex items-center">
                                        <UserChip userId={user.id} name={user.name} colorDot={user.color} />
                                    </div>

                                    {/* Bars Area */}
                                    <div className="flex flex-col gap-1.5 flex-1 min-w-0">
                                        {/* Planned Bar — labelled so colour is never the sole signal (§5) */}
                                        <div className="flex items-center gap-2">
                                            <span className="w-14 shrink-0 text-caption text-ink-muted">Planuota</span>
                                            <span className="text-body-lg text-ink-muted font-mono w-24 text-right tabular-nums">
                                                {user.plannedHours.toFixed(1)}h
                                            </span>
                                            <div className="flex-1 h-2 bg-surface-sunken rounded-full overflow-hidden relative">
                                                <div
                                                    className="absolute top-0 left-0 h-full bg-feedback-info rounded-full"
                                                    style={{ width: `${(user.plannedHours / combinedStats.max) * 100}%` }}
                                                />
                                            </div>
                                        </div>

                                        {/* Worked Bar */}
                                        <div className="flex items-center gap-2">
                                            <span className="w-14 shrink-0 text-caption text-ink-muted">Dirbta</span>
                                            <span className="text-body-lg font-bold font-mono w-24 text-right tabular-nums">
                                                <span className="text-ink-strong">{user.workedHours.toFixed(1)}</span>
                                                {user.breakHours > 0 && (
                                                    <span className="text-session-break-accent">+{user.breakHours.toFixed(1)}</span>
                                                )}
                                                <span className="text-ink-strong">h</span>
                                            </span>
                                            <div className="flex-1 h-2 bg-surface-sunken rounded-full overflow-hidden flex">
                                                <div
                                                    className={`h-full bg-feedback-success rounded-l-full ${user.breakHours > 0 ? '' : 'rounded-r-full'}`}
                                                    style={{ width: `${(user.workedHours / combinedStats.max) * 100}%` }}
                                                />
                                                {user.breakHours > 0 && (
                                                    <div
                                                        className="h-full bg-session-break-accent rounded-r-full"
                                                        style={{ width: `${(user.breakHours / combinedStats.max) * 100}%` }}
                                                    />
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
