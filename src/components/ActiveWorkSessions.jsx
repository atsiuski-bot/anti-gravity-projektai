import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { ChevronDown, ChevronUp, Activity, AlertTriangle, Clock, LogOut } from 'lucide-react';
import SessionTypeIcon from './SessionTypeIcon';
import {
    calculateCurrentTotalMinutes,
    formatMinutesToTimeString,
    parseTimeStringToMinutes,
    MAX_SESSION_MINUTES,
} from '../utils/timeUtils';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { getSessionColors } from '../utils/sessionColors';
import UserChip from './UserChip';
import IconButton from './ui/IconButton';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyState from './ui/EmptyState';
import { isScopedOverseer, scopeRoster, isOverseenBy, canSeeWholeTeam } from '../utils/teamScope';
import { endSessionForUser } from '../utils/sessionAdmin';

// When the panel flags a live session as "galimai pasenusi" (probably a dead-phone ghost) and
// offers the manager a force-end. A break legitimately lasts minutes, never hours, so a multi-hour
// one is almost certainly forgotten — and force-ending it (endSessionForUser only CLEARS the flag,
// no record) loses no real work, because a break is non-work. So break flags at a far lower bar.
// Call, quick-work, and task are real WORK that a force-end would DISCARD, so they keep the
// conservative 16h ceiling — a manager must not be nudged to throw away a genuinely long run
// (the server net closes a forgotten call/quick-work by CREDITING it, not discarding it).
const BREAK_STALE_MINUTES = 4 * 60;
const staleThresholdMs = (type) =>
    (type === 'break' ? BREAK_STALE_MINUTES : MAX_SESSION_MINUTES) * 60 * 1000;

