import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { startOfWeek, endOfWeek } from 'date-fns';
import { Clock, AlertTriangle } from 'lucide-react';
import { formatDisplayName, parseTimeToHours } from '../utils/formatters';
import { getLithuanianDateString, getLithuanianWeekday } from '../utils/timeUtils';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import UserChip from './UserChip';

export default function DailyHoursSummary() {
    const [users, setUsers] = useState([]);
    const [tasks, setTasks] = useState([]);
    const [workSessions, setWorkSessions] = useState([]);
    const [loading, setLoading] = useState(true);

    const dayNames = ['Pirmadienis', 'Antradienis', 'Trečiadienis', 'Ketvirtadienis', 'Penktadienis', 'Šeštadienis', 'Sekmadienis'];
    const dayAbbr = ['Pir', 'Ant', 'Tre', 'Ket', 'Pen', 'Šeš', 'Sek'];

    useEffect(() => {
        setLoading(true);

        // 1. Listen to Users
        const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
            const usersData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setUsers(usersData);
            setLoading(false);
        });

        // 2. Listen to Tasks (Active)
        let activeTasks = [];
        // 3. Listen to Archived Tasks
        let archivedTasks = [];

        const updateAllTasks = () => {
            setTasks([...activeTasks, ...archivedTasks]);
        };

        const unsubActive = onSnapshot(collection(db, 'tasks'), (snap) => {
            activeTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        });

        const now = new Date();
        const weekStartStr = startOfWeek(now, { weekStartsOn: 1 }).toISOString();
        const archivedQuery = query(collection(db, 'archived_tasks'), where('archivedAt', '>=', weekStartStr));

        const unsubArchived = onSnapshot(archivedQuery, (snap) => {
            archivedTasks = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            updateAllTasks();
        });

        // 4. Listen to Work Sessions (Actual task time)
        const unsubSessions = onSnapshot(collection(db, 'work_sessions'), (snap) => {
            const sessionsData = snap.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(session => !session.isDeleted);
            setWorkSessions(sessionsData);
        });

        return () => {
            unsubUsers();
            unsubActive();
            unsubArchived();
            unsubSessions();
        };
    }, []);

    // Calculate daily stats for each user
    const dailyStats = useMemo(() => {
        const stats = {};

        // Calculate current week range
        // Note: Using ISO string comparison for simple date matching
        const now = new Date();
        const currentParams = { weekStartsOn: 1 };
        // We want to filter for the CURRENT week, matching the column headers Monday-Sunday
        const weekStart = startOfWeek(now, currentParams);
        const weekEnd = endOfWeek(now, currentParams);
        // Compare week membership on the canonical YYYY-MM-DD strings (timezone-independent),
        // not by re-parsing session.date as a UTC instant against local week bounds.
        const weekStartStr = getLithuanianDateString(weekStart);
        const weekEndStr = getLithuanianDateString(weekEnd);

        users.forEach(user => {
            stats[user.id] = {
                name: formatDisplayName(user.displayName) || user.email,
                color: user.color || WORKER_FALLBACK_COLOR,
                days: {}
            };

            // Initialize all days
            dayNames.forEach(day => {
                stats[user.id].days[day] = {
                    available: 0,
                    planned: 0,
                    actual: 0
                };
            });

            // Add available hours from work_hours
            if (user.work_hours && Array.isArray(user.work_hours)) {
                user.work_hours.forEach(wh => {
                    if (wh.dayOfWeek && stats[user.id].days[wh.dayOfWeek] !== undefined) {
                        // Accumulate (+=): a worker may have multiple availability blocks on the
                        // same weekday (split shift); overwriting (=) silently dropped all but
                        // the last and made the overbooked check mis-fire.
                        stats[user.id].days[wh.dayOfWeek].available += parseTimeToHours(wh.hours);
                    }
                });
            }

            // Add planned hours from tasks (ONLY if task is scheduled for this week OR generally? 
            // Usually planned tasks are recurring or just per weekday. 
            // The existing logic seemed to just check dayOfWeek property. 
            // If tasks are specific instances, we should check date. 
            // However, the issue described was regarding "Worked" hours (actual).
            // Let's keep planned logic as is for now unless requested, as it seems to rely on "recurring" logic possibly?)
            // Actually, tasks.dayOfWeek implies recurring or specific day planning. 
            // Let's focus on fixing ACTUAL hours first which is the main bug.

            tasks.forEach(task => {
                if (task.assignedUserId === user.id && task.dayOfWeek && stats[user.id].days[task.dayOfWeek] !== undefined) {
                    // Start fix: If task has a specific date, ensuring it matches this week?
                    // Currently tasks with dayOfWeek might be recurring or specific. 
                    // Assuming recurring/general for now as 'planned'.
                    stats[user.id].days[task.dayOfWeek].planned += parseTimeToHours(task.estimatedTime);
                }
            });

            // Add actual hours from work_sessions (FILTERED BY CURRENT WEEK)
            workSessions.forEach(session => {
                try {
                    if (session.userId === user.id && typeof session.date === 'string') {
                        // String-based week membership + weekday derivation: avoids re-parsing
                        // the local date string as a UTC instant (which mis-buckets the day
                        // off-Vilnius and in tests).
                        if (session.date >= weekStartStr && session.date <= weekEndStr) {
                            const mappedDayName = getLithuanianWeekday(session.date);

                            if (stats[user.id].days[mappedDayName]) {
                                const durationHours = (session.durationMinutes || 0) / 60;
                                if (Number.isFinite(durationHours) && durationHours >= 0) {
                                    stats[user.id].days[mappedDayName].actual += durationHours;
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error processing work session:', session.id, error);
                }
            });
        });

        return stats;
        // eslint-disable-next-line react-hooks/exhaustive-deps -- dayNames is a render-stable constant array; omitting it preserves memo identity
    }, [users, tasks, workSessions]);

    if (loading) {
        return (
            <div className="bg-surface-card rounded-card shadow-sm border border-line p-6 mb-6">
                <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand"></div>
                </div>
            </div>
        );
    }

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden mb-6">
            <div className="p-4 border-b border-line bg-surface-sunken">
                <div className="flex items-center gap-2">
                    <Clock className="w-5 h-5 text-brand" />
                    <h3 className="font-semibold text-ink-strong">Dienos valandos pagal vartotoją</h3>
                </div>
                <p className="text-caption text-ink-muted mt-1">Planuotos / Faktinės / Galimos valandos kiekvienai dienai</p>
            </div>

            {/* Mobile: one card per user — never a horizontal table on a phone (§9) */}
            <ul className="divide-y divide-line md:hidden">
                {Object.entries(dailyStats).map(([userId, userData]) => (
                    <li key={userId} className="p-4">
                        <div className="flex items-center gap-2">
                            <div
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: userData.color }}
                            />
                            <UserChip userId={userId} name={userData.name} className="text-sm font-medium text-ink-strong truncate" />
                        </div>
                        <dl className="mt-3 grid grid-cols-1 gap-1.5">
                            {dayNames.map((day) => {
                                const dayData = userData.days[day];
                                const isOverbooked = dayData.planned > dayData.available && dayData.available > 0;
                                const hasData = dayData.available > 0 || dayData.planned > 0;

                                return (
                                    <div key={day} className="flex items-center justify-between gap-3">
                                        <dt className="text-caption text-ink-muted">{day}</dt>
                                        <dd className={`text-sm font-medium ${isOverbooked ? 'text-feedback-danger' : 'text-ink'}`}>
                                            {hasData ? (
                                                <span className="flex items-center gap-1">
                                                    {isOverbooked && (
                                                        <>
                                                            <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                                                            <span className="sr-only">Viršytas planas</span>
                                                        </>
                                                    )}
                                                    <span>
                                                        {dayData.planned.toFixed(1)} / <span className="text-feedback-success font-bold">{dayData.actual.toFixed(1)}</span> / {dayData.available.toFixed(1)}h
                                                    </span>
                                                </span>
                                            ) : (
                                                <span className="text-ink-muted">-</span>
                                            )}
                                        </dd>
                                    </div>
                                );
                            })}
                        </dl>
                    </li>
                ))}
            </ul>

            {/* Desktop: dense weekly hours table */}
            <div className="hidden md:block overflow-x-auto">
                <table className="min-w-full">
                    <thead className="bg-surface-sunken border-b border-line">
                        <tr>
                            <th scope="col" className="px-4 py-3 text-left text-caption font-medium text-ink-muted uppercase tracking-wider sticky left-0 bg-surface-sunken z-10">
                                Vartotojas
                            </th>
                            {dayAbbr.map((day, idx) => (
                                <th key={idx} scope="col" className="px-3 py-3 text-center text-caption font-medium text-ink-muted uppercase tracking-wider">
                                    <div className="hidden sm:block">{dayNames[idx]}</div>
                                    <div className="sm:hidden">{day}</div>
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="bg-surface-card divide-y divide-line">
                        {Object.entries(dailyStats).map(([userId, userData]) => (
                            <tr key={userId} className="hover:bg-surface-sunken">
                                <th scope="row" className="px-4 py-3 whitespace-nowrap sticky left-0 bg-surface-card text-left font-normal">
                                    <div className="flex items-center gap-2">
                                        <div
                                            className="w-3 h-3 rounded-full flex-shrink-0"
                                            style={{ backgroundColor: userData.color }}
                                        />
                                        <UserChip userId={userId} name={userData.name} className="text-sm font-medium text-ink-strong truncate max-w-[120px]" />
                                    </div>
                                </th>
                                {dayNames.map((day, idx) => {
                                    const dayData = userData.days[day];
                                    const isOverbooked = dayData.planned > dayData.available && dayData.available > 0;

                                    return (
                                        <td key={idx} className="px-3 py-3 whitespace-nowrap text-center">
                                            {dayData.available > 0 || dayData.planned > 0 ? (
                                                <div className={`text-sm font-medium ${isOverbooked ? 'text-feedback-danger' : 'text-ink'}`}>
                                                    <div className="flex items-center justify-center gap-1">
                                                        {isOverbooked && (
                                                            <>
                                                                <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                                                                <span className="sr-only">Viršytas planas</span>
                                                            </>
                                                        )}
                                                        <span>
                                                            {dayData.planned.toFixed(1)} / <span className="text-feedback-success font-bold">{dayData.actual.toFixed(1)}</span> / {dayData.available.toFixed(1)}h
                                                        </span>
                                                    </div>
                                                </div>
                                            ) : (
                                                <span className="text-sm text-ink-muted">-</span>
                                            )}
                                        </td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {Object.keys(dailyStats).length === 0 && (
                <div className="p-8 text-center text-ink-muted">
                    Nėra vartotojų su darbo valandomis
                </div>
            )}
        </div>
    );
}
