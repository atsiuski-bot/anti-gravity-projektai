export const parseTimeStringToMinutes = (str) => {
    // Add safety checks
    if (!str || typeof str !== 'string') return 0;

    try {
        // Normalize: lowercase, trim, comma -> period as the decimal separator (applied to
        // the WHOLE string, so "1,5h" and "30,5m" are handled consistently).
        const norm = str.trim().toLowerCase().replace(',', '.');

        // Strict, fully-anchored match: optional "<num>h|val" followed by optional "<int>m|min".
        // Anchoring (^...$) is deliberate: it REJECTS malformed input (e.g. "-30m", "2h 2h",
        // "30.5m", "10m20m") to 0 instead of silently partial-matching it to a surprising,
        // wrong number — the previous regex matched the first fragment anywhere in the string.
        const match = norm.match(/^(?:(\d+(?:\.\d+)?)\s*(?:h|val))?\s*(?:(\d+)\s*(?:m|min))?$/);
        if (!match) return 0;

        let total = 0;
        const hours = match[1] ? parseFloat(match[1]) : 0;
        const mins = match[2] ? parseInt(match[2], 10) : 0;
        if (Number.isFinite(hours) && hours >= 0) total += hours * 60;
        if (Number.isFinite(mins) && mins >= 0) total += mins;

        return Number.isFinite(total) ? total : 0;
    } catch (error) {
        console.warn('Error parsing time string:', str, error);
        return 0;
    }
};

export const formatMinutesToTimeString = (minutes) => {
    // Guard non-finite too: a NaN/Infinity slipping through (e.g. a malformed session summed
    // into a total) previously rendered the literal "NaNh NaNm" / "Infinityh NaNm" to users.
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
    const isNegative = minutes < 0;
    const totalMinutes = Math.round(Math.abs(minutes));
    const prefix = isNegative ? '-' : '';
    if (totalMinutes < 60) {
        return `${prefix}${totalMinutes}m`;
    }
    const h = Math.floor(totalMinutes / 60);
    const m = totalMinutes % 60;
    if (m === 0) return `${prefix}${h}h`;
    return `${prefix}${h}h ${m}m`;
};

// Zero-padded "HH:MM" rendering for the payroll CSV exports (Reports + TaskHistory).
// The minute total is rounded to whole minutes ONCE, before the hour/minute split, so a
// fractional remainder in [59.5, 60) carries into the hour instead of printing an invalid
// ":60". (The previous in-line copies floored the hour and rounded the minute part
// independently, which is what produced "03:60" rows in exported timesheets.) Magnitude
// only — sign handling lives in formatSignedMinutesToHHMM.
export const formatMinutesToHHMM = (totalMinutes) => {
    if (!totalMinutes || !Number.isFinite(totalMinutes)) return '00:00';
    const total = Math.round(Math.abs(totalMinutes));
    const hours = Math.floor(total / 60);
    const mins = total % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
};

// Signed "±HH:MM" for difference columns (e.g. worked − planned). Rounds first so the sign
// is decided on the same whole-minute value the magnitude is formatted from, then defers to
// formatMinutesToHHMM (which already carries the minute correctly). Zero renders unsigned.
export const formatSignedMinutesToHHMM = (minutes) => {
    if (!Number.isFinite(minutes)) return '00:00';
    // Round the MAGNITUDE, not the signed value: Math.round(-239.5) === -239 (ties round toward
    // +∞), which would mis-carry the negative case to "-03:59" while +239.5 carries to "+04:00".
    const rounded = Math.round(Math.abs(minutes));
    if (rounded === 0) return '00:00';
    const sign = minutes < 0 ? '-' : '+';
    return `${sign}${formatMinutesToHHMM(rounded)}`;
};