export default function ActiveWorkSessions({ embedded = false }) {
    const { users: allUsers, loading: usersLoading } = useUsers();
    const { currentUser, userData } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [shifts, setShifts] = useState([]); // today's work_hours rows (for planned-but-not-started)
    const [isCollapsed, setIsCollapsed] = useState(false);
    // The worker whose session the manager is about to force-end (drives the confirm dialog).
    const [endTarget, setEndTarget] = useState(null);
    const [ending, setEnding] = useState(false);

    // A scoped manager only sees their own team's live activity; admin/unscoped see everyone.
    const scoped = isScopedOverseer(userData);
    const uid = currentUser?.uid;

    // May the viewer settle a stuck session? Only a manager/admin who actually oversees the
    // target — never a peer. canSeeWholeTeam covers admin + unscoped manager; isOverseenBy covers
    // a scoped overseer's own subtree. Workers fail both and never see the control.
    const canEndSessionFor = (targetUser) =>
        !!targetUser && (canSeeWholeTeam(userData) || isOverseenBy(targetUser, uid));

    // Active (non-disabled) users, narrowed to the viewer's team when scoped.
    const users = useMemo(
        () => scopeRoster(allUsers.filter(u => !u.isDisabled), userData, uid),
        [allUsers, scoped, uid] // eslint-disable-line react-hooks/exhaustive-deps -- userData read via the stable `scoped` flag
    );

    useEffect(() => {
        // Tasks listener only maps active task titles. A scoped manager must constrain it to their
        // team (array-contains) — the broad status-'in' query would be denied once the rules tighten.
        const tasksQuery = scoped && uid
            ? query(collection(db, 'tasks'), where('teamManagerIds', 'array-contains', uid))
            : query(collection(db, 'tasks'), where('status', 'in', ['pending', 'in-progress']));
        const unsubTasks = onSnapshot(tasksQuery, (snap) => {
            const tasksData = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setTasks(tasksData);
        }, (error) => {
            console.error("ActiveWorkSessions: Tasks Listener Error:", error);
        });

        return () => {
            unsubTasks();
        };
    }, [scoped, uid]);

    // Today's planned shifts, read with the same day-range shape AllUsersCalendar uses
    // (`start` within [startOfDay, endOfDay]). We only need to know who is scheduled NOW, so we
    // read the whole day once and overlap-filter client-side; the row is re-evaluated on the
    // panel's own 10s tick via the rows' timers. Read-only — no per-row listener.
    useEffect(() => {
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 59, 999);

        const shiftsQuery = query(
            collection(db, 'work_hours'),
            where('start', '>=', startOfDay.toISOString()),
            where('start', '<=', endOfDay.toISOString())
        );
        const unsubShifts = onSnapshot(shiftsQuery, (snap) => {
            const rows = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            setShifts(rows);
        }, (error) => {
            console.error("ActiveWorkSessions: Shifts Listener Error:", error);
        });

        return () => {
            unsubShifts();
        };
    }, []);

    // Active Sessions Logic
    const activeSessions = useMemo(() => {
        return users.map(user => {
            if (!user.activeSession) return null;

            // Map session type to display properties
            let displayProps = {
                label: 'Veikla',
                colorClass: 'bg-surface-sunken text-ink',
                startTime: user.activeSession.startTime
            };

            switch (user.activeSession.type) {
                case 'break':
                    displayProps = {
                        type: 'break',
                        label: 'Pertrauka',
                        colorClass: `${getSessionColors('break').surface} ${getSessionColors('break').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'call':
                    displayProps = {
                        type: 'call',
                        label: 'Skambutis',
                        colorClass: `${getSessionColors('call').surface} ${getSessionColors('call').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'quickWork':
                    displayProps = {
                        type: 'quickWork',
                        label: 'Greitas darbas',
                        colorClass: `${getSessionColors('quickWork').surface} ${getSessionColors('quickWork').accent}`,
                        startTime: user.activeSession.startTime
                    };
                    break;
                case 'task': {
                    // Find generic task title if available
                    let title = user.activeSession.taskTitle || 'Užduotis';
                    // Try to find specific task in loaded tasks if ID matches
                    const foundTask = tasks.find(t => t.id === user.activeSession.taskId);
                    if (foundTask) {
                        title = foundTask.title;
                    }
                    displayProps = {
                        type: 'task',
                        label: title,
                        colorClass: `${getSessionColors('task').surface} ${getSessionColors('task').accent}`,
                        startTime: user.activeSession.startTime,
                        task: foundTask || null
                    };
                    break;
                }
                default:
                    // Fallback for unknown types
                    displayProps = {
                        label: user.activeSession.type || 'Veikla',
                        colorClass: 'bg-surface-sunken text-ink',
                        startTime: user.activeSession.startTime
                    };
            }

            // Over-budget signal for a running task: the same raw-math limit semantics the task
            // card uses (spent >= planned), so a row is flagged consistently with the worker's card.
            // Carried on the session so the panel can both float these rows up and the row can show
            // the danger pill. Computed against a one-off `Date.now()` snapshot — exact enough to
            // order/flag; the row's own timer drives the live counter.
            let isOverBudget = false;
            let overBudgetPct = 0;
            if (displayProps.type === 'task' && displayProps.task?.estimatedTime) {
                const planned = parseTimeStringToMinutes(displayProps.task.estimatedTime);
                if (planned > 0) {
                    const spent = calculateCurrentTotalMinutes(displayProps.task);
                    overBudgetPct = Math.round((spent / planned) * 100);
                    isOverBudget = spent >= planned;
                }
            }

            return {
                userId: user.id,
                userName: user.displayName || user.email,
                userColor: user.color || WORKER_FALLBACK_COLOR,
                userRef: user, // raw doc, for the end-session teardown + oversight check
                isOverBudget,
                overBudgetPct,
                ...displayProps
            };
        })
            .filter(Boolean)
            // Float over-budget rows to the top so the manager sees the problems first; otherwise
            // preserve roster order. Stable: a simple boolean key sort.
            .sort((a, b) => Number(b.isOverBudget) - Number(a.isOverBudget));
    }, [users, tasks]);

    // Planned-but-not-started: scoped workers whose shift overlaps NOW but who hold no live
    // session. These are the "should be working, isn't" rows the oversight panel exists to surface.
    const idlePlanned = useMemo(() => {
        if (!shifts.length || !users.length) return [];
        const now = Date.now();
        const byUser = new Map(users.map(u => [u.id, u]));
        const seen = new Set();
        const rows = [];
        for (const shift of shifts) {
            const user = byUser.get(shift.userId);
            if (!user) continue;                 // outside the viewer's scope
            if (user.activeSession) continue;    // already live — shown in the active section
            if (shift.isVacation) continue;      // absence, not a work shift
            if (seen.has(user.id)) continue;     // one row per worker even with multiple shifts
            const start = new Date(shift.start).getTime();
            const end = new Date(shift.end).getTime();
            if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
            if (now < start || now > end) continue; // shift not currently active
            seen.add(user.id);
            rows.push({
                userId: user.id,
                userName: user.displayName || user.email,
                shiftStart: shift.start,
                lastActiveAt: user.workStatus?.lastUpdated || null,
            });
        }
        return rows;
    }, [shifts, users]);

    if (usersLoading) return null;

    const hasSessions = activeSessions.length > 0;
    const hasIdle = idlePlanned.length > 0;
    const hasAnything = hasSessions || hasIdle;

    const handleConfirmEnd = async () => {
        if (!endTarget) return;
        setEnding(true);
        try {
            await endSessionForUser(endTarget);
        } finally {
            setEnding(false);
            setEndTarget(null);
        }
    };

    const endDialog = endTarget && (
        <ConfirmDialog
            open
            title="Užbaigti sesiją?"
            message={`Priverstinai užbaigti ${endTarget.displayName || endTarget.email} sesiją. Vykdoma užduotis bus pristabdyta ir užfiksuotas darbo laikas; pertraukos / skambučio likutis bus tik išvalytas. Paskyra NEBUS užblokuota.`}
            warning="Naudokite tik kai sesija įstrigo (telefonas išsijungė ar programa užsidarė), o darbuotojas pats jos užbaigti nebegali."
            confirmLabel="Užbaigti sesiją"
            cancelLabel="Atšaukti"
            loading={ending}
            onConfirm={handleConfirmEnd}
            onCancel={() => { if (!ending) setEndTarget(null); }}
        />
    );

    const renderRows = () => (
        <>
            {activeSessions.map(session => (
                <ActiveSessionRow
                    key={session.userId}
                    session={session}
                    canEnd={canEndSessionFor(session.userRef)}
                    onEnd={() => setEndTarget(session.userRef)}
                />
            ))}
            {hasIdle && (
                <>
                    {hasSessions && (
                        <div className="flex items-center gap-2 pt-2 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                            <Clock className="w-4 h-4" aria-hidden="true" />
                            Suplanuota, bet nepradėta
                        </div>
                    )}
                    {idlePlanned.map(row => (
                        <IdlePlannedRow key={row.userId} row={row} />
                    ))}
                </>
            )}
        </>
    );

    // Embedded in the "Aktyvūs darbai" sub-tab: the tab itself is the frame, so there is no
    // collapse chrome. An empty roster shows an explicit empty state instead of returning null —
    // a blank tab reads as broken (this is the bug where the panel "disappeared" when nobody
    // was working).
    if (embedded) {
        return (
            <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden">
                <div className="flex items-center gap-2 p-4 bg-surface-sunken border-b border-line">
                    <Activity className="w-5 h-5 text-brand" aria-hidden="true" />
                    <h3 className="font-semibold text-ink-strong">Aktyvi veikla</h3>
                </div>
                {hasAnything ? (
                    <div className="p-4 space-y-2 animate-in fade-in slide-in-from-top-2">
                        {renderRows()}
                    </div>
                ) : (
                    <EmptyState
                        icon={Activity}
                        title="Nėra aktyvios veiklos"
                        description="Kai komandos nariai pradės darbą, pertrauką ar skambutį, jie pasirodys čia."
                    />
                )}
                {endDialog}
            </div>
        );
    }

    // Standalone accordion — collapses, and hides entirely when empty.
    if (!hasAnything) return null;

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line overflow-hidden mb-6">
            <button
                onClick={() => setIsCollapsed(!isCollapsed)}
                aria-expanded={!isCollapsed}
                aria-controls="active-work-sessions-panel"
                className="w-full flex items-center justify-between p-4 bg-surface-sunken hover:bg-surface-base transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
            >
                <div className="flex items-center gap-2">
                    <Activity className="w-5 h-5 text-brand" />
                    <h3 className="font-semibold text-ink-strong">Aktyvi veikla</h3>
                </div>
                {isCollapsed ? <ChevronDown className="w-5 h-5 text-ink-muted" /> : <ChevronUp className="w-5 h-5 text-ink-muted" />}
            </button>

            {!isCollapsed && (
                <div id="active-work-sessions-panel" className="p-4 space-y-2 animate-in fade-in slide-in-from-top-2">
                    {renderRows()}
                </div>
            )}
            {endDialog}
        </div>
    );
}

