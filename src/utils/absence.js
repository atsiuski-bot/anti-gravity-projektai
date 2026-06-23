// Absence taxonomy for work_hours calendar events.
//
// `isVacation` stays the boolean "this entry is an absence, not worked/planned time" gate — every
// existing exclusion (report Planuota, daily progress, calendar rendering, server aggregation) keys
// on it and must keep working unchanged. `absenceType` REFINES that absence into a kind so a legacy
// holiday week no longer reads identically to annual leave.
//
// REASON-AGNOSTIC MODEL (2026-06-24): WORKZ workers are freelancers who track their own
// unavailability — the *reason* (vacation / sick / holiday / unpaid) is none of the platform's
// business; only that the person is UNAVAILABLE on those days. New absence entries therefore no
// longer ask the worker to pick a kind: they are written with the neutral default type. The full
// `ABSENCE_TYPES` taxonomy is KEPT, non-destructively, so the many *legacy* docs carrying
// 'sick'/'holiday'/'unpaid' still read and label correctly through `normalizeAbsenceType`. A doc
// carrying only `isVacation: true` (written before any type existed) also reads as the default.

export const ABSENCE_TYPES = [
    { value: 'vacation', label: 'Atostogos' },
    { value: 'sick', label: 'Liga' },
    { value: 'holiday', label: 'Šventė' },
    { value: 'unpaid', label: 'Neapmokama' },
];

// The neutral type persisted on every NEW absence (reason-agnostic model). It is deliberately a
// valid `ABSENCE_TYPES` value, NOT a fresh "unavailable" key: `workerStats` buckets absences by the
// raw `absenceType` string without normalizing it, so inventing a new key would silently add an
// unknown bucket and break the absence breakdown. Reusing 'vacation' keeps every existing reader —
// report Planuota exclusion, workerStats absence counting, calendar labels — byte-for-byte unchanged.
const DEFAULT_ABSENCE_TYPE = 'vacation';

// User-facing label for the single reason-agnostic "not working" concept that the planner now
// presents instead of a kind picker. Legacy typed absences keep their own labels via `absenceLabel`.
export const ABSENCE_GENERIC_LABEL = 'Nedirba';

// The canonical type for an event, or null when it is not an absence. Falls back to 'vacation' for
// a legacy absence with a missing/unknown type so callers never see an invalid value.
export function normalizeAbsenceType(event) {
    if (!event?.isVacation) return null;
    const t = event.absenceType;
    return ABSENCE_TYPES.some((a) => a.value === t) ? t : DEFAULT_ABSENCE_TYPE;
}

// User-facing Lithuanian label for an absence event, or null when the event is worked time.
//
// Reason-agnostic display: the neutral default type ('vacation' — what every NEW absence and every
// legacy `isVacation`-only doc normalizes to) reads as "Nedirba", since the platform no longer
// asserts WHY someone is off. The other LEGACY kinds keep their specific labels so historical
// 'sick'/'holiday'/'unpaid' entries still read truthfully. This is display only — the persisted
// `absenceType` and the `isVacation` gate are unchanged, so all aggregation/exclusion is unaffected.
export function absenceLabel(event) {
    const t = normalizeAbsenceType(event);
    if (!t) return null;
    if (t === DEFAULT_ABSENCE_TYPE) return ABSENCE_GENERIC_LABEL;
    return (ABSENCE_TYPES.find((a) => a.value === t) || ABSENCE_TYPES[0]).label;
}

// The value to persist on a work_hours doc: a valid type when it is an absence, else null.
export function absenceTypeForWrite(isVacation, absenceType) {
    if (!isVacation) return null;
    return ABSENCE_TYPES.some((a) => a.value === absenceType) ? absenceType : DEFAULT_ABSENCE_TYPE;
}
