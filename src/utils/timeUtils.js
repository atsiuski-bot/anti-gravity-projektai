import { serverNow } from './serverClock';

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

// How far back a TRUSTED worker (canBackdateTime) may self-log a missed session, in whole
// Vilnius calendar days counted from today (today − N). The window caps the audit exposure of an
// approval-free, worker-authored time entry: it covers the realistic "forgot to start the timer
// yesterday / over the weekend" case without letting someone fabricate weeks-old payable time.
// The worker UI (BackdateTimeModal date range) and the action-layer guard (validateBackdateWindow)
// both read this one constant, so the picker and the server-of-truth check can never disagree.
export const MAX_BACKDATE_DAYS = 7;

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

// The longest UNTRACKED gap that still reads as one plausible stretch of unrecorded work.
//
// This is NOT the same question as MAX_SESSION_MINUTES. That one bounds a session the worker
// actually started and stopped; this one bounds an interval NOBODY observed — the phone went quiet
// and we are guessing, on the worker's behalf, that they kept working through it. The guess is
// auto-credited (opt-OUT), so its bound decides how much unworked time the app will pay for by
// default when a timer is simply forgotten.
//
// Both engines used MAX_SESSION_MINUTES here, which made "asleep" indistinguishable from "working
// with the phone pocketed": a timer left running overnight was recovered the next morning and
// credited 623 minutes — 10.4 hours of pay for a night's sleep (observed in production 2026-07-27).
// The real distribution says the bound was never close to right: of 78 auto-credited gaps ever
// written, the median is 27 minutes and the second-largest is 3.6 hours. 4h sits above every
// genuine gap ever observed while refusing a night outright.
export const MAX_UNTRACKED_GAP_MINUTES = 4 * 60;

// --- Timer heartbeat (crash/reload-survivable running timer) ---------------------------------
// A live task timer is just a stored start instant; the elapsed is `now − timerStartedAt`. To
// tell a brief reload-while-working apart from a truly abandoned timer on the next app load, a
// running timer stamps `timerLastHeartbeat` on its task doc this often — a per-minute "still
// alive" proof. It is a single-field, last-write-wins update (no activeSession touch, so no user
// lock), and offline it queues in the local cache stamped with the client clock, so a
// no-signal-but-app-alive stretch is preserved and replays on reconnect.
export const TIMER_HEARTBEAT_INTERVAL_MS = 60 * 1000;

// On the next app load, orphan recovery reads the last beat as the "last proof of work" instant.
// If the unproven tail (load time − last beat) is within this window, the reload is treated as a
// brief interruption WHILE WORKING: the timer is credited up to the RELOAD INSTANT (the bounded
// tail is real continuous work by a worker who is demonstrably back in the app) and RE-ANCHORED to
// keep running, so the worker never has to restart and nothing leaks per reload. A larger tail
// means the app was genuinely closed: credit stops at the last beat and the timer is paused. Must
// be comfortably larger than the heartbeat interval so a single skipped beat (slow field
// connection) never mis-classifies live work as abandonment.
export const TIMER_HEARTBEAT_CONTINUE_MS = 3 * 60 * 1000;

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
                    // Server-anchored, like the stamp this is measured against: the running total on
                    // screen and the minutes eventually credited must come from ONE clock, or a
                    // skewed device would display an elapsed time its own stop then contradicts.
                    const now = serverNow();
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

// A task whose accumulated timer exceeds its OWN estimate by this factor is "implausible vs plan"
// — the forgot-to-stop / runaway-timer signature. Expressed as a RATIO, not absolute minutes, so a
// legitimate multi-day job with a large estimate (e.g. 70h) is never flagged: the data showed 19 of
// 22 >10h timers were genuine long jobs, and only the ratio separates those from real runaways.
export const TASK_TIMER_ANOMALY_RATIO = 3;
// Absolute floor so a tiny task tripping the ratio (15min estimate, 50min run) isn't nagged; only
// flag once the accumulated total is itself non-trivial.
const TASK_TIMER_ANOMALY_FLOOR_MINUTES = 60;