// Hard ceiling for a single continuous timer/session interval (minutes). A real
// break, call, quick-work, or task run never approaches this; a larger raw value can
// only come from device-clock skew or a session/timer orphaned across a crash or
// reload. Clamping every (now - start) delta to this bound is what stops "ghost time"
// from being credited and stops the auto-pause limit from firing on an absurd elapsed.
// 16h is comfortably above any real shift, so legitimate intervals are never clipped.
export const MAX_SESSION_MINUTES = 16 * 60;

// Sanitize a raw (now - start) minute delta before it is credited or logged: a
// non-finite or negative value (clock set backward, a future start time) collapses to
// 0; an implausibly large value is capped to MAX_SESSION_MINUTES. Every place that
// turns a wall-clock delta into credited time funnels through this.
export const clampSessionMinutes = (minutes) => {
    if (!Number.isFinite(minutes) || minutes < 0) return 0;
    return Math.min(minutes, MAX_SESSION_MINUTES);
};

// Fat-finger ceiling for a manual task-total edit / correction delta (minutes). A task total
// can legitimately exceed a single session (work accumulates across days), so it is NOT bound
// by MAX_SESSION_MINUTES; but a mistyped hours field (e.g. "999") must not become permanent,
// uncapped corruption. 1000h is far above any real single-task total yet catches gross typos.
export const MAX_MANUAL_TASK_MINUTES = 1000 * 60;

// Minimum credited/logged session length (minutes). A tap shorter than this is treated as an
// accidental start/stop — the telemetry showed many 00:00–00:01 work/break rows from mis-taps —
// so the segment is discarded rather than persisted. Raised from the original ~10s to 60s so a
// fat-fingered toggle on a phone (gloved hands, outdoors) cannot mint a micro-session.
export const MIN_LOGGED_SESSION_MINUTES = 1;

// Read-side plausibility guard for report AGGREGATION. Already-persisted session docs can be
// corrupt — a pre-clamp orphaned timer, or a manual edit entered before bounds existed — and
// no write-time fix reaches data already in Firestore, so every report aggregator funnels each
// stored value through this before summing. It is the read-side twin of clampSessionMinutes
// (which guards writes): a normal tracked session is a positive interval capped at the 16h
// single-session ceiling; a task total or manual-adjustment delta (allowLarge) may be negative
// or legitimately large, so only its gross magnitude is capped (at MAX_MANUAL_TASK_MINUTES).
export const sanitizeReportMinutes = (durationMinutes, { allowLarge = false } = {}) => {
    const raw = Number(durationMinutes);
    if (!Number.isFinite(raw)) return 0;
    if (allowLarge) {
        if (raw > MAX_MANUAL_TASK_MINUTES) return MAX_MANUAL_TASK_MINUTES;
        if (raw < -MAX_MANUAL_TASK_MINUTES) return -MAX_MANUAL_TASK_MINUTES;
        return raw;
    }
    if (raw <= 0) return 0;
    return Math.min(raw, MAX_SESSION_MINUTES);
};

// True when a stored duration is implausible for its kind, so a report can FLAG the row to the
// manager (a "⚠ patikrinti" affordance) rather than silently capping or dropping it. Mirrors
// the ceilings sanitizeReportMinutes enforces.
export const isImplausibleSessionMinutes = (durationMinutes, { allowLarge = false } = {}) => {
    const raw = Number(durationMinutes);
    if (!Number.isFinite(raw)) return false;
    return allowLarge ? Math.abs(raw) > MAX_MANUAL_TASK_MINUTES : raw > MAX_SESSION_MINUTES;
};

