import { CheckCircle2, CalendarCheck } from 'lucide-react';

/**
 * Client-side badge presentation. The awarded doc (users/{uid}/achievements/{key}) carries the
 * `name`, `tier` (1-4) and `tierName` — but NOT the glyph, since icons are React components and
 * can't live in Firestore. Look the icon up here by the server badge `key`.
 */
export const BADGE_ICONS = {
    follow_through: CheckCircle2, // R1 — finishes what they start
    steady_rhythm: CalendarCheck, // R2 — shows up across days
};

// Awarded docs store the tier as a number (1-4); <Badge> takes the tier KEY.
export const TIER_KEYS = ['bronze', 'silver', 'gold', 'platinum'];

export function tierKey(tier) {
    return TIER_KEYS[(tier || 1) - 1] || 'bronze';
}
