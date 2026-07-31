import { collection, addDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';

/**
 * Durable error logging — the "log of the breakage" the app must always leave behind.
 *
 * Two sinks, both best-effort and both fully isolated so the logger itself can NEVER
 * throw (a throwing error-logger would mask the very crash it is trying to record):
 *   1. localStorage ring buffer — survives the reload that the crash screen offers,
 *      so a field worker can reopen the app and the trace is still there.
 *   2. Firestore `error_logs` collection — lets a manager/admin read failures remotely
 *      without the worker having to copy-paste anything.
 *
 * React error boundaries only catch render/lifecycle errors; the bulk of this app's
 * failure surface is async (Firestore listeners, timer intervals, promise rejections),
 * so this module is also wired to window 'error' / 'unhandledrejection' in main.jsx.
 */

const STORAGE_KEY = 'workz_error_log';
const MAX_ENTRIES = 30;

// In-memory dedupe so a fault firing every interval tick does not flood either sink.
const DEDUPE_WINDOW_MS = 5000;
let lastSignature = '';
let lastSignatureAt = 0;

/** Normalize anything thrown (Error, string, event reason, object) into a flat record. */
const normalizeError = (error) => {
    try {
        if (!error) return { message: 'Unknown error (no payload)', stack: '' };
        if (typeof error === 'string') return { message: error, stack: '' };
        if (error instanceof Error) {
            return { message: error.message || String(error), stack: error.stack || '' };
        }
        // ErrorEvent / PromiseRejectionEvent reasons / plain objects
        const message =
            error.message ||
            error.reason?.message ||
            error.reason ||
            (() => { try { return JSON.stringify(error); } catch { return String(error); } })();
        return { message: String(message), stack: error.stack || error.reason?.stack || '' };
    } catch {
        return { message: 'Unserializable error', stack: '' };
    }
};

// `source` and `componentStack` stay TOP-LEVEL fields of the record (every existing reader keys
// on them there); every other key a caller passes is carried under a nested `context` map and is
// never merged into the record's own fields. Merging would be the cheaper diff but it puts the
// caller in a position to overwrite `userId`, which firestore.rules pins to the authenticated uid
// (or null) — a call site logging someone else's id would then have its remote write DENIED, and
// the crash that mattered most would exist only on the device. Nesting keeps both facts and keeps
// the pin intact.
const RECORD_OWN_CONTEXT_KEYS = ['source', 'componentStack'];
const MAX_CONTEXT_KEYS = 20;
const MAX_CONTEXT_KEY_CHARS = 64;
const MAX_CONTEXT_VALUE_CHARS = 500;

/** Clamp one context value to a flat, bounded scalar. Never throws. */
const sanitizeContextValue = (value) => {
    if (value === null) return null;
    if (typeof value === 'string') return value.slice(0, MAX_CONTEXT_VALUE_CHARS);
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
    // Objects, arrays, Errors, bigints, symbols — collapse to a short string. The stored shape
    // stays flat and predictable, and a circular structure can never reach either sink.
    try {
        const json = JSON.stringify(value);
        if (typeof json === 'string') return json.slice(0, MAX_CONTEXT_VALUE_CHARS);
    } catch { /* circular, a throwing toJSON, or a bigint — fall through to String() */ }
    try { return String(value).slice(0, MAX_CONTEXT_VALUE_CHARS); } catch { return '[unserializable]'; }
};

/**
 * Copy the caller's remaining context keys into a bounded map.
 *
 * These keys used to be discarded by BOTH sinks, which is what made a field report
 * unclassifiable: timerCommandEngine.settle() passes `outcome`, and a `rejected` (nothing
 * happened — the worker lost the stretch) is a different incident from a `conflicted` (another
 * device already recorded it), yet the log showed the same permission-denied for both. Same for
 * the `taskId` / `code` / `commandId` that say WHICH work broke.
 *
 * Bounded on both axes (key count and value length) so an enriched record can never grow the
 * manager-visible log the way the once-unbounded url/userAgent could.
 */
const sanitizeContext = (context) => {
    const extra = {};
    try {
        if (!context || typeof context !== 'object') return extra;
        for (const key of Object.keys(context)) {
            if (!key || RECORD_OWN_CONTEXT_KEYS.includes(key)) continue;
            const value = context[key];
            // undefined is DROPPED, not stringified. Call sites overwhelmingly pass `taskId:
            // task?.id`, and Firestore refuses a document containing an undefined field value
            // outright — one absent id would cost the whole remote record, not just that key.
            if (value === undefined || typeof value === 'function') continue;
            extra[key.slice(0, MAX_CONTEXT_KEY_CHARS)] = sanitizeContextValue(value);
            if (Object.keys(extra).length >= MAX_CONTEXT_KEYS) break;
        }
    } catch {
        // A proxy or a throwing getter — keep what was already collected rather than lose the record.
    }
    return extra;
};

/** Append a record to the capped localStorage ring buffer. Silent on any storage failure. */
const writeToLocalStorage = (record) => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const list = raw ? JSON.parse(raw) : [];
        list.push(record);
        // Keep only the most recent MAX_ENTRIES.
        const trimmed = list.slice(-MAX_ENTRIES);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
        // Storage disabled (private mode), quota exceeded, or JSON corruption — never let it bubble.
    }
};

