/**
 * Is this Samsung Internet? Its install path builds its own WebAPK, which Android 14+ / Play
 * Protect flags as "built for an older version of Android" — while Chrome installs the same
 * manifest cleanly. So on Samsung Internet we steer the user to Chrome instead of offering the
 * browser's own install. Pure: takes the user-agent string so it can be unit-tested.
 */
export function isSamsungInternet(userAgent) {
    return /SamsungBrowser\//.test(userAgent || '');
}
