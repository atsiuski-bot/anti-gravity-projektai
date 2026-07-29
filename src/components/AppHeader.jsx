import { useEffect, useState, lazy, Suspense } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import ActiveSessionReadout from './ActiveSessionReadout';
import NotificationBell from './NotificationBell';
import Avatar from './ui/Avatar';
import BrandMark from './ui/BrandMark';
import { useActiveTaskElapsedMinutes } from '../hooks/useActiveTaskElapsedMinutes';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { cn } from '../utils/cn';

// The header ships in the BASE bundle (it is on every screen), and this modal pulls the whole task
// detail sheet in behind it — so importing it eagerly put a sheet that opens on a deliberate tap
// into the bytes every worker downloads before first paint. Lazy: the pill is what is always
// present, the sheet is fetched the first time someone opens it.
const ActiveWorkModal = lazy(() => import('./ActiveWorkModal'));

/**
 * ActiveTaskPill — the running-task readout in the top bar: icon + "Vyksta veikla" + the task TITLE
 * (from activeSession.taskTitle), so the worker sees WHAT is running without opening a card, plus
 * the live time it has already taken.
 *
 * The time is the task's CANONICAL total (the very number its card shows), not a bare delta since
 * the current stretch began — a task paused for a break and resumed must not report two different
 * elapsed times on one screen. When the task carries a planned duration it is shown as
 * "spent / planned", so the worker reads the remaining budget without opening the card; an
 * unplanned task simply shows the spent time. Ticking text is intentionally NOT wrapped in a live
 * region: a screen reader would re-read the pill every second (ActiveSessionReadout documents the
 * same rule).
 */
function ActiveTaskPill({ session, taskTitle, taskId, onTask }) {
    const { minutes, estimatedTime, task } = useActiveTaskElapsedMinutes(taskId);
    const title = taskTitle?.trim();

    // Hand the subscribed document up so tapping the pill can open the task's own card without a
    // second listener on the same doc. Reported on every change, so the card always holds the live
    // copy rather than the one captured when it opened.
    useEffect(() => { onTask?.(task); }, [task, onTask]);

    return (
        <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-card px-3 py-1 shadow-sm">
            <session.Icon className={cn('h-4 w-4 shrink-0 wz-pulse-soft', session.accent)} aria-hidden="true" />
            <span className="shrink-0 text-caption font-semibold text-ink-muted">{session.label}</span>
            {title && (
                <span className="truncate text-caption font-semibold text-ink-strong" title={title}>
                    {title}
                </span>
            )}
            {minutes !== null && (
                <span className={cn('shrink-0 font-mono text-body font-bold leading-none tabular-nums', session.accent)}>
                    {/* The digits only move once a minute; the per-second pulse is what tells the
                        worker the clock is still counting. */}
                    <span className="wz-tick">{formatMinutesToTimeString(minutes)}</span>
                    {estimatedTime && (
                        <span className="font-normal text-ink-muted">{' / '}{estimatedTime}</span>
                    )}
                </span>
            )}
        </div>
    );
}

/**
 * SessionPill — the active session shown in the top bar. Secondary sessions (quick work / call /
 * break) render their own live-timer pill via ActiveSessionReadout; a running task renders
 * ActiveTaskPill. Renders nothing when idle.
 *
 * This replaces the old full-width session strip: the icon + label still pairs with the
 * whole-screen session colour, so colour is never the sole signal (DESIGN_SYSTEM §4-A).
 */
function SessionPill({ sessionType, session, taskTitle, taskId, onTask }) {
    if (sessionType === 'task' && session) {
        return <ActiveTaskPill session={session} taskTitle={taskTitle} taskId={taskId} onTask={onTask} />;
    }
    return <ActiveSessionReadout />;
}

/**
 * AppHeader — the calm top bar (DESIGN_SYSTEM §9). Left: the brand mark when idle, swapped for the
 * active-session pill the moment a session runs (the pill can carry a task title, so it claims the
 * scarce mobile width and the logo steps aside). Right: the notification bell (+ unread badge) and
 * the avatar (profile entry).
 *
 * `surface-card` keeps it quiet so the whole-screen session colour below still dominates the
 * canvas. Sticky so the bell and active session are always reachable from any tab.
 */
export default function AppHeader({ sessionType, session }) {
    const { currentUser, userData } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const [showActiveWork, setShowActiveWork] = useState(false);
    const [activeTask, setActiveTask] = useState(null);

    // The pill answers "what is running"; opening it answers "and what exactly is that" — the task's
    // own card, or the session card for a break/call/quick work. Wrapped in a button rather than made
    // clickable in place so it is reachable by keyboard and announced as an action; it fills the
    // header's full height, which is what gives the small pill a 48 px touch target (§ touch size).
    const openable = Boolean(sessionType);

    return (
        <header className="sticky top-0 z-nav flex h-12 items-center justify-between gap-2 border-b border-line bg-surface-card/95 px-3 backdrop-blur-sm sm:px-4">
            <div className="flex min-w-0 flex-1 items-center">
                {sessionType ? (
                    <button
                        type="button"
                        onClick={() => setShowActiveWork(true)}
                        aria-label="Atidaryti vykstančią veiklą"
                        aria-haspopup="dialog"
                        className="flex h-12 min-w-0 items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                    >
                        <SessionPill
                            sessionType={sessionType}
                            session={session}
                            taskTitle={userData?.activeSession?.taskTitle}
                            // Legacy fallback mirrors Layout's own: a running task with no
                            // activeSession is still identified by workStatus.activeTaskId, so its
                            // time still shows.
                            taskId={userData?.activeSession?.taskId || userData?.workStatus?.activeTaskId || null}
                            onTask={setActiveTask}
                        />
                    </button>
                ) : (
                    <BrandMark size="sm" />
                )}
            </div>

            {/* Mounted only once opened, so the chunk is fetched on the tap that needs it — not on
                every render of a header that is always on screen. */}
            {openable && showActiveWork && (
                <Suspense fallback={null}>
                    <ActiveWorkModal
                        isOpen={showActiveWork}
                        onClose={() => setShowActiveWork(false)}
                        sessionType={sessionType}
                        task={activeTask}
                    />
                </Suspense>
            )}

            <div className="flex items-center gap-1">
                <NotificationBell />
                <button
                    type="button"
                    onClick={() => setActiveTab('profile')}
                    aria-label="Atidaryti profilį"
                    aria-current={activeTab === 'profile' ? 'page' : undefined}
                    className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-full transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                >
                    <Avatar
                        src={userData?.photoURL || currentUser?.photoURL}
                        name={currentUser?.displayName}
                        email={currentUser?.email}
                        size="sm"
                    />
                </button>
            </div>
        </header>
    );
}
