const DB_NAME = 'gildija-timer-outbox';
const DB_VERSION = 1;
const STORE_NAME = 'commands';
const memoryCommands = new Map();
const listeners = new Set();

const isTestRuntime = () => typeof process !== 'undefined' && process.env?.NODE_ENV === 'test';

function emit(command) {
    for (const listener of listeners) listener(command);
}

function openOutbox() {
    if (typeof indexedDB === 'undefined') {
        if (isTestRuntime()) return Promise.resolve(null);
        return Promise.reject(new Error('Persistent timer storage is unavailable'));
    }

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const database = request.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                const store = database.createObjectStore(STORE_NAME, { keyPath: 'commandId' });
                store.createIndex('userId', 'userId', { unique: false });
                store.createIndex('status', 'status', { unique: false });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function runTransaction(mode, operation) {
    const database = await openOutbox();
    if (!database) return operation(null);

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        let result;
        try {
            result = operation(store);
        } catch (error) {
            database.close();
            reject(error);
            return;
        }
        transaction.oncomplete = () => {
            database.close();
            resolve(result);
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
        transaction.onabort = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

// Monotonic per-device issue order, independent of the wall clock.
//
// Replay used to be ordered by the client's `issuedAt` STRING alone. Two commands stamped in the
// same millisecond sort arbitrarily, and a clock correction (NTP catching up, a manual timezone fix,
// a phone waking with a rolled-back clock) can order a stop BEFORE the start it belongs to. After a
// crash between outbox persistence and Firestore issuance, that replays the pair backwards: the stop
// is rejected against the wrong revision and the run is left active — ghost time the worker never
// worked. A counter cannot go backwards, so it fixes the order regardless of what the clock does.
//
// Seeded once per process from the highest sequence already persisted (INCLUDING terminal entries),
// so it stays monotonic across reloads even when the clock is not.
let seqCursor = null;

async function readAllEntries() {
    if (isTestRuntime() && typeof indexedDB === 'undefined') {
        return [...memoryCommands.values()];
    }
    return runTransaction('readonly', (store) => new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result || []);
        request.onerror = () => reject(request.error);
    }));
}

async function allocateSequence() {
    if (seqCursor === null) {
        try {
            const entries = await readAllEntries();
            seqCursor = (entries || []).reduce(
                (max, entry) => Math.max(max, Number(entry?.sequence) || 0), 0
            );
        } catch {
            // An unreadable store must not block issuing a command; start fresh. Legacy entries
            // without a sequence sort first (see the comparator), so ordering stays sane.
            seqCursor = 0;
        }
    }
    seqCursor += 1;
    return seqCursor;
}

// Sequence first (it cannot regress), issuedAt only as a tie-break for entries written before
// sequences existed — those carry no sequence, read as 0, and therefore stay ahead of new ones.
const byIssueOrder = (a, b) =>
    ((Number(a.sequence) || 0) - (Number(b.sequence) || 0))
    || String(a.issuedAt || '').localeCompare(String(b.issuedAt || ''));

export async function enqueueTimerCommand(command, plan) {
    const entry = {
        ...command,
        plan,
        sequence: await allocateSequence(),
        status: 'queued',
        updatedAt: new Date().toISOString(),
    };
    if (isTestRuntime() && typeof indexedDB === 'undefined') {
        memoryCommands.set(entry.commandId, entry);
    } else {
        await runTransaction('readwrite', (store) => store.put(entry));
    }
    emit(entry);
    return entry;
}

export async function updateTimerCommandStatus(commandId, status, details = {}) {
    if (isTestRuntime() && typeof indexedDB === 'undefined') {
        const current = memoryCommands.get(commandId);
        if (!current) return null;
        const next = {
            ...current,
            ...details,
            status,
            updatedAt: new Date().toISOString(),
        };
        memoryCommands.set(commandId, next);
        emit(next);
        return next;
    }

    const database = await openOutbox();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(commandId);
        let next = null;
        request.onsuccess = () => {
            if (!request.result) return;
            next = {
                ...request.result,
                ...details,
                status,
                updatedAt: new Date().toISOString(),
            };
            store.put(next);
        };
        transaction.oncomplete = () => {
            database.close();
            if (next) emit(next);
            resolve(next);
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error);
        };
    });
}

export async function listQueuedTimerCommands(userId) {
    if (isTestRuntime() && typeof indexedDB === 'undefined') {
        return [...memoryCommands.values()]
            .filter((command) => command.userId === userId && command.status === 'queued')
            .sort(byIssueOrder);
    }

    const database = await openOutbox();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.index('userId').getAll(userId);
        request.onsuccess = () => {
            const commands = request.result
                .filter((command) => command.status === 'queued')
                .sort(byIssueOrder);
            resolve(commands);
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
    });
}

// Statuses a worker still needs to SEE. `queued` = saved on this device, not yet confirmed by the
// server; `rejected`/`conflicted` = the command did not take effect and the worker was never told.
// The outbox recorded all three from the start, but nothing ever read them back after a reload, so
// component-local React state was the only surface and it died with the page (audit T-07).
// `acknowledged` is the terminal state a dismissal writes, so a seen failure stops resurfacing.
export const UNSETTLED_STATUSES = ['queued'];
export const FAILED_STATUSES = ['rejected', 'conflicted'];

export async function listTimerCommandOutcomes(userId) {
    const visible = (command) =>
        command.userId === userId
        && (UNSETTLED_STATUSES.includes(command.status) || FAILED_STATUSES.includes(command.status));

    if (isTestRuntime() && typeof indexedDB === 'undefined') {
        return [...memoryCommands.values()].filter(visible).sort(byIssueOrder);
    }

    const database = await openOutbox();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.index('userId').getAll(userId);
        request.onsuccess = () => resolve(request.result.filter(visible).sort(byIssueOrder));
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => database.close();
    });
}

export function subscribeTimerCommands(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function clearMemoryTimerOutboxForTests() {
    memoryCommands.clear();
    seqCursor = null; // re-seed, so each test starts from a clean issue order
}
