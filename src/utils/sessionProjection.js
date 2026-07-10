const SESSION_PROJECTION_KEYS = [
    'activeSession',
    'breakState',
    'callState',
    'quickWorkState',
    'workStatus',
];

export function applyPendingSessionProjection(confirmed, projection) {
    if (!confirmed || !projection) return confirmed;
    const next = { ...confirmed };
    for (const key of SESSION_PROJECTION_KEYS) {
        if (!Object.prototype.hasOwnProperty.call(projection, key)) continue;
        const value = projection[key];
        if (
            value
            && typeof value === 'object'
            && !Array.isArray(value)
            && confirmed[key]
            && typeof confirmed[key] === 'object'
        ) {
            next[key] = { ...confirmed[key], ...value };
        } else {
            next[key] = value;
        }
    }
    return next;
}
