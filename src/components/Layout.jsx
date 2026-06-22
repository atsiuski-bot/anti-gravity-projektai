import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { WifiOff } from 'lucide-react';
import AppHeader from './AppHeader';
import BottomNavigation from './BottomNavigation';
import SideRail from './SideRail';
import InstallPrompt from './InstallPrompt';
import { runDailyAutomation } from '../utils/automationUtils';
import { canSeeWholeTeam } from '../utils/teamScope';
import { useSessionNotification } from '../hooks/useSessionNotification';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { getSessionColors, IDLE_SHELL } from '../utils/sessionColors';
import { cn } from '../utils/cn';
import QuickWorkDescribePrompt from './QuickWorkDescribePrompt';

export default function Layout({ children }) {
    const { userData, isTakingBreak, workStatus } = useAuth();

    // Run the full daily automation (promote + archive) once per day. Gated to WHOLE-TEAM
    // viewers (admins / unscoped managers): it reads & writes EVERY user's tasks, which a scoped
    // manager neither may do (tighter rules) nor should. Both this and Dashboard call the same
    // gated entry point, so neither can consume the daily latch with only a partial subset.
    useEffect(() => {
        if (canSeeWholeTeam(userData)) {
            runDailyAutomation();
        }
    }, [userData]);

    const [isOnline, setIsOnline] = useState(navigator.onLine);

    // Desktop (lg+) swaps the bottom bar + floating work pill for a single left rail. Gated by
    // a JS media query rather than CSS so only ONE nav mounts at a time — the session timers
    // can't be duplicated in the DOM (see useMediaQuery).
    const isDesktop = useMediaQuery('(min-width: 1024px)');

    useEffect(() => {
        const handleOnline = () => setIsOnline(true);
        const handleOffline = () => setIsOnline(false);

        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);

        return () => {
            window.removeEventListener('online', handleOnline);
            window.removeEventListener('offline', handleOffline);
        };
    }, []);

    // Derive active session type — activeSession is the primary source of truth.
    // Legacy flags are only used as a fallback when no activeSession exists.
    const sessionType = userData?.activeSession?.type || null;

    const isQuickWorking = sessionType === 'quickWork' || (!sessionType && (userData?.quickWorkState?.isQuickWorking || false));
    const isCalling = sessionType === 'call' || (!sessionType && (userData?.callState?.isCalling || false));
    const isRunning = sessionType === 'task' || (!sessionType && workStatus?.status === 'running');

    // Resolve a single effective session type (precedence: quick work > call > break > task),
    // then read ALL presentation from the one SESSION_COLORS map so the shell, label and icon
    // can never drift (DESIGN_SYSTEM §4-B).
    let effectiveSessionType = null;
    if (sessionType) {
        effectiveSessionType = getSessionColors(sessionType) ? sessionType : null;
    } else if (isQuickWorking) {
        effectiveSessionType = 'quickWork';
    } else if (isCalling) {
        effectiveSessionType = 'call';
    } else if (isTakingBreak) {
        effectiveSessionType = 'break';
    } else if (isRunning) {
        effectiveSessionType = 'task';
    }

    const session = getSessionColors(effectiveSessionType);
    const bgColor = session?.shell || IDLE_SHELL;

    // The session shells are theme-INVARIANT (a light tint, or saturated red), so text riding
    // DIRECTLY on the shell (not on a card) must not use the themeable ink token — in dark mode
    // ink inverts to near-white and would vanish on a still-light shell. We expose the active
    // shell kind so `.wz-on-shell` text pins to a fixed color (dark on the light shells, white on
    // the red quick-work shell). When idle there is no attribute, so themeable ink applies on the
    // themed canvas. (ADR 0008; the bare page heading is the main consumer — DESIGN_SYSTEM §4-D.)
    const onShellKind = session ? (effectiveSessionType === 'quickWork' ? 'red' : 'light') : undefined;

    // Use system notification hook to show notification in phone's status bar.
    // Honor the per-user toggle from the profile page (missing field => enabled).
    useSessionNotification({
        isQuickWorking,
        isCalling,
        isTakingBreak,
        isRunning,
        enabled: userData?.notificationsEnabled !== false,
    });

    return (
        <div data-session-shell={onShellKind} className={cn('min-h-screen transition-colors duration-slow', bgColor, !isDesktop && 'pb-navclear sm:pb-navclear-lg')}>
            {/* Offline banner — neutral slate, NOT red, so it never collides with the
                quick-work shell (DESIGN_SYSTEM §4-C). Paired with a wifi-off icon. */}
            {!isOnline && (
                <div className="relative z-toast flex items-center justify-center gap-2 bg-feedback-offline px-4 py-1 text-center text-caption font-medium text-white shadow-sm">
                    <WifiOff className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span>Jūs esate neprisijungęs. Duomenys bus išsaugoti telefone ir sinchronizuoti vėliau.</span>
                </div>
            )}

            {/* Desktop (lg+): one left rail replaces the bottom bar + floating work pill
                (DESIGN_SYSTEM §9). Mounted exclusively opposite BottomNavigation so the session
                timers are never duplicated in the DOM (see useMediaQuery). */}
            <div className={cn(isDesktop && 'flex items-start')}>
                {isDesktop && <SideRail />}

                <div className={cn('min-w-0', isDesktop && 'flex-1')}>
                    {/* Calm top bar: active-session pill + notification bell + profile avatar.
                        Replaces the old floating avatar bubble AND the full-width session strip —
                        the pill still pairs the session colour with a label+icon (DESIGN_SYSTEM
                        §4-A, WCAG 1.4.1). */}
                    <AppHeader sessionType={effectiveSessionType} session={session} />

                    {/* PWA install — a slim, dismissible banner shown only when the browser offers
                        an install (or on iOS, manual steps). Mobile-only: it self-suppresses on
                        desktop (lg+), where the nudge is noise. */}
                    <InstallPrompt />

                    <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-2 pb-8 relative">
                        <div className="relative z-10">
                            {/* Retroactive description for quick-work sessions ended on another
                                device — a calm prompt that never collides with the shell above. */}
                            <QuickWorkDescribePrompt />
                            {children}
                        </div>
                    </main>
                </div>
            </div>

            {!isDesktop && <BottomNavigation />}
        </div>
    );
}
