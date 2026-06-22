import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { Calendar, ChevronDown, ChevronUp, Clock } from 'lucide-react';
import { formatMinutesToTimeString, getLithuanianDateString, sanitizeReportMinutes } from '../utils/timeUtils';
import { useAuth } from '../context/AuthContext';
import { isScopedManager } from '../utils/teamScope';
import Card from './ui/Card';
import EmptyState from './ui/EmptyState';
import { Spinner } from './ui/Loading';
import UserChip from './UserChip';

// Per-worker row, sorted by minutes desc. Shared by the mobile card stack and the
// desktop table so both render identical data + figures.
function sortedUsers(stat) {
    return Object.values(stat.users).sort((a, b) => b.minutes - a.minutes);
}

function sharePercent(minutes, totalMinutes) {
    return totalMinutes > 0 ? Math.round((minutes / totalMinutes) * 100) : 0;
}

export default function MonthlyHours({ users }) {
    const { currentUser, userData } = useAuth();
    const [sessions, setSessions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [isCollapsed, setIsCollapsed] = useState(true);
    const [expandedMonth, setExpandedMonth] = useState(null);

    const scoped = isScopedManager(userData);
    const uid = currentUser?.uid;

    useEffect(() => {
        setLoading(true);
        // We listen to ALL work_sessions (whole history) for admins/unscoped managers; a scoped
        // manager constrains to their team (array-contains), which is also required once the rules
        // tighten — a broad read would be denied.
        const q = scoped && uid
            ? query(collection(db, 'work_sessions'), where('teamManagerIds', 'array-contains', uid))
            : query(collection(db, 'work_sessions'));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const data = snapshot.docs
                .map(doc => ({ id: doc.id, ...doc.data() }))
                .filter(session => !session.isDeleted);
            setSessions(data);
            setLoading(false);
        }, (error) => {
            console.error("MonthlyHours: Error fetching sessions:", error);
            setLoading(false);
        });

        return () => unsubscribe();
    }, [scoped, uid]);

    const monthlyStats = useMemo(() => {
        const stats = {};

        sessions.forEach(session => {
            // Bucket by the canonical Lithuanian-local `date` string (YYYY-MM-DD), not by
            // new Date(startTime).getMonth(): the latter parses a UTC instant and reads the
            // month in the runtime's local zone, mis-bucketing month-boundary sessions
            // off-Vilnius and in tests. Fall back to startTime only when `date` is missing.
            const dayStr = (typeof session.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(session.date))
                ? session.date
                : (session.startTime ? getLithuanianDateString(session.startTime) : null);
            if (!dayStr) return;

            const key = dayStr.slice(0, 7); // YYYY-MM

            if (!stats[key]) {
                stats[key] = {
                    monthKey: key,
                    totalMinutes: 0,
                    users: {}
                };
            }

            const uid = session.userId;
            // Read-side guard: clamp a corrupt/oversized stored session before it enters the
            // monthly totals (allowLarge preserves a manual-adjustment delta's sign/magnitude).
            const duration = sanitizeReportMinutes(session.durationMinutes, { allowLarge: session.isManualAdjustment });

            stats[key].totalMinutes += duration;

            if (!stats[key].users[uid]) {
                // Try to find user info from props
                const user = users.find(u => u.id === uid);
                stats[key].users[uid] = {
                    userId: uid,
                    name: user ? (user.displayName || user.email) : (session.userName || 'Nežinomas'),
                    minutes: 0
                };
            }
            stats[key].users[uid].minutes += duration;
        });

        // Convert to array and sort descending (newest month first)
        return Object.values(stats)
            .sort((a, b) => b.monthKey.localeCompare(a.monthKey));

    }, [sessions, users]);

    if (loading) return <Spinner label="Kraunami duomenys…" />;

    return (
        <Card className="mb-6 overflow-hidden">
            <button
                type="button"
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                className="flex min-h-touch w-full items-center justify-between bg-surface-sunken p-4 transition-colors hover:bg-surface-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
            >
                <div className="flex items-center gap-2">
                    <Calendar className="h-5 w-5 text-brand" aria-hidden="true" />
                    <h3 className="text-h3 text-ink-strong">Mėnesinė komandos ataskaita</h3>
                </div>
                {isCollapsed
                    ? <ChevronDown className="h-5 w-5 text-ink-muted" aria-hidden="true" />
                    : <ChevronUp className="h-5 w-5 text-ink-muted" aria-hidden="true" />}
            </button>

            {!isCollapsed && (
                <div className="border-t border-line animate-in fade-in slide-in-from-top-2">
                    {monthlyStats.length === 0 ? (
                        <EmptyState
                            icon={Calendar}
                            title="Nėra duomenų"
                            description="Kai vykdytojai pradės registruoti laiką, čia matysite mėnesinę ataskaitą."
                        />
                    ) : (
                        <div className="divide-y divide-line">
                            {monthlyStats.map((stat) => {
                                const isOpen = expandedMonth === stat.monthKey;
                                return (
                                    <div key={stat.monthKey} className="bg-surface-card">
                                        <button
                                            type="button"
                                            onClick={() => setExpandedMonth(isOpen ? null : stat.monthKey)}
                                            aria-expanded={isOpen}
                                            aria-label={`${stat.monthKey} mėnuo, viso ${formatMinutesToTimeString(stat.totalMinutes)}`}
                                            className="flex min-h-touch w-full items-center justify-between p-4 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset"
                                        >
                                            <div className="flex flex-wrap items-center gap-3">
                                                <span className="text-h3 font-bold text-ink-strong">
                                                    {stat.monthKey}
                                                </span>
                                                <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2 py-0.5 text-caption font-medium text-ink">
                                                    <Clock className="h-3.5 w-3.5 opacity-75" aria-hidden="true" />
                                                    Viso: {formatMinutesToTimeString(stat.totalMinutes)}
                                                </span>
                                            </div>
                                            {isOpen
                                                ? <ChevronUp className="h-5 w-5 text-ink-muted" aria-hidden="true" />
                                                : <ChevronDown className="h-5 w-5 text-ink-muted" aria-hidden="true" />}
                                        </button>

                                        {isOpen && (
                                            <div className="px-4 pb-4 animate-in fade-in slide-in-from-top-2">
                                                {/* Mobile / touch: one card per worker — hours are the prominent figure (§9, never a scrolling table) */}
                                                <ul className="space-y-2 md:hidden">
                                                    {sortedUsers(stat).map((user) => (
                                                        <li
                                                            key={user.userId}
                                                            className="rounded-card border border-line bg-surface-card p-4"
                                                        >
                                                            <UserChip
                                                                userId={user.userId}
                                                                name={user.name}
                                                                className="block truncate text-body font-medium text-ink-strong"
                                                            />
                                                            <div className="mt-2 flex items-end justify-between gap-3">
                                                                <span className="inline-flex items-center gap-1.5 font-mono text-h2 font-bold text-brand">
                                                                    <Clock className="h-4 w-4 opacity-75" aria-hidden="true" />
                                                                    {formatMinutesToTimeString(user.minutes)}
                                                                </span>
                                                                <span className="text-caption text-ink-muted">
                                                                    {sharePercent(user.minutes, stat.totalMinutes)}% nuo bendro
                                                                </span>
                                                            </div>
                                                        </li>
                                                    ))}
                                                </ul>

                                                {/* Desktop / wide: denser table is allowed (§9) */}
                                                <div className="hidden overflow-x-auto rounded-card border border-line md:block">
                                                    <table className="min-w-full divide-y divide-line">
                                                        <thead className="bg-surface-sunken">
                                                            <tr>
                                                                <th scope="col" className="px-4 py-2 text-left text-caption font-medium uppercase tracking-wider text-ink-muted">Vykdytojas</th>
                                                                <th scope="col" className="px-4 py-2 text-right text-caption font-medium uppercase tracking-wider text-ink-muted">Valandos</th>
                                                                <th scope="col" className="px-4 py-2 text-right text-caption font-medium uppercase tracking-wider text-ink-muted md:w-32">% nuo bendro</th>
                                                            </tr>
                                                        </thead>
                                                        <tbody className="divide-y divide-line bg-surface-card">
                                                            {sortedUsers(stat).map((user) => (
                                                                <tr key={user.userId} className="hover:bg-surface-sunken">
                                                                    <td className="px-4 py-2">
                                                                        <UserChip
                                                                            userId={user.userId}
                                                                            name={user.name}
                                                                            className="text-body font-medium text-ink-strong"
                                                                        />
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right">
                                                                        <div className="flex items-center justify-end gap-1.5 font-mono text-body-lg font-semibold text-brand">
                                                                            <Clock className="h-3.5 w-3.5 opacity-75" aria-hidden="true" />
                                                                            {formatMinutesToTimeString(user.minutes)}
                                                                        </div>
                                                                    </td>
                                                                    <td className="px-4 py-2 text-right">
                                                                        <div className="text-caption text-ink-muted">
                                                                            {sharePercent(user.minutes, stat.totalMinutes)}%
                                                                        </div>
                                                                    </td>
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>
            )}
        </Card>
    );
}