/**
 * Fire-and-forget write to Firestore. A failed write must never cascade into another error.
 * Returns the write's promise (rejecting on failure) for the one caller that must know whether the
 * record actually landed — see flushBootFailure. Every other caller ignores it, unchanged.
 */
const writeToFirestore = (record) => {
    try {
        return addDoc(collection(db, 'error_logs'), record);
    } catch (err) {
        // collection()/addDoc() construction failure — ignore.
        return Promise.reject(err);
    }
};

/**
 * Record an error to all durable sinks.
 * @param {*} error - Error, string, or event-like object.
 * @param {Object} [context] - Extra context, e.g. { source: 'onSnapshot', componentStack }.
 *   `source` and `componentStack` become top-level fields; every other key (taskId, commandId,
 *   outcome, code, …) is carried, sanitised and bounded, under the record's `context` map.
 */
export const logError = (error, context = {}) => {
    try {
        const { message, stack } = normalizeError(error);

        // Dedupe identical, rapidly-repeating faults.
        const signature = `${context.source || ''}|${message}`;
        const now = Date.now();
        if (signature === lastSignature && now - lastSignatureAt < DEDUPE_WINDOW_MS) {
            return;
        }
        lastSignature = signature;
        lastSignatureAt = now;

        let uid = null;
        try { uid = auth?.currentUser?.uid || null; } catch { /* auth not ready */ }

        const record = {
            message: message.slice(0, 2000),
            stack: (stack || '').slice(0, 8000),
            componentStack: (context.componentStack || '').slice(0, 8000),
            source: context.source || 'unknown',
            userId: uid,
            url: (typeof window !== 'undefined' && window.location?.href) || '',
            userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
            online: (typeof navigator !== 'undefined' && navigator.onLine) ?? null,
            timestamp: new Date().toISOString(),
        };

        // Attached only when there is something to say, so the ~190 source-only call sites keep
        // writing byte-identical records and nothing downstream has to learn a new shape for them.
        const extraContext = sanitizeContext(context);
        if (Object.keys(extraContext).length > 0) record.context = extraContext;

        // Console first — cheapest, and useful when devtools are open.
        console.error(`[WORKZ:${record.source}]`, message, error);

        writeToLocalStorage(record);
        // The catch is mandatory, not decorative: an unhandled rejection here would be caught by
        // this module's own 'unhandledrejection' listener and logged, which writes again — a
        // self-feeding loop out of the very component meant to record failures quietly.
        writeToFirestore(record).catch(() => { /* offline / rules / quota — ignore */ });
    } catch {
        // Absolutely never throw from the logger.
    }
};