// Helper Component for Active Session Row to manage own timer
const ActiveSessionRow = React.memo(({ session, canEnd = false, onEnd }) => {
    const [durationStr, setDurationStr] = useState('');
    // A session whose wall-clock start is older than its type's plausibility window is almost
    // certainly stale (the worker's app was killed / phone died without ever ending it), not a
    // genuinely live session. We flag it so the manager can tell a 9h "break" caused by a dead
    // phone apart from a real one — the panel otherwise shows them identically. The window is
    // short for break and the full 16h ceiling for call/quick-work/task (see staleThresholdMs).
    const [isStale, setIsStale] = useState(false);
    // Live share of planned time for a task row (drives the progress bar). Re-evaluated on the
    // same timer as the elapsed counter so the bar grows with the work.
    const [progressPct, setProgressPct] = useState(0);

    const isTask = session.type === 'task';
    const plannedTime = isTask ? session.task?.estimatedTime : null;
    const hasBudget = isTask && !!plannedTime && parseTimeStringToMinutes(plannedTime) > 0;

    // Absolute start time ("nuo 08:14") so the manager can sanity-check plausibility instead
    // of only seeing an ever-growing elapsed counter. Stable for the row (startTime is fixed).
    const startLabel = session.startTime
        ? new Date(session.startTime).toLocaleTimeString('lt-LT', {
              hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Vilnius'
          })
        : '';

    useEffect(() => {
        const updateStale = () => {
            if (!session.startTime) { setIsStale(false); return; }
            const ageMs = Date.now() - new Date(session.startTime).getTime();
            setIsStale(Number.isFinite(ageMs) && ageMs > staleThresholdMs(session.type));
        };

        const updateTime = () => {
            updateStale();
            if (session.type === 'task' && session.task) {
                // Use global task total time calculation for accurate cross-device time
                const totalMinutes = calculateCurrentTotalMinutes(session.task);
                setDurationStr(formatMinutesToTimeString(totalMinutes));
                // Live progress against the planned estimate (capped track fill at 100%).
                const planned = parseTimeStringToMinutes(session.task.estimatedTime || '0');
                setProgressPct(planned > 0 ? Math.min(100, Math.round((totalMinutes / planned) * 100)) : 0);
                return;
            }

            // Fallback for non-task sessions (breaks, calls, quick_work)
            if (!session.startTime) {
                setDurationStr('');
                return;
            }
            const start = new Date(session.startTime);
            const now = new Date();
            const diffMs = now - start;
            if (diffMs < 0) {
                setDurationStr('0m');
                return;
            }

            const diffMinutes = Math.floor(diffMs / (1000 * 60));

            if (diffMinutes < 60) {
                setDurationStr(`${diffMinutes}m`);
            } else {
                const hours = Math.floor(diffMinutes / 60);
                const mins = diffMinutes % 60;
                setDurationStr(`${hours}h ${mins}m`);
            }
        };

        updateTime(); // Initial
        // Update more frequently (every 10 seconds) to ensure synchronization with other timers
        const interval = setInterval(updateTime, 10000);

        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps -- preserve timer re-arm timing; session.type is stable for a given session row
    }, [session.startTime, session.task]);

    const isOver = session.isOverBudget;

    return (
        <div className={`p-3 rounded-card flex flex-col gap-2 shadow-sm transition-all ${session.colorClass} ${isStale ? 'opacity-70 ring-1 ring-feedback-warning' : ''}`}>
            <div className="flex items-center justify-between">
                <div className="flex-shrink-0">
                    <SessionTypeIcon type={session.type} className="w-5 h-5" />
                </div>
                <div className="min-w-0 flex-1 ml-3">
                    <div className="flex items-center gap-2 flex-wrap">
                        <UserChip
                            userId={session.userId}
                            name={session.userName}
                            className="min-w-0"
                        />
                        {isStale && (
                            <span className="inline-flex items-center whitespace-nowrap rounded-full border border-feedback-warning-border bg-feedback-warning-soft px-1.5 py-0.5 text-caption font-semibold text-feedback-warning-text">
                                galimai pasenusi
                            </span>
                        )}
                        {isOver && (
                            <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-feedback-danger-border bg-feedback-danger-soft px-1.5 py-0.5 text-caption font-semibold text-feedback-danger-text">
                                <AlertTriangle className="w-3 h-3" aria-hidden="true" />
                                Viršyta {session.overBudgetPct ? `· ${session.overBudgetPct}%` : ''}
                            </span>
                        )}
                    </div>
                    <div className="text-xs truncate">
                        {session.label}
                        {startLabel && <span> · nuo {startLabel}</span>}
                        {hasBudget && <span> · planas {plannedTime}</span>}
                    </div>
                </div>
                <span className={`font-mono font-bold text-body-lg ml-4 whitespace-nowrap ${isOver ? 'text-feedback-danger' : ''}`}>
                    {durationStr}
                </span>
                {canEnd && isStale && (
                    <IconButton
                        icon={LogOut}
                        variant="danger"
                        label={`Užbaigti sesiją: ${session.userName}`}
                        onClick={onEnd}
                        className="ml-1 flex-shrink-0"
                    />
                )}
            </div>
            {hasBudget && (
                <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-black/10"
                    role="progressbar"
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-label="Suplanuoto laiko išnaudojimas"
                >
                    <div
                        className={`h-full rounded-full transition-all ${isOver ? 'bg-feedback-danger' : 'bg-brand'}`}
                        style={{ width: `${isOver ? 100 : progressPct}%` }}
                    />
                </div>
            )}
        </div>
    );
});