// True when a task's accumulated time is implausible enough to warrant a manager's eye (a read-only
// "⚠ Patikrinti" affordance), WITHOUT mutating anything. Two signatures: (a) a real estimate that
// the total overruns by >= TASK_TIMER_ANOMALY_RATIO×, or (b) NO usable estimate but a total past
// the single-shift ceiling (the abandoned-timer-with-no-bound case, e.g. the 145h photo task).
// Deleted/non-time tasks never flag. Ratio-based by design so legitimate large-estimate jobs pass.
export const isTaskTimerAnomalous = (task) => {
    if (!task || typeof task !== 'object') return false;
    if (task.isDeleted || task.status === 'deleted') return false;

    const total = calculateCurrentTotalMinutes(task);
    if (!Number.isFinite(total) || total < TASK_TIMER_ANOMALY_FLOOR_MINUTES) return false;

    // Prefer the persisted numeric estimate; fall back to parsing the legacy free-text string so
    // rows written before estimatedTimeMinutes existed are still evaluated.
    const est = (Number.isFinite(task.estimatedTimeMinutes) && task.estimatedTimeMinutes > 0)
        ? task.estimatedTimeMinutes
        : parseTimeStringToMinutes(task.estimatedTime || '');

    if (est > 0) return total >= est * TASK_TIMER_ANOMALY_RATIO;
    return isImplausibleSessionMinutes(total);
};

/**
 * Returns a Date object representing the current moment,
 * but ensures operations can be performed in Lithuanian context.
 *
 * Anchored to SERVER time, not the device clock (serverClock.js). This is the app's single answer
 * to "what time is it", and it feeds the legacy session closers' start/end moments — so a machine
 * whose clock runs fast no longer writes a session that ends in the server's future, which
 * firestore.rules refuses outright. On a device inside the trust band the offset is exactly zero,
 * so this is the same `new Date()` it has always been.
 */