/** Read back the local crash log (for an in-app diagnostics view or manual export). */
export const getStoredErrorLog = () => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
};

/** Clear the local crash log. */
export const clearStoredErrorLog = () => {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
};

const BOOT_FAILURE_KEY = 'workz_boot_failure';
// After this many boots without the remote write ever being accepted, stop carrying the record.
// Five is enough to survive several signed-out launches without keeping a trace forever on a
// device whose user never signs in again.
const BOOT_FAILURE_MAX_FLUSH_ATTEMPTS = 5;

/**
 * Ship a previous WHITE-SCREEN boot to the durable sinks.
 *
 * The index.html watchdog can only write to localStorage: on the boot it is reporting, Firebase is
 * part of what failed to load, so the device has no way to tell anyone. This is the hand-off — a
 * later boot that DOES work forwards the trace (with the user agent, which is the whole point when
 * the complaint is "blank on Safari / Opera") so the failure is diagnosable after the fact instead
 * of being a report nobody can reproduce.
 *
 * The record is NOT dropped on a failed send. `error_logs` requires an authenticated user
 * (firestore.rules), and this runs at module load — before sign-in — so the first attempt is
 * normally DENIED. Deleting then would throw away the only copy of a trace nobody ever received.
 * Instead the record is carried to the next boot, which for a returning user is a signed-in one.
 */
const flushBootFailure = () => {
    let record;
    try {
        const raw = localStorage.getItem(BOOT_FAILURE_KEY);
        if (!raw) return;
        record = JSON.parse(raw);
    } catch {
        // Storage blocked, or a corrupt value that will never parse — clear it and move on.
        try { localStorage.removeItem(BOOT_FAILURE_KEY); } catch { /* ignore */ }
        return;
    }

    const attempts = Number(record?.flushAttempts) || 0;
    const drop = () => { try { localStorage.removeItem(BOOT_FAILURE_KEY); } catch { /* ignore */ } };
    if (attempts >= BOOT_FAILURE_MAX_FLUSH_ATTEMPTS) { drop(); return; }

    const message = `Boot watchdog fired: ${record?.reason || 'unknown'} (${record?.error || 'no script error'})`;
    const entry = {
        message: message.slice(0, 2000),
        stack: '',
        componentStack: '',
        source: 'boot.watchdog',
        userId: null,
        // The FAILING boot's context, not this one's — the recovered session would describe the
        // browser that worked, which is the exact opposite of what a compat report needs.
        url: String(record?.url || '').slice(0, 2000),
        userAgent: String(record?.userAgent || '').slice(0, 1000),
        online: typeof record?.online === 'boolean' ? record.online : null,
        timestamp: String(record?.timestamp || new Date().toISOString()),
    };

    if (attempts === 0) {
        // Local ring buffer once, immediately: the trace must survive even if the remote write is
        // never permitted on this device.
        console.error('[WORKZ:boot.watchdog]', message);
        writeToLocalStorage(entry);
    }

    writeToFirestore(entry).then(drop, () => {
        try {
            localStorage.setItem(BOOT_FAILURE_KEY, JSON.stringify({ ...record, flushAttempts: attempts + 1 }));
        } catch { /* ignore */ }
    });
};

/**
 * Install global handlers for the async failures React boundaries cannot catch.
 * Call once, as early as possible (before React mounts).
 */
export const installGlobalErrorLogging = () => {
    if (typeof window === 'undefined') return;
    if (window.__workzErrorLoggingInstalled) return;
    window.__workzErrorLoggingInstalled = true;

    flushBootFailure();

    window.addEventListener('error', (event) => {
        // event.error holds the thrown value for script errors; fall back to the message.
        logError(event.error || event.message || event, { source: 'window.error' });
    });

    window.addEventListener('unhandledrejection', (event) => {
        logError(event.reason || event, { source: 'unhandledrejection' });
    });
};
