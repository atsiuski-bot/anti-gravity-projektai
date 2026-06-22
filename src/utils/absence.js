// Absence taxonomy for work_hours calendar events.
//
// `isVacation` stays the boolean "this entry is an absence, not worked/planned time" gate — every
// existing exclusion (report Planuota, daily progress, calendar rendering) keys on it and must keep
// working unchanged. `absenceType` REFINES that absence into a kind (vacation / sick / holiday /
// unpaid) so a holiday week no longer reads identically to annual leave. A legacy doc that carries
// only `isVacation: true` (written before this field existed) reads as 'vacation'.

export const ABSENCE_TYPES = [
    { value: 'vacation', label: 'Atostogos' },
    { value: 'sick', label: 'Liga' },
    { value: 'holiday', label: 'Šventė' },
    { value: 'unpaid', label: 'Neapmokama' },
];

const DEFAULT_ABSENCE_TYPE = 'vacation';

// The canonical type for an event, or null when it is not an absence. Falls back to 'vacation' for
// a legacy absence with a missing/unknown type so callers never see an invalid value.
export function normalizeAbsenceType(event) {
    if (!event?.isVacation) return null;
    const t = event.absenceType;
    return ABSENCE_TYPES.some((a) => a.value === t) ? t : DEFAULT_ABSENCE_TYPE;
}

// User-facing Lithuanian label for an absence event, or null when the event is worked time.
export function absenceLabel(event) {
    const t = normalizeAbsenceType(event);
    if (!t) return null;
    return (ABSENCE_TYPES.find((a) => a.value === t) || ABSENCE_TYPES[0]).label;
}

// The value to persist on a work_hours doc: a valid type when it is an absence, else null.
export function absenceTypeForWrite(isVacation, absenceType) {
    if (!isVacation) return null;
    return ABSENCE_TYPES.some((a) => a.value === absenceType) ? absenceType : DEFAULT_ABSENCE_TYPE;
}
