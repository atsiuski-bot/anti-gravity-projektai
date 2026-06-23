// Work-location vocabulary in one place, so every surface (planner, team calendar,
// reports, the profile default) names the same two states identically. Naming used to
// drift across screens ("Darbas ofise", "Darbas", "Dirbtuvėse", "Nuotolinis darbas",
// "Iš namų"); this module is the single source of truth.
//
// The STORED shape is unchanged: each work_hours entry still carries one boolean,
// `isWorkFromHome` — false = on-site "Veikla", true = "Veikla namuose". This module only
// owns how that boolean is LABELLED and which value a brand-new entry starts on (the
// per-user default below). See ProfilePage for the setting and WorkPlanner for where new
// entries read it.

export const WORK_LOCATIONS = [
    { value: 'office', label: 'Veikla' },
    { value: 'home', label: 'Veikla namuose' },
];

export const DEFAULT_WORK_LOCATION = 'office';

// User-facing noun for an entry, derived from its stored boolean.
export function workLocationLabel(isWorkFromHome) {
    return isWorkFromHome ? 'Veikla namuose' : 'Veikla';
}

// Coerce a stored preference into a known value; unknown / missing falls back to office.
export function normalizeWorkLocation(pref) {
    return WORK_LOCATIONS.some((l) => l.value === pref) ? pref : DEFAULT_WORK_LOCATION;
}

// Whether a brand-new entry should start as work-from-home, given the user's saved default.
// Existing entries are never touched by this — it only seeds the initial toggle state.
export function defaultIsWorkFromHome(pref) {
    return normalizeWorkLocation(pref) === 'home';
}
