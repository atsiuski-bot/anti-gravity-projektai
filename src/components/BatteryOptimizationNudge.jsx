import { useCallback, useState } from 'react';
import { BatteryWarning, X } from 'lucide-react';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import NotificationDeliveryHelp from './NotificationDeliveryHelp';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { useNotificationPermission } from '../hooks/useNotificationPermission';
import { useMediaQuery } from '../hooks/useMediaQuery';

// Why this banner exists: on Android, battery optimisation is ON by default and silently freezes the
// service worker in the background, so a granted permission is NOT enough — the push the server sends
// may never surface. We cannot detect that state (no web API) nor fix it from code; the only lever is
// to tell the user, once, to check their phone's power settings. So this is a one-time, dismissible
// heads-up, mirroring the install banner's snooze model (a stray tap must not silence it forever).
const SNOOZE_KEY = 'workz.batteryNudgeSnoozeUntil';
const DAY_MS = 24 * 60 * 60 * 1000;
const DISMISS_DAYS = 180; // "Got it" / dismissed — a rare, low-value re-nag; back off for half a year.

// In-memory fallback so the snooze also sticks within a session when localStorage is unavailable
// (private browsing), instead of re-showing on every reload.
let sessionSnoozed = false;

/**
 * BatteryOptimizationNudge — a slim, dismissible heads-up (DESIGN_SYSTEM: calm canvas) reminding
 * the user to keep the app running in the background so push notifications actually arrive. It opens
 * the shared NotificationDeliveryHelp guide for the OS-specific steps.
 *
 * Shown only when it can possibly help: a phone viewport (not desktop), notifications already
 * GRANTED (nothing to reassure if they're still off — the Profile toggle handles that gate), and not
 * iOS (iOS uses a different background model; its guidance lives in the install/notification flow).
 * Rendered once in the app shell, next to InstallPrompt.
 */
export default function BatteryOptimizationNudge() {
    const { isIOS } = useInstallPrompt();
    const { permission } = useNotificationPermission();
    // Same desktop breakpoint as the SideRail / InstallPrompt gate, so "phone view" means one thing.
    const isDesktop = useMediaQuery('(min-width: 1024px)');
    const [showHelp, setShowHelp] = useState(false);
    const [snoozed, setSnoozed] = useState(() => {
        if (sessionSnoozed) return true;
        try {
            return Number(localStorage.getItem(SNOOZE_KEY) || 0) > Date.now();
        } catch {
            return false;
        }
    });

    const snooze = useCallback(() => {
        sessionSnoozed = true;
        setSnoozed(true);
        try {
            localStorage.setItem(SNOOZE_KEY, String(Date.now() + DISMISS_DAYS * DAY_MS));
        } catch {
            // localStorage unavailable (private mode) — the in-memory flag covers this session.
        }
    }, []);

    // Battery-optimisation kill is an Android-shaped problem; only nag a phone whose permission is on.
    const canShow = !isDesktop && !isIOS && permission === 'granted' && !snoozed;

    return (
        <>
            {canShow && (
                <div
                    role="region"
                    aria-label="Pranešimų pristatymas"
                    className="flex items-center gap-3 border-b border-line bg-feedback-warning-soft px-4 py-2"
                >
                    <BatteryWarning className="h-5 w-5 shrink-0 text-feedback-warning-text" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="truncate text-caption font-semibold text-feedback-warning-text">
                            Kad pranešimai nedingtų
                        </p>
                        <p className="truncate text-caption text-ink">
                            Leiskite programėlei veikti fone telefono nustatymuose
                        </p>
                    </div>
                    <Button variant="secondary" size="md" onClick={() => setShowHelp(true)} className="shrink-0">
                        Kaip
                    </Button>
                    <IconButton icon={X} label="Atmesti" onClick={snooze} className="shrink-0" />
                </div>
            )}

            {showHelp && <NotificationDeliveryHelp isIOS={isIOS} onClose={() => setShowHelp(false)} />}
        </>
    );
}
