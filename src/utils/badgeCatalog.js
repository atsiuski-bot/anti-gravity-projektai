import { CheckCircle2, CalendarCheck, Target, CalendarClock, ShieldCheck, ListChecks, Flame, AlarmClock } from 'lucide-react';

/**
 * Client-side badge presentation. The awarded doc (users/{uid}/achievements/{key}) carries the
 * `name`, `tier` (1-4) and `tierName` — but NOT the glyph, since icons are React components and
 * can't live in Firestore. Look the icon up here by the server badge `key`.
 */
export const BADGE_ICONS = {
    follow_through: CheckCircle2, // R1 — finishes what they start
    steady_rhythm: CalendarCheck, // R2 — shows up across days
    on_estimate: Target,          // R3 — lands within the estimate
    plans_ahead: CalendarClock,   // R4 — plans the week ahead
    on_time_start: AlarmClock,    // R6 — starts near the planned shift
    approved_craft: ShieldCheck,  // Q1 — work a manager accepted
    thorough: ListChecks,         // Q2 — completes the full checklist
    hard_tasks: Flame,            // Q4 — takes the high-priority work
};

// Awarded docs store the tier as a number (1-4); <Badge> takes the tier KEY.
export const TIER_KEYS = ['bronze', 'silver', 'gold', 'platinum'];

export function tierKey(tier) {
    return TIER_KEYS[(tier || 1) - 1] || 'bronze';
}

/**
 * The FULL ladder, mirroring the server-side BADGES map in functions/index.js (key, name and the
 * four tier thresholds must stay in lockstep with it). The `description`/`unit` are client-only,
 * user-facing copy (formal "Jūs") that explains what earns the badge — used to render the
 * not-yet-earned tiles and the per-badge detail sheet on the OWNER's profile. Peer profiles stay
 * earned-only (guardrail W4), so this catalog is intentionally not used there.
 *
 * Order = reliability group, then quality group — the same grouping the server documents.
 */
export const BADGE_CATALOG = [
    // Reliability
    {
        key: 'follow_through',
        name: 'Pabaigiu, ką pradedu',
        unit: 'užbaigti darbai',
        description: 'Skiriamas už užbaigtus darbus — kuo daugiau darbų pabaigiate, tuo aukštesnė pakopa.',
        thresholds: [1, 10, 40, 120],
    },
    {
        key: 'steady_rhythm',
        name: 'Pastovus ritmas',
        unit: 'darbo dienos',
        description: 'Skiriamas už nuoseklų darbą — kiek skirtingų dienų esate dirbę.',
        thresholds: [5, 25, 75, 200],
    },
    {
        key: 'on_estimate',
        name: 'Telpa į planą',
        unit: 'darbai laiku',
        description: 'Skiriamas už darbus, užbaigtus neviršijus numatyto laiko.',
        thresholds: [5, 20, 60, 150],
    },
    {
        key: 'plans_ahead',
        name: 'Planuoja iš anksto',
        unit: 'suplanuotos savaitės',
        description: 'Skiriamas už savaites, kurias suplanuojate iš anksto kalendoriuje.',
        thresholds: [2, 8, 20, 40],
    },
    {
        key: 'on_time_start',
        name: 'Punktualus startas',
        unit: 'punktualios dienos',
        description: 'Skiriamas už dienas, kai darbą pradedate netoli suplanuotos pamainos pradžios.',
        thresholds: [5, 20, 50, 120],
    },
    // Quality
    {
        key: 'approved_craft',
        name: 'Priimtas darbas',
        unit: 'priimti darbai',
        description: 'Skiriamas už darbus, kuriuos peržiūrėjęs priėmė vadovas.',
        thresholds: [3, 15, 50, 120],
    },
    {
        key: 'thorough',
        name: 'Kruopštus',
        unit: 'darbai su pilnu sąrašu',
        description: 'Skiriamas už darbus, kuriuose iki galo atliekate visą kontrolinį sąrašą.',
        thresholds: [3, 15, 40, 100],
    },
    {
        key: 'hard_tasks',
        name: 'Imasi sunkių',
        unit: 'sunkūs darbai',
        description: 'Skiriamas už užbaigtus aukšto prioriteto darbus.',
        thresholds: [3, 12, 30, 75],
    },
];
