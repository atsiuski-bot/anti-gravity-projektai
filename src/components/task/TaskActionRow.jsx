import { useState, useCallback, useLayoutEffect, useRef } from 'react';
import clsx from 'clsx';
import Button from '../ui/Button';

/**
 * useOneLineActions — keeps a row of action buttons on a SINGLE line, full-width-adaptive, and
 * collapses every label to icon-only the moment the labelled set no longer fits.
 *
 * It measures fit instead of guessing a viewport breakpoint: an invisible mirror row holds the
 * SAME buttons at their natural (labelled) width; we compare that needed width to the real row's
 * available width. Because the mirror always carries labels, the measurement is independent of
 * the current compact state — so the decision can't oscillate.
 *
 * Re-measurement is belt-and-suspenders: a cheap pass after every render (one reflow per commit)
 * covers becoming-visible — e.g. mounting inside an inactive tab, where clientWidth is 0 and any
 * decision would be wrong — plus a ResizeObserver for instant response to width changes that don't
 * trigger a render (dragging a desktop window edge, orientation change).
 */
function useOneLineActions() {
    const rowRef = useRef(null);
    const mirrorRef = useRef(null);
    const [compact, setCompact] = useState(false);

    const measure = useCallback(() => {
        const row = rowRef.current;
        const mirror = mirrorRef.current;
        if (!row || !mirror) return;
        // Skip while hidden (clientWidth 0): a later render/resize re-measures once visible.
        // mirror is overflow-hidden, so scrollWidth is the full labelled width even when wider
        // than the row. setCompact bails on an unchanged value, so this can never loop.
        if (row.clientWidth === 0) return;
        setCompact(mirror.scrollWidth > row.clientWidth + 0.5);
    }, []);

    useLayoutEffect(() => { measure(); });

    useLayoutEffect(() => {
        const row = rowRef.current;
        if (!row || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(() => measure());
        ro.observe(row);
        return () => ro.disconnect();
    }, [measure]);

    return { rowRef, mirrorRef, compact };
}

/**
 * TaskActionRow — the ONE adaptive action-button row used everywhere a task carries actions: the
 * mobile card, the desktop table, the detail modal footer, and the notification cards. Every action
 * renders as the SAME kind of bordered/filled Button; they share the row width (flex-auto) and stay
 * on a single line. A hidden mirror (same buttons at natural, labelled width) measures whether the
 * labels fit; when they don't, ALL buttons drop to icon-only together — still real 44px buttons with
 * an accessible name (via aria-label/title), never a bare glyph (DESIGN_SYSTEM §8).
 *
 * `compactLabel` is the escape hatch for a button whose meaning lives in its TEXT, not its icon:
 * when several actions share one glyph (e.g. two "extend time" grants that differ only by amount),
 * dropping to icon-only would make them indistinguishable. Such an action keeps a SHORT label in the
 * compact state instead of vanishing to a bare icon — so the differentiator stays visible while the
 * row still fits one line. Actions without it collapse to icon-only as before.
 *
 * @param {Object} props
 * @param {Array<{key:string,label:string,compactLabel?:string,icon?:Function,variant?:string,onClick?:Function,disabled?:boolean,loading?:boolean,className?:string}>} props.actions
 * @param {string} [props.className] - wrapper classes (e.g. spacing)
 */
export default function TaskActionRow({ actions, className }) {
    const { rowRef, mirrorRef, compact } = useOneLineActions();
    if (!actions || actions.length === 0) return null;
    return (
        <div className={clsx('relative', className)}>
            {/* Mirror — invisible, measures the natural labelled width */}
            <div
                ref={mirrorRef}
                aria-hidden="true"
                className="pointer-events-none invisible absolute inset-x-0 top-0 flex gap-1.5 overflow-hidden"
            >
                {actions.map((a) => (
                    <Button
                        key={a.key}
                        variant={a.variant}
                        size="md"
                        icon={a.icon}
                        tabIndex={-1}
                        className={clsx('shrink-0 whitespace-nowrap px-3', a.className)}
                    >
                        {a.label}
                    </Button>
                ))}
            </div>
            {/* Real row — all buttons flex-auto to share width; labels hide together when too tight */}
            <div ref={rowRef} className="flex items-center gap-1.5">
                {actions.map((a) => (
                    <Button
                        key={a.key}
                        variant={a.variant}
                        size="md"
                        icon={a.icon}
                        aria-label={a.label}
                        title={a.label}
                        disabled={a.disabled}
                        loading={a.loading}
                        className={clsx('min-w-0 flex-auto px-3', a.className)}
                        onClick={a.onClick}
                    >
                        {compact
                            ? (a.compactLabel ? <span className="whitespace-nowrap">{a.compactLabel}</span> : null)
                            : <span className="truncate">{a.label}</span>}
                    </Button>
                ))}
            </div>
        </div>
    );
}
