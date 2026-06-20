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

/** Fire-and-forget write to Firestore. A failed write must never cascade into another error. */
const writeToFirestore = (record) => {
    try {
        addDoc(collection(db, 'error_logs'), record).catch(() => { /* offline / rules / quota — ignore */ });
    } catch {
        // collection()/addDoc() construction failure — ignore.
    }
};

/**
 * Record an error to all durable sinks.
 * @param {*} error - Error, string, or event-like object.
 * @param {Object} [context] - Extra context, e.g. { source: 'onSnapshot', componentStack }.
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

        // Console first — cheapest, and useful when devtools are open.
        console.error(`[WORKZ:${record.source}]`, message, error);

        writeToLocalStorage(record);
        writeToFirestore(record);
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

/**
 * Install global handlers for the async failures React boundaries cannot catch.
 * Call once, as early as possible (before React mounts).
 */
export const installGlobalErrorLogging = () => {
    if (typeof window === 'undefined') return;
    if (window.__workzErrorLoggingInstalled) return;
    window.__workzErrorLoggingInstalled = true;

    window.addEventListener('error', (event) => {
        // event.error holds the thrown value for script errors; fall back to the message.
        logError(event.error || event.message || event, { source: 'window.error' });
    });

    window.addEventListener('unhandledrejection', (event) => {
        logError(event.reason || event, { source: 'unhandledrejection' });
    });
};
