import { cn } from '../../utils/cn';
import guildBadgeAtlas from '../../assets/badges/guild-badges-atlas.webp';
import bunnyBadgeAtlas from '../../assets/badges/zivile-bunny-badges-atlas.webp';

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
 * `medallion` and `tierText` deliberately use DIFFERENT colour tokens. The medallion's `accent` is
 * tuned against the tier's own (theme-invariant) `surface` and is AA there in both themes. The tier
 * caption, though, rides on the THEMED card — where that same fill-tuned accent measured 1.65-3.20:1
 * in dark mode. `label` is the theme-reactive foreground token for exactly that position
 * (src/index.css); do not collapse the two back into one.
 *
 * A `locked` badge is one the user has not earned yet: it drops all metal color to a neutral
 * grey so the earned tiles read as "loud" against it, but it keeps its name + icon so the owner
 * can see what is still available to earn (own-profile ladder only — guardrail W4).
 *
 * @param {'bronze'|'silver'|'gold'|'platinum'} tier
 * @param {string} name - the badge name (e.g. "Pabaigiu, ką pradedu")
 * @param {React.ComponentType<{className?: string}>} [icon] - the badge glyph fallback
 * @param {'sm'|'md'} [size]
 * @param {boolean} [locked] - render the neutral not-yet-earned state
 */
const TIERS = {
    bronze: {
        order: 1, label: 'Bronza',
        medallion: 'bg-tier-bronze-surface text-tier-bronze-accent ring-tier-bronze-ring',
        tierText: 'text-tier-bronze-label',
        pip: 'bg-tier-bronze-ring',
    },
    silver: {
        order: 2, label: 'Sidabras',
        medallion: 'bg-tier-silver-surface text-tier-silver-accent ring-tier-silver-ring',
        tierText: 'text-tier-silver-label',
        pip: 'bg-tier-silver-ring',
    },
    gold: {
        order: 3, label: 'Auksas',
        medallion: 'bg-tier-gold-surface text-tier-gold-accent ring-tier-gold-ring',
        tierText: 'text-tier-gold-label',
        pip: 'bg-tier-gold-ring',
    },
    platinum: {
        order: 4, label: 'Platina',
        medallion: 'bg-tier-platinum-surface text-tier-platinum-accent ring-tier-platinum-ring',
        tierText: 'text-tier-platinum-label',
        pip: 'bg-tier-platinum-ring',
    },
};

const MEDALLION_SIZE = {
    sm: 'h-10 w-10',
    md: 'h-12 w-12',
};

const ATLAS_POSITIONS = {
    follow_through: '0% 0%',
    steady_rhythm: '50% 0%',
    on_estimate: '100% 0%',
    plans_ahead: '0% 50%',
    on_time_start: '50% 50%',
    approved_craft: '100% 50%',
    thorough: '0% 100%',
    hard_tasks: '50% 100%',
    documented: '100% 100%',
};

export default function Badge({ tier = 'bronze', name, icon: Icon, badgeKey, bunnyTheme = false, size = 'md', locked = false, className }) {
    const t = TIERS[tier] || TIERS.bronze;
    const filledPips = locked ? 0 : t.order;
    const hasAtlasIcon = Boolean(badgeKey && ATLAS_POSITIONS[badgeKey]);
    const atlasSrc = bunnyTheme ? bunnyBadgeAtlas : guildBadgeAtlas;

    return (
        <div
            role="img"
            aria-label={
                locked
                    ? `${name}: dar neturite`
                    : `${name}: ${t.label}, lygis ${t.order} iš 4`
            }
            className={cn('flex flex-col items-center text-center', className)}
        >
            <div
                aria-hidden="true"
                className={cn(
                    'flex items-center justify-center rounded-full ring-2 overflow-hidden',
                    MEDALLION_SIZE[size] || MEDALLION_SIZE.md,
                    locked ? 'bg-surface-sunken text-ink-muted ring-line' : t.medallion
                )}
            >
                {hasAtlasIcon ? (
                    <span
                        className={cn('h-full w-full rounded-full bg-cover', locked && 'grayscale opacity-40')}
                        style={{
                            backgroundImage: `url(${atlasSrc})`,
                            backgroundPosition: ATLAS_POSITIONS[badgeKey],
                            backgroundSize: '300% 300%',
                        }}
                    />
                ) : (
                    Icon && <Icon className={size === 'sm' ? 'h-5 w-5' : 'h-6 w-6'} />
                )}
            </div>
            <div aria-hidden="true" className="mt-2 flex gap-1">
                {[1, 2, 3, 4].map((i) => (
                    <span
                        key={i}
                        className={cn('h-1.5 w-1.5 rounded-full', i <= filledPips ? t.pip : 'bg-line')}
                    />
                ))}
            </div>
            <span className={cn('mt-2 text-caption font-semibold', locked ? 'text-ink-muted' : 'text-ink')}>
                {name}
            </span>
            <span className={cn('text-caption', locked ? 'text-ink-muted' : t.tierText)}>
                {locked ? 'Dar neturite' : t.label}
            </span>
        </div>
    );
}
