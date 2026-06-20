import { cn } from '../../utils/cn';

/**
 * StatusPill — one pill, color-coded by state (DESIGN_SYSTEM §8): `caption` text, full
 * radius, consistent padding. Use a short label (e.g. "Pradėtas"), never a sentence, and
 * pair the color with the text so color is never the sole signal (§5).
 *
 * Tones are chosen so text/background meet WCAG AA (>= 4.5:1).
 */
const TONES = {
    neutral: 'bg-surface-sunken text-ink',
    pending: 'bg-amber-100 text-amber-800',
    running: 'bg-green-100 text-green-800',
    done: 'bg-surface-sunken text-ink-muted',
    info: 'bg-brand-soft text-brand-hover',
    danger: 'bg-red-50 text-red-700',
};

export default function StatusPill({ tone = 'neutral', icon: Icon, children, className }) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium',
                TONES[tone] || TONES.neutral,
                className
            )}
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </span>
    );
}
