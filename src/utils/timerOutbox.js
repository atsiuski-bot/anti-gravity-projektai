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

export async function enqueueTimerCommand(command, plan) {
    const entry = {
        ...command,
        plan,
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
            .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
    }

    const database = await openOutbox();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.index('userId').getAll(userId);
        request.onsuccess = () => {
            const commands = request.result
                .filter((command) => command.status === 'queued')
                .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt));
            resolve(commands);
        };
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
}
