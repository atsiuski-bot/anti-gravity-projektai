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
    pending: 'bg-feedback-warning-soft text-feedback-warning-text',
    running: 'bg-feedback-success-soft text-feedback-success-text',
    done: 'bg-surface-sunken text-ink-muted',
    success: 'bg-feedback-success-soft text-feedback-success-text',
    info: 'bg-feedback-info-soft text-feedback-info-text',
    danger: 'bg-feedback-danger-soft text-feedback-danger-text',
    // Achievement tiers — a sibling set for the inline (earned-chip) form of a badge. These
    // carry NO status semantics; the trophy-tile form is <Badge>. Pair with a tier label so
    // color is never the sole signal (§5).
    tierBronze: 'bg-tier-bronze-surface text-tier-bronze-accent',
    tierSilver: 'bg-tier-silver-surface text-tier-silver-accent',
    tierGold: 'bg-tier-gold-surface text-tier-gold-accent',
    tierPlatinum: 'bg-tier-platinum-surface text-tier-platinum-accent',
};

export default function StatusPill({ tone = 'neutral', icon: Icon, children, className }) {
    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-caption font-medium',
                // Tween the tone color so a status change (pending -> running -> done) eases
                // rather than snapping.
                'transition-colors duration-base',
                TONES[tone] || TONES.neutral,
                className
            )}
        >
            {Icon && <Icon className="w-3.5 h-3.5" aria-hidden="true" />}
            {children}
        </span>
    );
}
