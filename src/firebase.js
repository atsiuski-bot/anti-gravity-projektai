import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";
import { resolveAuthDomain } from "./utils/authEnvironment";

/** Firebase's own helper origin — correct everywhere the popup works, i.e. almost everywhere. */
const HOSTED_AUTH_DOMAIN = "darbo-planavimas.firebaseapp.com";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU",
    // Environment-dependent: the installed iOS app needs a FIRST-PARTY sign-in helper or it can
    // never complete a Google handshake at all (see resolveAuthDomain). An explicit env override
    // still wins — it is how a non-production project points elsewhere.
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || resolveAuthDomain(HOSTED_AUTH_DOMAIN),
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "darbo-planavimas",
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "darbo-planavimas.firebasestorage.app",
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "198926113678",
    appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:198926113678:web:de7f0253681f8c667e62df",
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-J9ZMTZZSTF"
};

// Surface a misconfigured deploy loudly instead of silently connecting to the baked-in
// fallback project (which would later fail as confusing permission/listener errors).
if (!import.meta.env.VITE_FIREBASE_API_KEY || !import.meta.env.VITE_FIREBASE_PROJECT_ID) {
    console.warn('[firebase] VITE_FIREBASE_* env vars missing — using built-in fallback config.');
}

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Initialize Firestore with persistent cache for instant loads. Cache serves data
// immediately while syncing with the server in the background. In private-browsing or
// storage-disabled contexts persistentLocalCache can THROW at import time — before React
// (and the ErrorBoundary) mount — which would blank the screen. Fall back to an in-memory
// Firestore so the app still loads.
let db;
// Whether writes issued while offline actually SURVIVE the app being closed. The memory fallback
// below keeps the app usable, but its queue lives only in the tab: close the PWA before reconnect
// and every unsent timer action is gone. The UI promises a worker their time is "saved on the
// phone", and that promise is only true on the persistent cache — so the storage layer has to
// publish which of the two it got instead of letting the copy assume the good case.
let persistentCache = true;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
} catch (err) {
    console.warn('[firebase] Persistent cache unavailable, falling back to memory cache:', err);
    db = getFirestore(app);
    persistentCache = false;
}
export { db };
export const hasPersistentCache = persistentCache;

export const storage = getStorage(app);

// Callable Cloud Functions. Region MUST match the functions' deploy region (europe-west1, set in
// functions/index.js setGlobalOptions) or httpsCallable resolves the wrong endpoint and 404s.
export const functions = getFunctions(app, 'europe-west1');

export default app;