export const getLithuanianNow = () => {
    return serverNow();
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
 * The value `breakState.dailyAccumulatedMinutes` should be built on TODAY — 0 once the day has
 * rolled over, otherwise the stored total.
 *
 * WHY THIS EXISTS
 * The field is a DAY total, but nothing ever wrote it back to zero: the rollover lived only in
 * useTimerState, which sets the DISPLAYED value to 0 when `lastDate` is older than today and never
 * persists that. Every writer meanwhile carried the stored number forward verbatim — and starting a
 * break also stamps `lastDate` to today. So the first break of a new day re-dated yesterday's total
 * as today's, after which the read-time reset no longer fired and the counter simply grew, day over
 * day, without bound. A live account reached 619 minutes of "today's break" against roughly 50
 * seconds actually taken.
 *
 * Deriving the base here moves the rollover to where the value is WRITTEN, so the stored number is
 * correct on its own and no longer depends on a reader to reinterpret it. Every break write site —
 * legacy (sessionActions) and canonical (timerTransitionPlan) — must go through this.
 *
 * @param {Object|null} breakState - the user's stored breakState.
 * @param {Date|string} [at] - the instant the write is credited to; a break is bucketed by the WORK
 *                             day it ENDS in, matching the break_sessions row's own `date`.
 * @returns {number} minutes to build on — 0 on a new day, or a stale/unusable stored value.
 */
export const breakDayBaseMinutes = (breakState, at = new Date()) => {
    const stored = Number(breakState?.dailyAccumulatedMinutes || 0);
    // A negative or unparseable total is corruption, not history — never carry it forward.
    if (!Number.isFinite(stored) || stored <= 0) return 0;
    // The WORK day, not the calendar day: `lastDate` is written by the same writers that stamp the
    // break_sessions row, and those file by work day. Comparing against the calendar day here would
    // zero the running total at midnight while the row it mirrors still lands in the previous day —
    // a night-shift break would restart the counter and under-report the day's break total.
    return breakState?.lastDate === getWorkDayString(at) ? stored : 0;
};

/**
 * Adds (or subtracts) whole calendar days to a YYYY-MM-DD string and returns a YYYY-MM-DD
 * string. Pure UTC calendar arithmetic, so it is DST-independent and never lands on a
 * non-existent local hour. Use this to derive a day-window's end as the NEXT day's work-day
 * cutoff (getWorkDayCutoff of dateStr+1) instead of "cutoff + 24h": across a DST
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
 * Buckets a stored deadline to its Vilnius calendar day and describes it RELATIVE to today,
 * so a card can say "Šiandien" / "Rytoj" / "Vėluoja 2 d." instead of a bare date the reader
 * has to mentally diff against today. Returns { label, tone } where `tone` is a feedback key
 * the caller maps to a colour — but the label is always self-describing, so colour is never
 * the sole signal (WCAG 1.4.1). Both the card's deadline span and TaskDetailModal's deadline
 * fact read this one helper, so the two surfaces can never disagree.
 *
 * Day bucketing is done on the Vilnius calendar-day STRINGS (getLithuanianDateString +
 * addDaysToDateString), then compared by their natural YYYY-MM-DD order — DST-independent,
 * and identical on every device regardless of its clock's timezone. The offset (today minus
 * deadline) is a whole-day count derived from those calendar days, never a wall-clock delta.
 *
 * Tones: today → 'warning' (due now), overdue → 'danger' (past), tomorrow/future → 'neutral'
 * (no urgency colour). A future deadline still gets the same zero-padded "MM.DD d." text the
 * modal used before, so nothing regresses for dates beyond tomorrow.
 *
 * @param {string} deadlineStr - The stored deadline (YYYY-MM-DD or any Date-parseable string).
 * @param {Date}   [now=new Date()] - Reference instant (injectable for tests).
 * @returns {{ label: string, tone: 'neutral'|'warning'|'danger' }|null} null when there is no deadline.
 */
export const relativeDeadline = (deadlineStr, now = new Date()) => {
    if (!deadlineStr) return null;

    const parsed = new Date(deadlineStr);
    if (Number.isNaN(parsed.getTime())) {
        // Unparseable: show it verbatim rather than dropping the user's value.
        return { label: String(deadlineStr), tone: 'neutral' };
    }

    const deadlineDay = getLithuanianDateString(parsed); // YYYY-MM-DD, Vilnius
    const todayDay = getLithuanianDateString(now);

    // Whole-day offset via calendar-string stepping: count days from today until we reach (or
    // pass) the deadline day. Bounded to a small window — beyond it the absolute date is shown
    // anyway, so there is no need to keep stepping. Negative => overdue, positive => upcoming.
    let offset = 0;
    if (deadlineDay > todayDay) {
        // Upcoming: step forward from today until we hit the deadline day (cap at 2 — we only
        // special-case "tomorrow").
        let cursor = todayDay;
        while (cursor < deadlineDay && offset < 2) {
            cursor = addDaysToDateString(cursor, 1);
            offset += 1;
        }
    } else if (deadlineDay < todayDay) {
        // Overdue: step backward from today until we reach the deadline day (cap the count we
        // surface at 99 — "Vėluoja 99+ d." would be the practical ceiling, but the absolute
        // date below still tells the exact day).
        let cursor = todayDay;
        while (cursor > deadlineDay && offset > -100) {
            cursor = addDaysToDateString(cursor, -1);
            offset -= 1;
        }
    }

    if (offset === 0) return { label: 'Šiandien', tone: 'warning' };
    if (offset === 1) return { label: 'Rytoj', tone: 'neutral' };
    if (offset < 0) return { label: `Vėluoja ${-offset} d.`, tone: 'danger' };

    // 2+ days out — no urgency colour; show the absolute day (zero-padded "MM.DD d.").
    const month = deadlineDay.slice(5, 7);
    const day = deadlineDay.slice(8, 10);
    return { label: `${month}.${day} d.`, tone: 'neutral' };
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

// The Vilnius wall-clock hour at which one WORK day ends and the next begins. Deliberately not
// midnight: a shift that runs past 00:00 is the same working day to the person doing it, and a task
// finished at 01:00 dropping out of "today" is a lie the worker has to argue with. Set to 05:00 so
// a genuine night shift ending before dawn still belongs to the day it started on.
//
// Changing this ONE number moves every day window that governs what a worker SEES *and* where their
// minutes are FILED: which finished tasks linger in the personal and team lists, the Dienos
// statistika 05:00→05:00 span, when archiveOldTasks sweeps, and — via getWorkDayString — the `date`
// every work_sessions / break_sessions row is stamped with. One boundary, one answer: work done at
// 01:00 is filed under the day it started, on screen and in the ledger alike.
//
// Rows written BEFORE this became the filing rule still carry their pure calendar day; nothing here
// rewrites history. Only the 00:00→05:00 band can differ, and only for rows already in Firestore.
export const WORK_DAY_START_HOUR = 5;

/**
 * Returns a Date object for the WORK-DAY boundary (see WORK_DAY_START_HOUR) on the given
 * Vilnius calendar day.
 */
export const getWorkDayCutoff = (dateStr) => {
    const [y, m, d] = dateStr.split('-').map(Number);
    // Vilnius is UTC+2 in winter and UTC+3 in summer, so the boundary's UTC hour shifts with DST.
    // Read the day's offset from a noon reference (noon is never inside the DST
    // spring-forward gap) so the result is deterministic - the previous
    // step-towards-the-boundary loop could oscillate on the spring-forward day, when the
    // local hour may not exist, and return an off-by-one-hour cutoff.
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
    return new Date(Date.UTC(y, m - 1, d, WORK_DAY_START_HOUR - offsetHours, 0, 0));
};

/**
 * The start instant of the CURRENT "work day" — {@link WORK_DAY_START_HOUR}:00 Europe/Vilnius.
 * Before that hour the work day still belongs to the PREVIOUS calendar day, so the cutoff steps
 * back one day; without that, a task finished just after midnight would sit before "today's"
 * (still-future) boundary and wrongly drop out of every day-windowed list. The shared team scope
 * (scopeActiveTasks) and both personal lists (scopePersonalDayWindow) read this one helper so
 * their "today" boundary can never disagree.
 *
 * @param {Date} [now=getLithuanianNow()] - Reference instant (injectable for tests).
 * @returns {Date} The current work day's Vilnius cutoff as a Date.
 */
export const getCurrentWorkDayCutoff = (now = getLithuanianNow()) => {
    let cutoffDate = getLithuanianDateString(now);
    // If it's before today's Vilnius cutoff, the work day started at the boundary on the previous
    // calendar day. Compare the instant against the DST-safe Vilnius cutoff (the same technique
    // automationUtils uses) rather than now.getHours() — the latter reads the DEVICE-local
    // hour, which disagrees with the Vilnius date above on off-Vilnius devices and flips the
    // work day at the wrong moment for several hours each night.
    if (now < getWorkDayCutoff(cutoffDate)) {
        cutoffDate = addDaysToDateString(cutoffDate, -1);
    }
    return getWorkDayCutoff(cutoffDate);
};

/**
 * WHICH WORK DAY does an instant belong to, as 'YYYY-MM-DD'.
 *
 * This is the app's filing rule for work TIME, and the counterpart of getLithuanianDateString: that
 * one answers "what is the calendar date", this one answers "whose day's work is this". They differ
 * only in the 00:00→{@link WORK_DAY_START_HOUR}:00 band, where this returns the PREVIOUS day —
 * because a shift that runs past midnight is one shift to the person doing it, and splitting it in
 * two is a lie the worker has to argue with at payroll.
 *
 * Every writer that stamps a `date` on a work_sessions / break_sessions row goes through here, and
 * so does every reader that buckets a time record into a day. They must agree: the day windows are
 * queried by that stored field, so a writer using the calendar day would file a 01:00 session into a
 * day the reader's 05:00 window has not opened yet — the row exists and is credited, but appears on
 * no screen the worker looks at.
 *
 * NOT for: calendar dates a human picks or reads (deadlines, planned shifts, date pickers, week
 * ids), and never for anchoring a typed wall-clock time to a day — vilniusWallClockToISO needs the
 * true calendar day or it builds an instant 24h off.
 *
 * MIRROR of functions/workDay.js currentWorkDay(); locked by src/__tests__/firebaseConsistency.test.js.
 *
 * @param {Date|string} [at=getLithuanianNow()] - the instant to file.
 * @returns {string} the work day as 'YYYY-MM-DD'.
 */
export const getWorkDayString = (at = getLithuanianNow()) => {
    const instant = typeof at === 'string' ? new Date(at) : at;
    return getLithuanianDateString(getCurrentWorkDayCutoff(instant));
};

/**
 * May an untracked gap [from → to] be AUTO-credited as work the timer failed to record?
 *
 * The gap is time nobody observed: the heartbeat stopped, and crediting it is the app guessing that
 * the worker kept working with the phone pocketed. That guess is opt-OUT, so it must only be made
 * where it is overwhelmingly likely to be right. Two things disqualify it, and they are different
 * questions — a gap can fail either one:
 *
 *   1. MAGNITUDE — longer than {@link MAX_UNTRACKED_GAP_MINUTES} is beyond any unrecorded stretch
 *      ever actually observed, so it is a forgotten timer, not silent work.
 *   2. CONTINUITY — a gap that crosses the {@link WORK_DAY_START_HOUR} boundary is not one stretch
 *      at all; it spans two work days. A 4-hour gap from 03:00 to 07:00 passes the magnitude test
 *      and is still obviously not one shift.
 *
 * Refusing is NOT the same as discarding: both callers fall back to the opt-IN claim offer, so a
 * worker who really did work through a long gap can still claim it deliberately. What changes is
 * the DEFAULT — from "pay for it unless the worker objects" to "ask before paying".
 *
 * Pure and exported so the two engines (legacy resolveUntrackedGap, canonical planTaskRecover) share
 * one answer; they are deliberate mirrors and a divergence here would credit differently per worker.
 *
 * @param {number|Date} from - start instant of the gap.
 * @param {number|Date} to - end instant of the gap.
 * @returns {boolean} true when the gap may be auto-credited.
 */
export const isCreditableUntrackedGap = (from, to) => {
    const start = from instanceof Date ? from : new Date(from);
    const end = to instanceof Date ? to : new Date(to);
    const minutes = (end - start) / 60000;
    if (!Number.isFinite(minutes)) return false;
    if (minutes < MIN_LOGGED_SESSION_MINUTES) return false;   // noise, not work
    if (minutes > MAX_UNTRACKED_GAP_MINUTES) return false;    // (1) magnitude
    // (2) continuity — same work day on both ends, DST-safe via the shared Vilnius cutoff.
    return getCurrentWorkDayCutoff(start).getTime() === getCurrentWorkDayCutoff(end).getTime();
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
 * same technique getWorkDayCutoff uses. Returns null on malformed input.
 *
 * @param {string} dateStr - Vilnius local date, "YYYY-MM-DD".
 * @param {string} timeStr - Vilnius local time, "HH:MM" (24h).
 * @returns {string|null} UTC ISO string, or null if either part is malformed.
 */
// A timeline row that may be folded into the stretch around it: a real, finished timer/ledger row
// for a known task. Everything excluded here is excluded because a human must still see it on its
// own — a LIVE row (it is still growing), an admin-EDITED row (SessionEditedBadge describes exactly
// ONE stored document), and a legacy delta adjustment (a bare number, with no real interval to abut).
const isFoldableSession = (item) =>
    !!item
    && item.type === 'session'
    && !item.isActive
    && !item.edited
    && !item.isManualAdjustment
    && !!item.taskId;

// Does this row continue the stretch built so far? Same task, same worker, same work day, and it
// opens where the stretch has reached (within the seam tolerance, which mirrors injectInactiveGaps'
// own "a hole this small is not a hole" threshold — a seam we refuse to draw a Neaktyvus band for
// must not split the block either).
//
// `closedIso` is the stretch's RUNNING MAXIMUM end, not the last segment's — the same merge-
// intervals discipline injectInactiveGaps uses, and for the same reason. Recovery mints a
// zero-length proven row whenever the run's only heartbeat sits on its start instant, and that row
// sorts INSIDE the block around it. Comparing against the previous row alone made such a contained
// row a wall: the stretch ended there and the rest of the very same continuous work opened a second
// block (production, Simona 2026-08-31 — "11:53–12:04", then a bare "11:53–11:53 0m", then
// "12:04–12:18" as a third block). Measured against the running max, the contained row is absorbed
// (its seam is negative, i.e. it opens before the stretch has ended) and the stretch survives it.
const continuesStretch = (prev, closedIso, next, maxSeamMinutes) => {
    if (!isFoldableSession(prev) || !isFoldableSession(next)) return false;
    if (prev.taskId !== next.taskId) return false;
    if ((prev.userId || null) !== (next.userId || null)) return false;
    // Never fold across the work-day boundary: the day is the filing unit every total groups by.
    if ((prev.date || null) !== (next.date || null)) return false;
    const closed = Date.parse(closedIso);
    const opened = Date.parse(next.startTime);
    const nextClosed = Date.parse(next.endTime);
    if (!Number.isFinite(closed) || !Number.isFinite(opened) || !Number.isFinite(nextClosed)) return false;
    // Contained in what the stretch already covers — absorbed, never a seam.
    if (nextClosed <= closed) return true;
    const seamMinutes = (opened - closed) / 60000;
    return seamMinutes >= 0 && seamMinutes <= maxSeamMinutes;
};

// The stretch reaches as far as its FURTHEST segment end, which a contained row does not move.
const stretchEnd = (segments) => segments.reduce(
    (latest, s) => (Date.parse(s.endTime) > Date.parse(latest) ? s.endTime : latest),
    segments[0].endTime,
);

const foldStretch = (segments) => {
    const folded = {
        ...segments[0],
        endTime: stretchEnd(segments),
        duration: segments.reduce((sum, s) => sum + (Number(s.duration) || 0), 0),
        segments,
    };
    // The raw stored minutes belong to ONE document; carrying the first segment's copy onto a row
    // that spans several would hand the session editor a false "original" to snapshot.
    delete folded.durationMinutes;
    return folded;
};

/**
 * Fold the consecutive ledger rows of ONE uninterrupted stretch of work back into a single
 * timeline row.
 *
 * WHY a stretch nobody paused arrives here in pieces: the timer engine models every interruption
 * as CLOSE-AND-REOPEN, and boot recovery (ADR 0027) does the same on every app re-open — it closes
 * the run so the worked minutes are filed, then re-anchors a fresh run so the worker never has to
 * press start again. A phone that discards the backgrounded PWA therefore mints a new ledger row on
 * every return to the app, plus a credited `isRecoveredGap` row for the stretch the foreground-only
 * heartbeat could not witness. The ledger is CORRECT — the segments tile the interval exactly and no
 * minute is credited twice — but the timeline read as a series of pauses that never happened.
 *
 * So this fold is presentation-only and deliberately narrow (see continuesStretch): it re-joins what
 * the app itself split, and never what a person did. The merged row keeps the FIRST segment's
 * identity and carries `segments` (the raw rows, in order) so the per-row editors stay reachable
 * behind a disclosure — a folded row is never itself editable, because it is several documents.
 *
 * @param {Array} sortedItems - timeline items, ascending by startTime.
 * @param {number} [maxSeamMinutes=1] - largest seam between two rows still treated as continuous.
 * @returns {Array} the items with each continuous stretch folded into one `segments`-carrying row.
 */
export const mergeContinuousSessions = (sortedItems, maxSeamMinutes = 1) => {
    if (!Array.isArray(sortedItems) || sortedItems.length < 2) return sortedItems || [];

    const out = [];
    let stretch = null; // raw segments of the stretch currently being folded

    const flush = () => {
        if (!stretch) return;
        out.push(stretch.length === 1 ? stretch[0] : foldStretch(stretch));
        stretch = null;
    };

    for (const item of sortedItems) {
        if (stretch && continuesStretch(stretch[stretch.length - 1], stretchEnd(stretch), item, maxSeamMinutes)) {
            stretch.push(item);
            continue;
        }
        flush();
        if (isFoldableSession(item)) {
            stretch = [item];
        } else {
            out.push(item);
        }
    }
    flush();

    return out;
};

/**
 * Drop the ledger rows that credit NOTHING from a human-facing timeline.
 *
 * Why they exist at all: the rules' `taskCloseLedgerBound()` requires `work_sessions/sess_run_{runId}`
 * to be written in the SAME batch as any task-run close — that invariant is what makes credited time
 * impossible to lose, so every close files a row even when the run was empty. Two ordinary events
 * produce an empty one: recovery closing a run whose only heartbeat sits on its start instant, and a
 * worker stopping a run seconds after boot recovery re-anchored it (ADR 0027). Both render as a bare
 * "0m" line, and a day full of them reads as a shift chopped into scraps of work nobody did.
 *
 * So the row stays in Firestore — audits, integrity scans and the rules invariant all keep what they
 * need — and only the timeline stops showing what rounds to nothing. Deliberately narrow: a folded
 * block, a live row, an admin-edited row and any human-authored manual row are never dropped, however
 * short, because each of those is something a person must still be able to see and act on. Totals are
 * unaffected: every surface sums the sessions themselves, not these rows.
 *
 * @param {Array} items - timeline items (fold them first, so a contained row is already absorbed).
 * @returns {Array} the items without the uncredited engine rows.
 */
export const dropUncreditedSessionRows = (items) => {
    if (!Array.isArray(items)) return items || [];
    return items.filter((item) => !(
        item
        && item.type === 'session'
        && !item.segments
        && !item.isActive
        && !item.edited
        && !item.isManualSession
        && !item.isManualAdjustment
        && Math.round(Number(item.duration) || 0) === 0
    ));
};

/**
 * Inject "Neaktyvus" (inactive) gap markers between the activity items of a single-user
 * timeline. A gap is the wall-clock hole where NO timer was running — it is derived here,
 * never stored.
 *
 * The items MUST already be sorted ascending by startTime. Crucially, the gap is measured
 * from the RUNNING MAXIMUM end time seen so far — not merely the previous item's end. This
 * is the classic merge-intervals guard: when a short session (e.g. a manual/backdated entry)
 * sits INSIDE a longer session, comparing only against the immediately-preceding item would
 * invent a phantom "Neaktyvus" band for time the longer session already covered. Tracking the
 * running max end collapses overlapping/nested items so only genuine holes surface. (Reports.jsx
 * already does this; this helper is the shared, tested source of that truth.)
 *
 * @param {Array<{id:string,startTime:string,endTime:string}>} sortedItems - ascending by startTime.
 * @param {number} [minGapMinutes=1] - only holes STRICTLY greater than this become a marker.
 * @returns {Array} the items with `{ type:'inactive', title:'Neaktyvus', ... }` markers spliced in.
 */
export const injectInactiveGaps = (sortedItems, minGapMinutes = 1) => {
    if (!Array.isArray(sortedItems) || sortedItems.length === 0) return sortedItems || [];

    const withGaps = [];
    let runningEnd = null; // latest endTime seen so far, as a Date

    for (let i = 0; i < sortedItems.length; i++) {
        const current = sortedItems[i];
        const start = new Date(current.startTime);

        if (runningEnd && Number.isFinite(start.getTime())) {
            const gapMinutes = Math.floor((start.getTime() - runningEnd.getTime()) / 60000);
            if (gapMinutes > minGapMinutes) {
                withGaps.push({
                    id: `gap-${current.id}`,
                    type: 'inactive',
                    startTime: runningEnd.toISOString(),
                    endTime: current.startTime,
                    title: 'Neaktyvus',
                    duration: gapMinutes,
                });
            }
        }

        withGaps.push(current);

        const end = new Date(current.endTime);
        if (Number.isFinite(end.getTime()) && (!runningEnd || end > runningEnd)) {
            runningEnd = end;
        }
    }

    return withGaps;
};

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
