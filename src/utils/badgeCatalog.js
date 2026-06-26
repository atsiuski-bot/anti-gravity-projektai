import { CheckCircle2, CalendarCheck, Target, CalendarClock, ShieldCheck, ListChecks, Flame, AlarmClock, Camera } from 'lucide-react';

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
    documented: Camera,           // A1 — attaches a work-end proof photo
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
        unit: 'užbaigtos veiklos',
        description: 'Skiriamas už užbaigtas veiklas (neįskaitant greitų darbų) — kuo daugiau veiklų pabaigiate, tuo aukštesnė pakopa.',
        thresholds: [5, 60, 600, 1500],
    },
    {
        key: 'steady_rhythm',
        name: 'Pastovus ritmas',
        unit: 'veiklos dienos',
        description: 'Skiriamas už nuoseklią veiklą — kiek skirtingų dienų esate dirbę.',
        thresholds: [10, 60, 300, 750],
    },
    {
        key: 'on_estimate',
        name: 'Telpa į planą',
        unit: 'veiklos laiku',
        description: 'Skiriamas už veiklas, užbaigtas neviršijus numatyto laiko.',
        thresholds: [10, 80, 450, 1100],
    },
    {
        key: 'plans_ahead',
        name: 'Planuoja iš anksto',
        unit: 'suplanuotos savaitės',
        description: 'Skiriamas už savaites, kurias suplanuojate iš anksto kalendoriuje.',
        thresholds: [3, 15, 60, 150],
    },
    {
        key: 'on_time_start',
        name: 'Pradeda laiku',
        unit: 'dienos laiku',
        description: 'Skiriamas už dienas, kai veiklą pradedate netoli suplanuoto veiklos laiko pradžios.',
        thresholds: [10, 60, 280, 650],
    },
    // Quality
    {
        key: 'approved_craft',
        name: 'Priimta veikla',
        unit: 'priimtos veiklos',
        description: 'Skiriamas už veiklas, kurias peržiūrėjęs priėmė koordinatorius.',
        thresholds: [5, 75, 600, 1800],
    },
    {
        key: 'thorough',
        name: 'Kruopštus',
        unit: 'veiklos su pilnu sąrašu',
        description: 'Skiriamas už veiklas, kuriose iki galo atliekate visą kontrolinį sąrašą.',
        thresholds: [2, 10, 40, 120],
    },
    {
        key: 'hard_tasks',
        name: 'Imasi sunkių',
        unit: 'sunkios veiklos',
        description: 'Skiriamas už užbaigtas aukšto prioriteto veiklas.',
        thresholds: [5, 60, 300, 800],
    },
    // Accountability
    {
        key: 'documented',
        name: 'Dokumentuoja darbą',
        unit: 'veiklos su pabaigos nuotrauka',
        description: 'Skiriamas už užbaigtas veiklas, prie kurių pridedate darbo pabaigos nuotrauką.',
        thresholds: [3, 25, 120, 350],
    },
];
