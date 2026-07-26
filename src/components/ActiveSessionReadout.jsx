import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useActiveSessionStatus } from '../hooks/useActiveSessionStatus';
import { getLithuanianNow, clampSessionMinutes, formatMinutesToTimeString } from '../utils/timeUtils';
import { SESSION_COLORS } from '../utils/sessionColors';
import { pausedSessionStack } from '../utils/sessionNesting';
import { cn } from '../utils/cn';

// Live readout for the active secondary session (quick work / call / break), surfaced as its
// OWN floating pill ABOVE the controls bar. This keeps the controls pill itself as short as an
// icon + label — no reserved timer row inside it. Renders nothing when nothing is running.
//
// Label, icon, and the accent/surface colors all come from the one SESSION_COLORS map (no local
// palette copy). The only thing kept here is STATE_KEYS — the legacy per-state field on the user
// doc (quickWorkState/callState/breakState) used for the start-time fallback — which is a data
// concern, not a presentation one, so it does not belong in SESSION_COLORS. `task` is absent on
// purpose: this readout is only for the secondary sessions, so a running task renders nothing
// (matching the previous behavior, where READOUT had no `task` entry).
const STATE_KEYS = {
    quickWork: 'quickWorkState',
    call: 'callState',
    break: 'breakState',
};

export default function ActiveSessionReadout() {
    const { userData } = useAuth();
    const { activeSessionType } = useActiveSessionStatus();
    const stateKey = STATE_KEYS[activeSessionType];
    const cfg = stateKey ? SESSION_COLORS[activeSessionType] : null;

    // activeSession is the authoritative start time; fall back to the legacy per-state
    // lastStartedAt only when no activeSession object exists (mirrors useTimerState).
    const activeSession = userData?.activeSession;
    let startISO = null;
    if (cfg) {
        if (activeSession?.type === activeSessionType && activeSession.startTime) {
            startISO = activeSession.startTime;
        } else if (!activeSession) {
            startISO = userData?.[stateKey]?.lastStartedAt || null;
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

    // What this session was started ON TOP of. A parked session is one the worker must come back and
    // end, so leaving it invisible turns it into forgotten — and therefore unlogged — time. Named in
    // full ("Laukia: Pertrauka"), never by colour or icon alone (§4-A / WCAG 1.4.1).
    const parked = pausedSessionStack(activeSession)
        .map((node) => SESSION_COLORS[node.type])
        .filter(Boolean);

    const Icon = cfg?.Icon;
    return (
        <>
            {/* Out-of-flow live region: speaks the session start/stop event, not the ticking time. */}
            <div role="status" aria-live="polite" className="sr-only">
                {announcement}
            </div>

            {active && (
                <div className="flex flex-col items-center gap-1 animate-in fade-in slide-in-from-bottom-2">
                    <div
                        className={cn(
                            'flex items-center gap-2 rounded-full border px-3 py-1 shadow-md backdrop-blur-sm',
                            cfg.accentBorder, cfg.surface, cfg.accent
                        )}
                    >
                        <Icon className="h-4 w-4 wz-pulse-soft" aria-hidden="true" />
                        <span className="text-caption font-medium">{cfg.label}</span>
                        <span className="font-mono text-body-lg font-bold leading-none tabular-nums">
                            {/* Per-second heartbeat: proof the clock runs between minute changes. */}
                            <span className="wz-tick">{formatMinutesToTimeString(minutes)}</span>
                        </span>
                    </div>

                    {parked.length > 0 && (
                        <div
                            className="flex items-center gap-1.5 rounded-full border border-line bg-surface-card px-2.5 py-0.5 shadow-sm"
                            // One sentence for a screen reader instead of a row of loose labels.
                            aria-label={`Laukia: ${parked.map((p) => p.label).join(', ')}`}
                        >
                            <span className="text-caption text-ink-muted" aria-hidden="true">Laukia:</span>
                            {parked.map((p, index) => (
                                <span
                                    key={`${p.type}-${index}`}
                                    className="flex items-center gap-1 text-caption font-medium text-ink"
                                    aria-hidden="true"
                                >
                                    <p.Icon className="h-3.5 w-3.5 shrink-0" />
                                    {p.label}
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </>
    );
}
