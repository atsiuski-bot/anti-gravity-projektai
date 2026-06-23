import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import ActiveSessionReadout from './ActiveSessionReadout';
import NotificationBell from './NotificationBell';
import Avatar from './ui/Avatar';
import { cn } from '../utils/cn';

/**
 * SessionPill — the active session shown in the top bar. Secondary sessions (quick work / call /
 * break) render their own live-timer pill via ActiveSessionReadout; a running task shows a calm
 * label pill (its per-second timer lives on the task card, not here). Renders nothing when idle.
 *
 * For a running task the pill also surfaces the task TITLE (from activeSession.taskTitle) next to
 * the calm "Vyksta darbas" label, so the worker can see WHAT is running without opening a card.
 * Quick-work / call / break stay title-less by design (their readout is a live timer, not a task).
 *
 * This replaces the old full-width session strip: the icon + label still pairs with the
 * whole-screen session colour, so colour is never the sole signal (DESIGN_SYSTEM §4-A).
 */
function SessionPill({ sessionType, session, taskTitle }) {
    if (sessionType === 'task' && session) {
        const title = taskTitle?.trim();
        return (
            <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-card px-3 py-1 shadow-sm">
                <session.Icon className={cn('h-4 w-4 shrink-0 wz-pulse-soft', session.accent)} aria-hidden="true" />
                <span className="shrink-0 text-caption font-semibold text-ink-muted">{session.label}</span>
                {title && (
                    <span className="truncate text-caption font-semibold text-ink-strong" title={title}>
                        {title}
                    </span>
                )}
            </div>
        );
    }
    return <ActiveSessionReadout />;
}

/**
 * AppHeader — the calm top bar (DESIGN_SYSTEM §9). Left: the active-session pill. Right: the
 * notification bell (+ unread badge) and the avatar (profile entry). No brand/role here — those
 * stay in the desktop side rail; on mobile the brand was never shown.
 *
 * `surface-card` keeps it quiet so the whole-screen session colour below still dominates the
 * canvas. Sticky so the bell and active session are always reachable from any tab.
 */
export default function AppHeader({ sessionType, session }) {
    const { currentUser, userData } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();

    return (
        <header className="sticky top-0 z-nav flex h-12 items-center justify-between gap-2 border-b border-line bg-surface-card/95 px-3 backdrop-blur-sm sm:px-4">
            <div className="flex min-w-0 flex-1 items-center">
                <SessionPill sessionType={sessionType} session={session} taskTitle={userData?.activeSession?.taskTitle} />
            </div>

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
