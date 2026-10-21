import { useRef, useState } from 'react';
import { AlarmClock } from 'lucide-react';
import { cn } from '../../utils/cn';
import { hapticTap } from '../../utils/haptics';

// A gesture only becomes a swipe once it is clearly horizontal: past this many px, and wider than
// tall by this ratio. Anything else is left to the browser (scroll) and to the drag sensor
// (press-and-hold reorder, which a >8px move before its 250ms delay already cancels).
const DECIDE_PX = 10;
const HORIZONTAL_RATIO = 1.5;
// Release past this distance (or this share of the card width, whichever is smaller) to snooze.
const COMMIT_PX = 110;
const COMMIT_SHARE = 0.35;

/**
 * SwipeToSnooze — the Gmail-style shortcut on the mobile task card: swipe LEFT to open the
 * "Atidėti iki" sheet. A shortcut only — the same action is a real button in the task's detail
 * sheet, so nothing depends on the gesture (WCAG 2.5.1). Releasing early springs the card back.
 *
 * Touch events (not pointer events) so it composes with @dnd-kit's TouchSensor on the sortable
 * list; `touch-action: pan-y` keeps vertical scrolling native while the horizontal axis is ours.
 * The click that a touch can synthesise after a swipe is swallowed, so a swipe never also opens
 * the detail sheet.
 */
export default function SwipeToSnooze({ enabled, onSnooze, children }) {
    const [dx, setDx] = useState(0);
    const [swiping, setSwiping] = useState(false);
    const [armed, setArmed] = useState(false);
    const gesture = useRef(null);
    const swallowClick = useRef(false);

    if (!enabled) return children;

    const threshold = () => Math.min(COMMIT_PX, (gesture.current?.width || 320) * COMMIT_SHARE);

    const onTouchStart = (e) => {
        if (e.touches.length !== 1) { gesture.current = null; return; }
        const t = e.touches[0];
        gesture.current = { x: t.clientX, y: t.clientY, mode: null, width: e.currentTarget.offsetWidth, armed: false };
    };

    const onTouchMove = (e) => {
        const g = gesture.current;
        if (!g || g.mode === 'scroll') return;
        const t = e.touches[0];
        const mx = t.clientX - g.x;
        const my = t.clientY - g.y;
        if (!g.mode) {
            if (Math.abs(mx) < DECIDE_PX && Math.abs(my) < DECIDE_PX) return;
            g.mode = mx < 0 && Math.abs(mx) > Math.abs(my) * HORIZONTAL_RATIO ? 'swipe' : 'scroll';
            if (g.mode !== 'swipe') return;
            setSwiping(true);
        }
        const next = Math.min(0, mx);
        const nowArmed = -next >= threshold();
        if (nowArmed && !g.armed) hapticTap();
        g.armed = nowArmed;
        setArmed(nowArmed);
        setDx(next);
    };

    const onTouchEnd = () => {
        const g = gesture.current;
        gesture.current = null;
        if (!g || g.mode !== 'swipe') return;
        swallowClick.current = true;
        setTimeout(() => { swallowClick.current = false; }, 400);
        setSwiping(false);
        setArmed(false);
        setDx(0);
        if (g.armed) onSnooze();
    };

    const onClickCapture = (e) => {
        if (!swallowClick.current) return;
        e.stopPropagation();
        e.preventDefault();
    };

    return (
        <div
            className={cn('relative', dx < 0 && 'overflow-hidden rounded-card')}
            style={{ touchAction: 'pan-y' }}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
            onTouchCancel={onTouchEnd}
            onClickCapture={onClickCapture}
        >
            {dx < 0 && (
                <div
                    aria-hidden="true"
                    className={cn(
                        'absolute inset-x-0 bottom-2 top-0 flex items-center justify-end gap-2 rounded-card border-2 pr-5 text-body font-semibold',
                        armed
                            ? 'border-feedback-warning bg-feedback-warning-soft text-feedback-warning-text'
                            : 'border-feedback-warning-border bg-feedback-warning-soft text-feedback-warning-text'
                    )}
                >
                    <AlarmClock className={cn('h-5 w-5 transition-transform duration-base', armed && 'scale-125')} />
                    Atidėti
                </div>
            )}
            <div
                style={{
                    transform: dx ? `translateX(${dx}px)` : undefined,
                    transition: swiping ? 'none' : 'transform 150ms ease-out',
                }}
            >
                {children}
            </div>
        </div>
    );
}
