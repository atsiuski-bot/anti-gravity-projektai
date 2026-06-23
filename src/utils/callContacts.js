import { Users, Handshake, Truck, MoreHorizontal } from 'lucide-react';

/**
 * CALL_CONTACT_TYPES — the single source of truth for "who did you talk to?" on a call.
 *
 * A finished call is logged as a system task; this classifies the counterpart so reports can
 * group calls by audience (colleagues vs. clients vs. suppliers/partners). One call carries
 * exactly one type (single-select), and picking one is required before the call can be saved.
 *
 *  - `id`     the value persisted on the task / work_session (`contactType`)
 *  - `label`  the singular Lithuanian noun used in the call TITLE ("Skambutis – Klientas")
 *  - `chip`   the (possibly plural) Lithuanian label shown on the picker chip
 *  - `Icon`   the lucide glyph for the chip
 */
export const CALL_CONTACT_TYPES = [
    { id: 'colleague', label: 'Kolega', chip: 'Kolegos', Icon: Users },
    { id: 'client', label: 'Klientas', chip: 'Klientai', Icon: Handshake },
    { id: 'supplier', label: 'Tiekėjas / partneris', chip: 'Tiekėjai / partneriai', Icon: Truck },
    { id: 'other', label: 'Kita', chip: 'Kita', Icon: MoreHorizontal },
];

const BY_ID = Object.fromEntries(CALL_CONTACT_TYPES.map((t) => [t.id, t]));

/** The singular title noun for a contact type, or null when unknown / unset. */
export function getCallContactLabel(id) {
    return BY_ID[id]?.label || null;
}

/** Build the persisted call title from a chosen contact type ("Skambutis – Klientas"). */
export function buildCallTitle(contactType) {
    const label = getCallContactLabel(contactType);
    return label ? `Skambutis – ${label}` : 'Skambutis';
}
