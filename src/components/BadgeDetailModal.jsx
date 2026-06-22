import { Check } from 'lucide-react';
import { cn } from '../utils/cn';
import { BADGE_ICONS, TIER_KEYS } from '../utils/badgeCatalog';
import Modal from './ui/Modal';
import Badge from './ui/Badge';

const TIER_LABELS = ['Bronza', 'Sidabras', 'Auksas', 'Platina'];

/**
 * BadgeDetailModal — the "what is this for" sheet opened by tapping any badge tile on the owner's
 * profile. Works for both earned and not-yet-earned badges: it shows the badge at its current
 * tier (or the neutral locked state), the plain-language description of what earns it, and the
 * four tier thresholds with the already-reached ones marked. This is the read of the ladder the
 * owner uses to see what is still ahead — peer profiles never open it (guardrail W4).
 *
 * @param {{ key: string, name: string, unit: string, description: string,
 *           thresholds: number[], tier: number }} badge - a catalog entry merged with the
 *           earned tier (0 = not earned yet)
 */
export default function BadgeDetailModal({ badge, onClose }) {
    if (!badge) return null;
    const earned = badge.tier || 0;
    const Icon = BADGE_ICONS[badge.key];

    return (
        <Modal open onClose={onClose} ariaLabel={`${badge.name}: aprašymas`} size="sm">
            <div className="flex flex-col items-center text-center">
                <Badge
                    tier={TIER_KEYS[earned - 1] || 'bronze'}
                    name={badge.name}
                    icon={Icon}
                    locked={earned === 0}
                />
                <p className="mt-4 text-body text-ink">{badge.description}</p>
            </div>

            <div className="mt-5">
                <h3 className="mb-2 text-caption font-medium text-ink-muted">Pakopos</h3>
                <ul className="space-y-1.5">
                    {badge.thresholds.map((threshold, i) => {
                        const tier = i + 1;
                        const reached = earned >= tier;
                        return (
                            <li
                                key={tier}
                                className={cn(
                                    'flex items-center gap-3 rounded-control px-3 py-2',
                                    reached ? 'bg-surface-sunken' : ''
                                )}
                            >
                                <span
                                    aria-hidden="true"
                                    className={cn(
                                        'inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
                                        reached ? 'bg-feedback-success text-white' : 'border border-line text-transparent'
                                    )}
                                >
                                    <Check className="h-3.5 w-3.5" />
                                </span>
                                <span className={cn('flex-1 text-body', reached ? 'font-medium text-ink-strong' : 'text-ink-muted')}>
                                    {TIER_LABELS[i]}
                                </span>
                                <span className={cn('text-caption', reached ? 'text-ink' : 'text-ink-muted')}>
                                    {threshold} {badge.unit}
                                    <span className="sr-only">{reached ? ' — pasiekta' : ''}</span>
                                </span>
                            </li>
                        );
                    })}
                </ul>
            </div>
        </Modal>
    );
}
