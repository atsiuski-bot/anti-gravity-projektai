import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc } from 'firebase/firestore';
import { startOfWeek, endOfWeek, eachDayOfInterval, format, isSameDay } from 'date-fns';
import { Sun, CalendarDays, CheckCircle2 } from 'lucide-react';
import { cn } from '../utils/cn';
import { getLithuanianDateString, formatMinutesToTimeString } from '../utils/timeUtils';

export default function DailyWorkProgress({ currentUser, tasks = [] }) {
    // The day this card reports on, as the canonical Vilnius date string the session docs are
    // keyed by. It MUST be state rather than a value captured when the listeners were set up: a
    // worker who leaves the PWA open across midnight (normal here — the work day runs to 03:00)
    // otherwise keeps seeing YESTERDAY's "Šiandien" hours, because the effect below never re-armed,
    // while the break half further down recomputed the day on every render — the two halves of one
    // card describing different days. Re-checked every minute, and used by BOTH halves, so the
    // queries and both comparisons flip together.
    const [todayStr, setTodayStr] = useState(() => getLithuanianDateString());
    useEffect(() => {
        const interval = setInterval(() => {
            setTodayStr((prev) => {
                const next = getLithuanianDateString();
                return next === prev ? prev : next; // keep identity stable so the listeners only re-arm on a real day change
            });
        }, 60000);
        return () => clearInterval(interval);
    }, []);

    const [dayPlanned, setDayPlanned] = useState(0);
    const [dayWorked, setDayWorked] = useState(0);
    const [weekPlanned, setWeekPlanned] = useState(0);
    const [weekWorked, setWeekWorked] = useState(0);
    const [currentSessionHours, setCurrentSessionHours] = useState(0);
    const [loading, setLoading] = useState(true);

    // Calculate active session time from running tasks
    useEffect(() => {
        const calculateActiveTime = () => {
            if (!tasks || tasks.length === 0) {
                setCurrentSessionHours(0);
                return;
            }

            let totalActiveMillis = 0;
            const now = new Date();

            tasks.forEach(task => {
                if (task.timerStatus === 'running' && task.timerStartedAt && task.assignedUserId === currentUser?.uid) {
                    const start = new Date(task.timerStartedAt);
                    if (!isNaN(start.getTime())) {
                        totalActiveMillis += (now - start);
                    }
                }
            });

            setCurrentSessionHours(totalActiveMillis / (1000 * 60 * 60));
        };

        calculateActiveTime();
        const interval = setInterval(calculateActiveTime, 60000);
        return () => clearInterval(interval);
    }, [tasks, currentUser]);

    useEffect(() => {
        if (!currentUser) return;

        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 1 }); // Monday start
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

        // Generate array of date strings for the week to use in 'in' query
        const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd })
            .map(d => format(d, 'yyyy-MM-dd'));

        // 1. Fetch Work Sessions (Actual Worked Hours - FINISHED ONLY)
        const sessionsQuery = query(
            collection(db, 'work_sessions'),
            where('userId', '==', currentUser.uid),
            where('date', 'in', weekDays)
        );

        const unsubSessions = onSnapshot(sessionsQuery, (snapshot) => {
            let dWorked = 0;
            let wWorked = 0;
            snapshot.docs.forEach(doc => {
                const data = doc.data();
                if (data.isDeleted) return;

                const duration = (data.durationMinutes || 0) / 60;
                wWorked += duration;
                if (data.date === todayStr) {
                    dWorked += duration;
                }
            });
            setDayWorked(dWorked);
            setWeekWorked(wWorked);
        });

        // 2. Fetch Work Hours (Planned from Calendar)
        const plannedQuery = query(
            collection(db, 'work_hours'),
            where('userId', '==', currentUser.uid)
        );

        const unsubPlanned = onSnapshot(plannedQuery, (snapshot) => {
            let dPlanned = 0;
            let wPlanned = 0;
            snapshot.docs.forEach(doc => {
                try {
                    const data = doc.data();
                    // Vacation blocks are stored in the same work_hours collection but are NOT
                    // planned work time. Counting them would inflate the goal denominator and
                    // make the target unreachable for any worker who plans leave.
                    if (data.isVacation) return;
                    const start = new Date(data.start);
                    const end = new Date(data.end);

                    if (!isNaN(start.getTime()) && !isNaN(end.getTime())) {
                        const duration = (end - start) / (1000 * 60 * 60);

                        if (Number.isFinite(duration) && duration >= 0) {
                            // Filter for current week (client-side to avoid index)
                            if (start >= weekStart && start <= weekEnd) {
                                wPlanned += duration;
                                if (isSameDay(start, now)) {
                                    dPlanned += duration;
                                }
                            }
                        }
                    }
                } catch (error) {
                    console.warn('Error processing planned work entry:', doc.id, error);
                }
            });
            setDayPlanned(dPlanned);
            setWeekPlanned(wPlanned);
            setLoading(false);
        });

        return () => {
            unsubSessions();
            unsubPlanned();
        };
        // todayStr is a dependency so the whole window (the week's `in` list AND the day bucket)
        // is rebuilt when the day rolls over — including the Sunday→Monday flip, where the captured
        // weekDays list would otherwise exclude the new week entirely.
    }, [currentUser, todayStr]);

    // 3. Fetch Break Sessions (for historical breaks throughout the week)
    const [breakSessions, setBreakSessions] = useState([]);
    const [currentBreakMinutes, setCurrentBreakMinutes] = useState(0);

    useEffect(() => {
        if (!currentUser) return;

        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });
        const weekEnd = endOfWeek(now, { weekStartsOn: 1 });

        const weekDays = eachDayOfInterval({ start: weekStart, end: weekEnd })
            .map(d => format(d, 'yyyy-MM-dd'));

        // Fetch break sessions for the week
        const breakQuery = query(
            collection(db, 'break_sessions'),
            where('userId', '==', currentUser.uid),
            where('date', 'in', weekDays)
        );

        const unsubBreaks = onSnapshot(breakQuery, (snapshot) => {
            const sessions = snapshot.docs.map(doc => doc.data());
            setBreakSessions(sessions);
        }, (error) => {
            console.error("DailyWorkProgress: Break Sessions Listener Error:", error);
        });

        // Also listen to current active break
        const userRef = doc(db, 'users', currentUser.uid);
        const unsubUser = onSnapshot(userRef, (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data().breakState || {};

                // Calculate current break time if active
                if (data.isTakingBreak && data.lastStartedAt) {
                    const start = new Date(data.lastStartedAt);
                    const now = new Date();
                    const currentDiff = (now - start) / (1000 * 60); // minutes
                    setCurrentBreakMinutes(currentDiff > 0 ? currentDiff : 0);
                } else {
                    setCurrentBreakMinutes(0);
                }
            }
        });

        return () => {
            unsubBreaks();
            unsubUser();
        };
        // Re-armed on the day flip for the same reason as the sessions effect above.
    }, [currentUser, todayStr]);

    // Calculate break hours from sessions — bucketed against the SAME todayStr the worked hours
    // use, so the two halves of the card can never describe different days.
    const dayBreakMinutes = breakSessions
        .filter(s => s.date === todayStr)
        .reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
    const weekBreakMinutes = breakSessions
        .reduce((acc, s) => acc + (s.durationMinutes || 0), 0);

    const dayBreakHours = (dayBreakMinutes + currentBreakMinutes) / 60;
    const weekBreakHours = (weekBreakMinutes + currentBreakMinutes) / 60;

    // Decimal hours -> readable duration, via the shared, unit-tested minute formatter. The old
    // local copy floored the hour and rounded the minutes INDEPENDENTLY, so any value whose
    // fraction landed in [59.5/60, 1) printed an impossible minute: 119.6 logged minutes
    // (1.99333h) read as "1h 60m", and a worker just short of the goal was told "Liko 0h 60m".
    // timeUtils rounds to whole minutes ONCE before splitting hour/minute — the same ":60" carry
    // fix formatMinutesToHHMM carries, and which timeUtils.test.js asserts against.
    const formatTime = (decimalHours) => formatMinutesToTimeString(decimalHours * 60);

    // The progress bars measure WORKED time against the planned goal, so they must NOT
    // include breaks: planned hours never contain breaks, so folding break minutes into the
    // numerator would overstate progress toward the goal. Breaks are shown as a separate,
    // clearly-labelled figure below (mirroring the Veikla/Pertraukos split in Reports).
    // Current session counts towards both Day and Week.
    const totalDayWorked = dayWorked + currentSessionHours;
    const totalWeekWorked = weekWorked + currentSessionHours;

    // A dynamic, encouraging one-liner driven purely by how far along the goal is — turns a
    // static "X / Y" readout into feedback the worker reacts to (DESIGN_SYSTEM: calm canvas,
    // motivating signal). `live` marks an in-progress session so the copy nods to it.
    const motivation = (percent, remainingLabel, live) => {
        if (percent >= 100) return 'Tikslas pasiektas! Puiki veikla 🎉';
        if (percent >= 75) return `Beveik! Liko tik ${remainingLabel}`;
        if (percent >= 40) return `Geras tempas — liko ${remainingLabel}`;
        if (percent > 0) return live ? 'Gera pradžia, tęsk!' : `Pirmi žingsniai — liko ${remainingLabel}`;
        return 'Pradėk dieną — pirmas žingsnis svarbiausias';
    };

    const renderGoal = (label, current, total, breakHours, opts) => {
        const { Icon, fillClass, ringClass } = opts;
        // When no shift hours are planned (total === 0) there is no goal to measure against, so a
        // "X / 0h 0m" bar reads as a broken tracker. Show a distinct, friendly "plan your hours"
        // state instead, still inside the same card frame so the layout stays consistent.
        const hasPlan = total > 0;
        const percent = hasPlan ? (current / total) * 100 : 0;
        const reached = hasPlan && percent >= 100;
        const remaining = Math.max(total - current, 0);
        const live = currentSessionHours > 0 && label.includes('Dienos');
        // Worked fill width (clamped + a 4% floor so a sliver of progress is visible). Breaks are
        // NEVER folded into the goal numerator — they ride the bar as a separate amber segment
        // stacked right after the worked fill, mirroring the team weekly-hours chart.
        const workedPct = Math.max(Math.min(percent, 100), current > 0 ? 4 : 0);
        const breakPct = hasPlan ? (breakHours / total) * 100 : 0;

        return (
            <div className={cn(
                'rounded-control border p-2.5 transition-colors',
                reached
                    ? 'border-feedback-success/40 bg-feedback-success/10'
                    : 'border-line bg-surface-sunken/40'
            )}>
                <div className="flex items-center gap-3">
                    {/* Icon medallion — green check once the goal is reached */}
                    <div className={cn(
                        'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
                        reached ? 'bg-feedback-success/20 text-feedback-success' : ringClass
                    )}>
                        {reached
                            ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" />
                            : <Icon className="h-5 w-5" aria-hidden="true" />}
                    </div>

                    <div className="min-w-0 flex-1">
                        <div className="flex items-baseline justify-between gap-2">
                            <span className="text-body font-semibold text-ink-strong">{label}</span>
                            {hasPlan && (
                                <span className={cn(
                                    'text-h3 font-extrabold leading-none tabular-nums',
                                    reached ? 'text-feedback-success' : 'text-ink-strong'
                                )}>
                                    {Math.round(percent)}%
                                </span>
                            )}
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-caption">
                            <span className="text-ink-muted">
                                {hasPlan ? motivation(percent, formatTime(remaining), live) : 'Nesuplanuota veiklos laiko'}
                            </span>
                            {hasPlan && (
                                <span className="shrink-0 font-medium tabular-nums text-ink-muted">
                                    {formatTime(current)}
                                    {breakHours > 0 && (
                                        <span className="text-session-break-accent"> +{formatTime(breakHours)}</span>
                                    )}
                                    <span className="text-ink-muted/70"> / {formatTime(total)}</span>
                                    {live && <span className="ml-1 text-session-task-accent">•vyksta</span>}
                                </span>
                            )}
                        </div>
                    </div>
                </div>

                {hasPlan ? (
                    <div className="relative mt-3 h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
                        <div
                            className={cn(
                                'h-full rounded-full transition-all duration-700 ease-out',
                                reached ? 'bg-feedback-success' : fillClass
                            )}
                            style={{ width: `${workedPct}%` }}
                            role="progressbar"
                            aria-valuenow={Math.round(percent)}
                            aria-valuemin={0}
                            aria-valuemax={100}
                            aria-label={`${label}: ${Math.round(percent)}%`}
                        />
                        {/* Break segment — stacked right after the worked fill, clipped by the
                            pill's overflow-hidden. Amber, never green: it is time off-task, shown
                            for context but explicitly outside the goal measurement. */}
                        {breakHours > 0 && (
                            <div
                                className="absolute top-0 h-full bg-session-break-accent transition-all duration-700 ease-out"
                                style={{ left: `${Math.min(workedPct, 100)}%`, width: `${breakPct}%` }}
                                aria-hidden="true"
                            />
                        )}
                    </div>
                ) : (
                    <p className="mt-1.5 text-caption text-ink-muted">
                        Susiplanuokite valandas kalendoriuje, kad matytumėte savo pažangą.
                    </p>
                )}
            </div>
        );
    };

    return (
        <div className="bg-surface-card p-4 rounded-card shadow-sm border border-line mb-6 relative">
            {loading && (
                <div className="absolute inset-0 bg-surface-card/50 z-10 animate-pulse rounded-card" />
            )}
            <div className="space-y-3">
                {/* Day Progress */}
                {renderGoal(
                    "Dienos tikslas",
                    totalDayWorked,
                    dayPlanned,
                    dayBreakHours,
                    { Icon: Sun, fillClass: 'bg-brand', ringClass: 'bg-brand-soft text-brand' }
                )}

                {/* Week Progress */}
                {renderGoal(
                    "Savaitės tikslas",
                    totalWeekWorked,
                    weekPlanned,
                    weekBreakHours,
                    { Icon: CalendarDays, fillClass: 'bg-session-task-accent', ringClass: 'bg-session-task-surface text-session-task-accent' }
                )}
            </div>
        </div>
    );
}
