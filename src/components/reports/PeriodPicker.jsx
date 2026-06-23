import { useRef, useState, useLayoutEffect } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import Button from '../ui/Button';

// Period picker that fits as many preset chips inline as the row width allows, hiding the rest
// behind an expander. A hidden measuring row carries every chip at its natural width; an observer
// recomputes how many lead chips fit whenever the visible row resizes. The expander panel reveals
// the presets that did not fit inline plus the custom from/to range (children), so nothing the
// inline row clips is ever unreachable. One component drives every period picker in the app.
export function PeriodPicker({ presets, activeId, onChoose, open, onToggle, label, children }) {
    const wrapRef = useRef(null);
    const measureRef = useRef(null);
    const [visibleCount, setVisibleCount] = useState(presets.length);

    useLayoutEffect(() => {
        const wrapEl = wrapRef.current;
        const measureEl = measureRef.current;
        if (!wrapEl || !measureEl) return;
        const GAP = 8; // matches gap-2 between chips
        const compute = () => {
            const avail = wrapEl.clientWidth;
            // The picker can mount while its tab panel is still zero-width (hidden tab, pre-layout
            // pass). Measuring then would wrongly conclude "nothing fits" and lock the row to a
            // single chip even after it becomes wide. Skip until we have a real width — the
            // ResizeObserver re-fires with the true size once the panel lays out.
            if (avail <= 0) return;
            const chips = Array.from(measureEl.children);
            let used = 0;
            let count = 0;
            for (let i = 0; i < chips.length; i++) {
                used += chips[i].offsetWidth + (i > 0 ? GAP : 0);
                if (used <= avail) count++;
                else break;
            }
            setVisibleCount(Math.max(1, count));
        };
        compute();
        const ro = new ResizeObserver(compute);
        ro.observe(wrapEl);
        return () => ro.disconnect();
    }, [presets]);

    const hiddenCount = presets.length - visibleCount;
    const chipClass = (id) =>
        `shrink-0 inline-flex items-center justify-center min-h-touch px-3 rounded-control text-body font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand ${
            activeId === id
                ? 'bg-brand text-on-brand border-brand'
                : 'bg-surface-card text-ink-strong border-line hover:bg-surface-sunken'
        }`;

    return (
        <div className="bg-surface-card rounded-card shadow-sm border border-line">
            {/* The bar matches the export button's height exactly: one min-h-touch row with no extra
                vertical padding, so the chips (also min-h-touch) define the height. The old calendar
                icon + "Laikotarpis" caption are dropped — the chips are self-describing, and removing
                them frees the full width for as many presets as fit inline. */}
            <div role="group" aria-label={label} className="flex items-center gap-2 px-2 min-h-touch">
                {/* Inline chips: only those that fit on one line; the rest live in the panel below. */}
                <div ref={wrapRef} className="relative flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
                    {/* Hidden row at natural width — the single source of truth for chip widths. */}
                    <div ref={measureRef} aria-hidden="true" className="absolute left-0 top-0 flex items-center gap-2 opacity-0 pointer-events-none">
                        {presets.map((p) => (
                            <span key={p.id} className={chipClass(p.id)}>{p.label}</span>
                        ))}
                    </div>
                    {presets.slice(0, visibleCount).map((p) => (
                        <button key={p.id} type="button" onClick={() => onChoose(p.id)} className={chipClass(p.id)}>
                            {p.label}
                        </button>
                    ))}
                </div>

                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={open}
                    aria-label={open ? 'Suskleisti laikotarpio parinktis' : 'Daugiau laikotarpio parinkčių'}
                    className="shrink-0 inline-flex items-center gap-1 min-h-touch px-2 rounded-control text-ink-muted hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                >
                    {!open && hiddenCount > 0 && (
                        <span className="text-caption font-bold text-ink-strong">+{hiddenCount}</span>
                    )}
                    {open
                        ? <ChevronUp className="w-4 h-4" aria-hidden="true" />
                        : <ChevronDown className="w-4 h-4" aria-hidden="true" />}
                </button>
            </div>

            {open && (
                <div className="border-t border-line p-3 space-y-3 animate-in fade-in slide-in-from-top-2">
                    {/* Only the presets that did NOT fit inline — the visible ones already sit in the
                        bar above, so repeating every preset here would be redundant. The panel always
                        still carries the custom from/to range (children). */}
                    {hiddenCount > 0 && (
                        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                            {presets.slice(visibleCount).map((p) => (
                                <Button
                                    key={p.id}
                                    variant={activeId === p.id ? 'primary' : 'secondary'}
                                    onClick={() => onChoose(p.id)}
                                    className="justify-center"
                                >
                                    {p.label}
                                </Button>
                            ))}
                        </div>
                    )}
                    {children}
                </div>
            )}
        </div>
    );
}
