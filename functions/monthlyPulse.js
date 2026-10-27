/**
 * The monthly workshop PULSE — the aggregate behind the founder's "Dirbtuvių pulsas" report.
 *
 * WHY THIS EXISTS (ADR 0034). The report used to be collected outside WORKZ by a script that read
 * raw work_sessions / break_sessions / tasks / archived_tasks over the project OWNER's Firebase CLI
 * login on the founder's PC — a full read/write/deploy credential held by an unattended monthly job.
 * The arithmetic now lives here: index.js's monthlyPulse HTTPS function reads the same rows with the
 * admin SDK and answers with only these computed numbers, so the reader holds one narrow token
 * instead of any Google credential.
 *
 * PARITY. Every rule below is a faithful port of that collector — the same 4-month window, session
 * classification, >12 h "big day" flag, estimate-accuracy ratios and fixed-offset Vilnius hour — so
 * the first live month can be compared number for number before the old path is switched off.
 * Improve a rule only after that comparison has passed.
 *
 * Pure apart from Node's built-in crypto (token compare), so `node functions/monthlyPulse.test.cjs`
 * runs with no Firestore and no emulator. index.js does the I/O.
 */

const crypto = require('crypto');

const MONTH_RE = /^\d{4}-\d{2}$/;
// Firebase Auth uids are 28 alphanumerics; the bounds only reject junk, they do not identify anyone.
const UID_RE = /^[A-Za-z0-9]{10,64}$/;
const MAX_USERS = 25;
// A token shorter than this is a misconfiguration, not a secret — refuse rather than accept it.
const MIN_TOKEN_LENGTH = 32;
// A day longer than this many credited minutes is listed for a human to sanity-check.
const BIG_DAY_MINUTES = 720;