ActiveSessionRow.displayName = 'ActiveSessionRow';

// Amber row for a worker who is scheduled to be working NOW but holds no live session.
const IdlePlannedRow = React.memo(({ row }) => {
    const shiftStartLabel = row.shiftStart
        ? new Date(row.shiftStart).toLocaleTimeString('lt-LT', {
              hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Vilnius'
          })
        : '';
    const lastActiveLabel = row.lastActiveAt
        ? new Date(row.lastActiveAt).toLocaleTimeString('lt-LT', {
              hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Vilnius'
          })
        : '';

    return (
        <div className="p-3 rounded-card flex items-center justify-between shadow-sm border border-feedback-warning-border bg-feedback-warning-soft text-feedback-warning-text">
            <div className="flex-shrink-0">
                <Clock className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 ml-3">
                <UserChip
                    userId={row.userId}
                    name={row.userName}
                    className="min-w-0"
                />
                <div className="text-xs">
                    Suplanuota, bet nepradėta
                    {shiftStartLabel && <span className="opacity-80"> · pamaina nuo {shiftStartLabel}</span>}
                    {lastActiveLabel && <span className="opacity-80"> · paskutinį kartą aktyvus {lastActiveLabel}</span>}
                </div>
            </div>
        </div>
    );
});

IdlePlannedRow.displayName = 'IdlePlannedRow';
