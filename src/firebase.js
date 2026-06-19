import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "darbo-planavimas.firebaseapp.com",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "darbo-planavimas",
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "darbo-planavimas.firebasestorage.app",
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "198926113678",
    appId: import.meta.env.VITE_FIREBASE_APP_ID || "1:198926113678:web:de7f0253681f8c667e62df",
    measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID || "G-J9ZMTZZSTF"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Initialize Firestore with persistent cache for instant loads
// Cache serves data immediately while syncing with the server in background
export const db = initializeFirestore(app, {
    localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const storage = getStorage(app);

export default app;