function ym(year, monthIndex) {
    const d = new Date(Date.UTC(year, monthIndex, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The report window for a target month 'YYYY-MM': the 4 calendar months ending with it. Returns null
 * for anything that is not a real month. All math is UTC on calendar strings, so the answer does not
 * depend on the server's time zone.
 */
function pulseWindow(target) {
    if (typeof target !== 'string' || !MONTH_RE.test(target)) return null;
    const year = Number(target.slice(0, 4));
    const month = Number(target.slice(5, 7)) - 1;
    if (month < 0 || month > 11) return null;
    const months = [3, 2, 1, 0].map((k) => ym(year, month - k));
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    // archived_tasks server-side prefilter: a bit before the window start. A task completed inside
    // the window is archived after it, so the slack only has to be "before FROM", not exact.
    const archivedFrom = new Date(Date.UTC(year, month - 3, 1));
    archivedFrom.setUTCDate(archivedFrom.getUTCDate() - 16);
    return {
        target,
        months,
        from: `${months[0]}-01`,
        to: `${target}-${String(lastDay).padStart(2, '0')}`,
        archivedFrom: archivedFrom.toISOString().slice(0, 10),
        // An open task created before the target month started counts as stale.
        staleCut: `${target}-01`,
    };
}

/** Timing-safe check of an `Authorization: Bearer <token>` header against the configured token. */
function checkBearer(header, expected) {
    if (typeof expected !== 'string' || expected.length < MIN_TOKEN_LENGTH) return false;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    // Hash both sides so the comparison is constant-length and leaks neither value nor length.
    const a = crypto.createHash('sha256').update(header.slice(7)).digest();
    const b = crypto.createHash('sha256').update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

/** Validate a request body `{ month: 'YYYY-MM', userIds: string[] }`. */
function parsePulseRequest(body) {
    if (!body || typeof body !== 'object') return { ok: false, error: 'bad_body' };
    if (!pulseWindow(body.month)) return { ok: false, error: 'bad_month' };
    const ids = body.userIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_USERS) return { ok: false, error: 'bad_user_ids' };
    if (!ids.every((id) => typeof id === 'string' && UID_RE.test(id))) return { ok: false, error: 'bad_user_ids' };
    return { ok: true, month: body.month, userIds: [...new Set(ids)] };
}

// Firestore Timestamps arrive from the admin SDK as objects; the WORKZ write paths store ISO strings,
// but a stray Timestamp must bucket by month like the string would instead of silently dropping out.
function iso(v) {
    if (v && typeof v.toDate === 'function') return v.toDate().toISOString();
    return v;
}

// Europe/Vilnius as a fixed offset by month — EEST (UTC+3) April–October, EET (UTC+2) otherwise.
// Approximate around the DST switch days, kept for parity with the collector (see header).
function localHour(value, dateStr) {
    const s = iso(value);
    if (!s) return null;
    const d = new Date(s);
    if (isNaN(d)) return null;
    const m = Number(String(dateStr || s).slice(5, 7));
    const off = (m >= 4 && m <= 10) ? 3 : 2;
    return (d.getUTCHours() + off) % 24 + d.getUTCMinutes() / 60;
}

function monthOf(value) { return String(iso(value) || '').slice(0, 7); }

function median(arr) {
    if (!arr.length) return null;
    const a = [...arr].sort((x, y) => x - y);
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const h1 = (min) => (min == null ? null : Math.round(min / 6) / 10); // minutes -> hours, 1 decimal

/** Per-month time figures for one person from their work_sessions and break_sessions rows. */
function summariseSessions(sessions, breaks, win) {
    const acc = {};
    for (const m of win.months) {
        acc[m] = {
            totalH: 0, taskH: 0, quickH: 0, callH: 0, systemH: 0, otherH: 0,
            sessions: 0, days: new Set(), dayTotals: {}, starts: {},
            breakH: 0, breakCount: 0, manualMin: 0,
        };
    }

    for (const d of sessions) {
        const M = acc[monthOf(d.date)];
        if (!M || d.isDeleted === true) continue;
        const min = Number(d.durationMinutes) || 0;
        if (d.isManualSession === true || d.isRecoveredGap === true || d.isBackdated === true) M.manualMin += min;
        M.totalH += min;
        M.sessions += 1;
        M.days.add(d.date);
        M.dayTotals[d.date] = (M.dayTotals[d.date] || 0) + min;
        const sh = localHour(d.startTime, d.date);
        if (sh != null && (!(d.date in M.starts) || sh < M.starts[d.date])) M.starts[d.date] = sh;
        const tid = String(d.taskId || '');
        if (d.isQuickWork === true || tid.startsWith('quick_')) M.quickH += min;
        else if (d.isCall === true || tid.startsWith('call_')) M.callH += min;
        else if (d.isSystemTask === true) M.systemH += min;
        else if (tid.startsWith('manual_')) M.otherH += min;
        else M.taskH += min;
    }
    for (const d of breaks) {
        const M = acc[monthOf(d.date)];
        if (!M || d.isDeleted === true) continue;
        M.breakH += Number(d.durationMinutes) || 0;
        M.breakCount += 1;
    }

    const out = {};
    for (const m of win.months) {
        const M = acc[m];
        const dayVals = Object.values(M.dayTotals);
        out[m] = {
            totalH: h1(M.totalH), taskH: h1(M.taskH), quickH: h1(M.quickH),
            callH: h1(M.callH), systemH: h1(M.systemH), otherH: h1(M.otherH),
            sessions: M.sessions, workDays: M.days.size,
            avgDayH: dayVals.length ? h1(M.totalH / dayVals.length) : null,
            medianDayH: h1(median(dayVals)),
            maxDayH: dayVals.length ? h1(Math.max(...dayVals)) : null,
            medianStart: r1(median(Object.values(M.starts))),
            manualH: h1(M.manualMin),
            bigDays: Object.entries(M.dayTotals).filter(([, v]) => v > BIG_DAY_MINUTES)
                .map(([k, v]) => `${k}:${Math.round(v / 6) / 10}h`),
            breakH: h1(M.breakH), breakCount: M.breakCount,
        };
    }
    return out;
}

/**
 * Task throughput for one person from their archived + active task rows. `creators` counts, per
 * month, who authored the tasks completed — by raw createdBy id; the reader maps ids to names, so no
 * name list lives in this public repository.
 */
function summariseTasks(tasks, win) {
    const tm = {};
    const creators = {};
    for (const m of win.months) tm[m] = { done: 0, est: [], over: 0, underEst: 0, extended: 0 };
    let openNow = 0;
    let waitingAccept = 0;
    const staleOpen = [];

    for (const t of tasks) {
        const doneAt = iso(t.completedAt) || null;
        const m = doneAt ? monthOf(doneAt) : null;
        const actual = (Number(t.timerMinutes) || 0) + (Number(t.manualMinutes) || 0);
        const est = Number(t.estimatedTimeMinutes) || null;
        if (doneAt && tm[m]) {
            tm[m].done += 1;
            if (est && actual > 0) {
                tm[m].est.push({ est, actual, title: String(t.title || '').slice(0, 40) });
                if (actual > est * 1.25) tm[m].over += 1;
                if (actual < est * 0.5) tm[m].underEst += 1;
            }
            if ((t.timeExtensions || []).length) tm[m].extended += 1;
            const c = t.createdBy || '?';
            creators[m] = creators[m] || {};
            creators[m][c] = (creators[m][c] || 0) + 1;
        }
        const createdAt = iso(t.createdAt);
        if (!doneAt && !t.archivedAt && t.status !== 'confirmed' && t.status !== 'completed') {
            openNow += 1;
            if (createdAt && createdAt < win.staleCut) {
                staleOpen.push({ title: String(t.title || '').slice(0, 45), created: String(createdAt).slice(0, 10), deadline: t.deadline || '' });
            }
        }
        if (t.status === 'completed' && !t.confirmedAt) waitingAccept += 1;
    }

    const byMonth = {};
    for (const m of win.months) {
        const e = tm[m].est;
        const ratios = e.map((x) => x.actual / x.est);
        byMonth[m] = {
            done: tm[m].done, withEst: e.length,
            medianAccuracy: r1(median(ratios)),
            overruns25: tm[m].over, wayUnder: tm[m].underEst, extended: tm[m].extended,
            worst: e.sort((a, b) => (b.actual / b.est) - (a.actual / a.est)).slice(0, 2)
                .map((x) => `${x.title} (${Math.round(x.est)}m→${Math.round(x.actual)}m)`),
        };
    }
    staleOpen.sort((a, b) => (a.created < b.created ? -1 : 1));
    return { byMonth, openNow, waitingAccept, staleOpen: staleOpen.slice(0, 5), creators };
}

/**
 * The response body: `perUser` maps uid -> { sessions, breaks, tasks } raw rows. Output is keyed by
 * uid; `tasksByCreator` merges every requested person's completed-task authorship per month.
 */
function buildPulse(win, perUser, generatedAt) {
    const out = {
        window: { months: win.months, from: win.from, to: win.to, generatedAt },
        users: {},
        tasksByCreator: {},
    };
    for (const [uid, rows] of Object.entries(perUser)) {
        const { creators, ...tasks } = summariseTasks(rows.tasks, win);
        out.users[uid] = { months: summariseSessions(rows.sessions, rows.breaks, win), tasks };
        for (const [m, byCreator] of Object.entries(creators)) {
            out.tasksByCreator[m] = out.tasksByCreator[m] || {};
            for (const [c, n] of Object.entries(byCreator)) out.tasksByCreator[m][c] = (out.tasksByCreator[m][c] || 0) + n;
        }
    }
    return out;
}

module.exports = {
    MAX_USERS,
    MIN_TOKEN_LENGTH,
    pulseWindow,
    checkBearer,
    parsePulseRequest,
    localHour,
    summariseSessions,
    summariseTasks,
    buildPulse,
};
