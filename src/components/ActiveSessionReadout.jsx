import { useEffect, useRef, useState } from 'react';
import { Zap, Phone, Coffee } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { getLithuanianNow, clampSessionMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { cn } from '../utils/cn';

// Live readout for the active secondary session (quick work / call / break), surfaced as its
// OWN floating pill ABOVE the controls bar. This keeps the controls pill itself as short as an
// icon + label — no reserved timer row inside it. Renders nothing when nothing is running.
const READOUT = {
    quickWork: {
        label: 'Greitas darbas',
        icon: Zap,
        stateKey: 'quickWorkState',
        tone: 'border-session-quickWork-accent bg-session-quickWork-surface text-session-quickWork-accent',
    },
    call: {
        label: 'Skambutis',
        icon: Phone,
        stateKey: 'callState',
        tone: 'border-session-call-accent bg-session-call-surface text-session-call-accent',
    },
    break: {
        label: 'Pertrauka',
        icon: Coffee,
        stateKey: 'breakState',
        tone: 'border-session-break-accent bg-session-break-surface text-session-break-accent',
    },
};

export default function ActiveSessionReadout() {
    const { userData } = useAuth();
    const { activeSessionType } = useActiveSessionStatus();
    const cfg = READOUT[activeSessionType];

    // activeSession is the authoritative start time; fall back to the legacy per-state
    // lastStartedAt only when no activeSession object exists (mirrors useTimerState).
    const activeSession = userData?.activeSession;
    let startISO = null;
    if (cfg) {
        if (activeSession?.type === activeSessionType && activeSession.startTime) {
            startISO = activeSession.startTime;
        } else if (!activeSession) {
            startISO = userData?.[cfg.stateKey]?.lastStartedAt || null;
        }
    }

    const [minutes, setMinutes] = useState(0);
    useEffect(() => {
        if (!startISO) {
            setMinutes(0);
            return undefined;
        }
        const start = new Date(startISO);
        // Sanitize the live delta through the shared clamp so a backward device clock can't
        // render a negative time (same guard the in-card timers use).
        const tick = () => setMinutes(clampSessionMinutes((getLithuanianNow() - start) / (1000 * 60)));
        tick();
        const interval = setInterval(tick, 1000);
        return () => clearInterval(interval);
    }, [startISO]);

    // Announce ONLY the start/stop transition — never the per-second tick. Wrapping the elapsed
    // time in a live region makes a screen reader re-read the whole pill every second (an SR
    // anti-pattern). Instead, a persistent visually-hidden live region speaks one message when a
    // button-triggered session begins or ends; the visible pill stays purely visual but remains
    // readable on demand. (WCAG 4.1.3 Status Messages.)
    const active = Boolean(cfg && startISO);
    const label = cfg?.label;
    const lastLabelRef = useRef('');
    const [announcement, setAnnouncement] = useState('');
    useEffect(() => {
        if (active && label) {
            lastLabelRef.current = label;
            setAnnouncement(`Pradėta: ${label}`);
        } else if (lastLabelRef.current) {
            setAnnouncement(`Baigta: ${lastLabelRef.current}`);
            lastLabelRef.current = '';
        }
    }, [active, label]);

    const Icon = cfg?.icon;
    return (
        <>
            {/* Out-of-flow live region: speaks the session start/stop event, not the ticking time. */}
            <div role="status" aria-live="polite" className="sr-only">
                {announcement}
            </div>

            {active && (
                <div
                    className={cn(
                        'flex items-center gap-2 rounded-full border px-3 py-1 shadow-md backdrop-blur-sm',
                        'animate-in fade-in slide-in-from-bottom-2',
                        cfg.tone
                    )}
                >
                    <Icon className="h-4 w-4 wz-pulse-soft" aria-hidden="true" />
                    <span className="text-caption font-medium">{cfg.label}</span>
                    <span className="font-mono text-body-lg font-bold leading-none tabular-nums">
                        {formatMinutesToTimeString(minutes)}
                    </span>
                </div>
            )}
        </>
    );
}
