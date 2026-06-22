import { cn } from '../../utils/cn';

/**
 * Badge — the canonical achievement "trophy" tile (DESIGN_SYSTEM §8, tokens.md §1).
 *
 * One badge, one of four tiers. The metal identity is carried by THREE redundant signals so
 * color is never the sole one (§5): the tier `surface`+`ring` color, the tier text label
 * ("Bronza/Sidabras/Auksas/Platina"), and 1–4 filled pips. Sits on white `surface-card`,
 * never on a colored session shell. Non-interactive by default — wrap in a button/Modal when
 * it needs a 44px touch target.
 *
 * Tier class strings are written as full literals (not interpolated) so Tailwind's content
 * scanner keeps them.
 *
 * @param {'bronze'|'silver'|'gold'|'platinum'} tier
 * @param {string} name - the badge name (e.g. "Pabaigiu, ką pradedu")
 * @param {React.ComponentType<{className?: string}>} [icon] - the badge glyph
 * @param {'sm'|'md'} [size]
 */
const TIERS = {
    bronze: {
        order: 1, label: 'Bronza',
        medallion: 'bg-tier-bronze-surface text-tier-bronze-accent ring-tier-bronze-ring',
        tierText: 'text-tier-bronze-accent',
        pip: 'bg-tier-bronze-ring',
    },
    silver: {
        order: 2, label: 'Sidabras',
        medallion: 'bg-tier-silver-surface text-tier-silver-accent ring-tier-silver-ring',
        tierText: 'text-tier-silver-accent',
        pip: 'bg-tier-silver-ring',
    },
    gold: {
        order: 3, label: 'Auksas',
        medallion: 'bg-tier-gold-surface text-tier-gold-accent ring-tier-gold-ring',
        tierText: 'text-tier-gold-accent',
        pip: 'bg-tier-gold-ring',
    },
    platinum: {
        order: 4, label: 'Platina',
        medallion: 'bg-tier-platinum-surface text-tier-platinum-accent ring-tier-platinum-ring',
        tierText: 'text-tier-platinum-accent',
        pip: 'bg-tier-platinum-ring',
    },
};

const MEDALLION_SIZE = {
    sm: 'h-10 w-10',
    md: 'h-12 w-12',
};

export default function Badge({ tier = 'bronze', name, icon: Icon, size = 'md', className }) {
    const t = TIERS[tier] || TIERS.bronze;

    return (
        <div
            role="img"
            aria-label={`${name}: ${t.label}, lygis ${t.order} iš 4`}
            className={cn('flex flex-col items-center text-center', className)}
        >
            <div
                aria-hidden="true"
                className={cn(
                    'flex items-center justify-center rounded-full ring-2',
                    MEDALLION_SIZE[size] || MEDALLION_SIZE.md,
                    t.medallion
                )}
            >
                {Icon && <Icon className={size === 'sm' ? 'h-5 w-5' : 'h-6 w-6'} />}
            </div>
            <span className="mt-2 text-caption font-semibold text-ink">{name}</span>
            <span className={cn('text-caption', t.tierText)}>{t.label}</span>
            <div aria-hidden="true" className="mt-1.5 flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                    <span
                        key={i}
                        className={cn('h-1.5 w-1.5 rounded-full', i <= t.order ? t.pip : 'bg-line')}
                    />
                ))}
            </div>
        </div>
    );
}
