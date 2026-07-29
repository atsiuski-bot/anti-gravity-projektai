import { useEffect, useRef, useState } from 'react';
import { useActiveSecondarySession } from '../hooks/useActiveSecondarySession';
import { formatMinutesToTimeString } from '../utils/timeUtils';
import { SESSION_COLORS } from '../utils/sessionColors';
import { cn } from '../utils/cn';

// Live readout for the active secondary session (quick work / call / break), surfaced as its
// OWN floating pill ABOVE the controls bar. This keeps the controls pill itself as short as an
// icon + label — no reserved timer row inside it. Renders nothing when nothing is running.
//
// Label, icon, and the accent/surface colors all come from the one SESSION_COLORS map (no local
// palette copy). What is running and for how long comes from useActiveSecondarySession, shared with
// the card the header pill opens — two independent elapsed timers for one session would let the
// same screen show it two different ways.
export default function ActiveSessionReadout() {
    const { active, cfg, minutes, parkedNodes } = useActiveSecondarySession();

    // Announce ONLY the start/stop transition — never the per-second tick. Wrapping the elapsed
    // time in a live region makes a screen reader re-read the whole pill every second (an SR
    // anti-pattern). Instead, a persistent visually-hidden live region speaks one message when a
    // button-triggered session begins or ends; the visible pill stays purely visual but remains
    // readable on demand. (WCAG 4.1.3 Status Messages.)
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
    const parked = parkedNodes
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
