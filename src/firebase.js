import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";
import { getFunctions } from "firebase/functions";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "darbo-planavimas.firebaseapp.com",
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
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
} catch (err) {
    console.warn('[firebase] Persistent cache unavailable, falling back to memory cache:', err);
    db = getFirestore(app);
}
export { db };

export const storage = getStorage(app);

// Callable Cloud Functions. Region MUST match the functions' deploy region (europe-west1, set in
// functions/index.js setGlobalOptions) or httpsCallable resolves the wrong endpoint and 404s.
export const functions = getFunctions(app, 'europe-west1');

export default app;