// Calculate current total time including active session if running
export const calculateCurrentTotalMinutes = (task) => {
    // Add safety check for task object
    if (!task || typeof task !== 'object') return 0;

    try {
        let total = 0;

        total = (task.manualMinutes || 0) + (task.timerMinutes || 0);

        // 2. If zero, try parsing actualTime string (Old System / Fallback)
        // checking total === 0 safeguards against double counting if we have both
        if (total === 0 && !task.timeChanged && (task.accumulatedMinutes || task.actualTime)) {
            total = task.accumulatedMinutes || parseTimeStringToMinutes(task.actualTime) || 0;
        }

        // Add explicit time adjustments
        if (task.timeAdjustments && Array.isArray(task.timeAdjustments)) {
            task.timeAdjustments.forEach(adj => {
                total += (adj.durationMinutes || 0);
            });
        }

        // Add currently running session time if any. clampSessionMinutes rejects a
        // negative delta (clock skew / future start) and caps an implausibly large one
        // (a timer left running across a crash/reload), so a stale timerStartedAt can no
        // longer inflate the displayed total or trip the auto-pause limit on a ghost value.
        if (task.timerStatus === 'running' && task.timerStartedAt) {
            try {
                const start = new Date(task.timerStartedAt);
                if (!isNaN(start.getTime())) {
                    const now = new Date();
                    total += clampSessionMinutes((now - start) / (1000 * 60));
                }
            } catch (dateError) {
                console.warn('Invalid timer start date:', task.timerStartedAt);
            }
        }

        return Number.isFinite(total) ? total : 0;
    } catch (error) {
        console.error('Error calculating total minutes for task:', task?.id, error);
        return 0;
    }
};

/**
 * Returns a Date object representing the current moment, 
 * but ensures operations can be performed in Lithuanian context.
 */
export const getLithuanianNow = () => {
    return new Date();
};

/**
 * Returns YYYY-MM-DD string according to Lithuania's current time.
 */
export const getLithuanianDateString = (date = new Date()) => {
    const d = typeof date === 'string' ? new Date(date) : date;
    const options = { timeZone: 'Europe/Vilnius', year: 'numeric', month: '2-digit', day: '2-digit' };
    const parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(d);
    const year = parts.find(p => p.type === 'year').value;
    const month = parts.find(p => p.type === 'month').value;
    const day = parts.find(p => p.type === 'day').value;
    return `${year}-${month}-${day}`;
};

/**
 * Adds (or subtracts) whole calendar days to a YYYY-MM-DD string and returns a YYYY-MM-DD
 * string. Pure UTC calendar arithmetic, so it is DST-independent and never lands on a
 * non-existent local hour. Use this to derive a day-window's end as the NEXT day's 03:00
 * cutoff (getLithuanian3AMCutoff of dateStr+1) instead of "cutoff + 24h": across a DST
 * boundary a fixed +24h leaves a 1-hour gap (work dropped) or overlap (work double-counted).
 *
 * @param {string} dateStr - A YYYY-MM-DD date string.
 * @param {number} [days=1] - Days to add (may be negative).
 * @returns {string} The shifted YYYY-MM-DD string.
 */
export const addDaysToDateString = (dateStr, days = 1) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
};

/**
 * Returns the Monday-of-week date string (YYYY-MM-DD) for the Vilnius calendar week that
 * contains `date`. Both the writer (logCalendarChange) and the manager-side reader build the
 * shared `${uid}_${weekId}` notification key from this, so it MUST be derived from the Vilnius
 * day — NOT date-fns startOfWeek(new Date()), which buckets by the BROWSER's local week. Two
 * devices in different timezones straddling the Monday boundary would otherwise compute
 * different week strings and the notification document would never match (silent loss).
 *
 * Pure: the Vilnius calendar day via getLithuanianDateString, then UTC calendar arithmetic to
 * step back to Monday. DST-independent and identical on every device regardless of its clock's
 * timezone. (The weekday is read from the date-only string at UTC midnight, where getUTCDay()
 * is just that calendar date's weekday: 0=Sunday … 6=Saturday.)
 *
 * @param {Date|string} [date=new Date()] - The instant whose Vilnius week is wanted.
 * @returns {string} The week's Monday as a YYYY-MM-DD string.
 */
export const getLithuanianWeekId = (date = new Date()) => {
    const todayStr = getLithuanianDateString(date);
    const [y, m, d] = todayStr.split('-').map(Number);
    const dayOfWeek = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=Sun … 6=Sat
    const daysSinceMonday = (dayOfWeek + 6) % 7; // Mon→0, Tue→1, … Sun→6
    return addDaysToDateString(todayStr, -daysSinceMonday);
};

/**
 * Returns the weekday in Lithuanian (e.g. "Pirmadienis") according to Lithuania's time.
 */
export const getLithuanianWeekday = (date = new Date()) => {
    const d = typeof date === 'string' ? new Date(date) : date;

    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Vilnius', weekday: 'long' });
    const enWeekday = formatter.format(d);
    const enToLtMap = {
        'Sunday': 'Sekmadienis',
        'Monday': 'Pirmadienis',
        'Tuesday': 'Antradienis',
        'Wednesday': 'Trečiadienis',
        'Thursday': 'Ketvirtadienis',
        'Friday': 'Penktadienis',
        'Saturday': 'Šeštadienis'
    };
    return enToLtMap[enWeekday] || 'Nežinoma';
};

/**
 * Returns a Date object for the same day at 03:00 Lithuania time.
 */
export const getLithuanian3AMCutoff = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    // 03:00 Vilnius is 01:00 UTC in winter (UTC+2) and 00:00 UTC in summer (UTC+3).
    // Read the day's offset from a noon reference (noon is never inside the DST
    // spring-forward gap) so the result is deterministic - the previous
    // step-towards-03:00 loop could oscillate on the spring-forward day, when 03:00
    // local time does not exist, and return an off-by-one-hour cutoff.
    const noonUTC = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const localNoonHour = parseInt(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Vilnius',
            hour: 'numeric',
            hour12: false
        }).format(noonUTC),
        10
    );
    const offsetHours = localNoonHour - 12; // 2 (winter) or 3 (summer)
    return new Date(Date.UTC(y, m - 1, d, 3 - offsetHours, 0, 0));
};

/**
 * Build a UTC instant (ISO string) from a Vilnius LOCAL wall-clock date + time. This is the
 * inverse of the pair getLithuanianDateString()/formatTime(): those render a stored UTC ISO as
 * the Vilnius day + clock an admin sees; this takes the day + clock the admin TYPES back and
 * returns the UTC ISO to persist. work_sessions store startTime/endTime as UTC ISO, so the
 * session editor must round-trip through here or it would silently shift every edited time by
 * the Vilnius offset.
 *
 * Vilnius is UTC+2 (winter) / UTC+3 (summer); the day's offset is read from a NOON reference
 * (noon is never inside the DST spring-forward gap) so the conversion is deterministic — the
 * same technique getLithuanian3AMCutoff uses. Returns null on malformed input.
 *
 * @param {string} dateStr - Vilnius local date, "YYYY-MM-DD".
 * @param {string} timeStr - Vilnius local time, "HH:MM" (24h).
 * @returns {string|null} UTC ISO string, or null if either part is malformed.
 */
export const vilniusWallClockToISO = (dateStr, timeStr) => {
    if (typeof dateStr !== 'string' || typeof timeStr !== 'string') return null;
    const dateMatch = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const timeMatch = timeStr.match(/^(\d{1,2}):(\d{2})$/);
    if (!dateMatch || !timeMatch) return null;
    const y = Number(dateMatch[1]);
    const mo = Number(dateMatch[2]);
    const d = Number(dateMatch[3]);
    const hh = Number(timeMatch[1]);
    const mm = Number(timeMatch[2]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
    const noonUTC = new Date(Date.UTC(y, mo - 1, d, 12, 0, 0));
    const localNoonHour = parseInt(
        new Intl.DateTimeFormat('en-GB', {
            timeZone: 'Europe/Vilnius',
            hour: 'numeric',
            hour12: false
        }).format(noonUTC),
        10
    );
    const offsetHours = localNoonHour - 12; // 2 (winter) or 3 (summer)
    return new Date(Date.UTC(y, mo - 1, d, hh - offsetHours, mm, 0)).toISOString();
};
