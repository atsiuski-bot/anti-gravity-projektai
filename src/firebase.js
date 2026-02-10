import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
    apiKey: "AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU",
    authDomain: "darbo-planavimas.firebaseapp.com",
    projectId: "darbo-planavimas",
    storageBucket: "darbo-planavimas.firebasestorage.app",
    messagingSenderId: "198926113678",
    appId: "1:198926113678:web:de7f0253681f8c667e62df",
    measurementId: "G-J9ZMTZZSTF"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Clear old corrupted Firestore cache from IndexedDB
// This prevents "INTERNAL ASSERTION FAILED: Unexpected state" errors
if (typeof indexedDB !== 'undefined') {
    try {
        // Delete old persistent cache databases
        indexedDB.deleteDatabase('firestore/darbo-planavimas/default');
        indexedDB.deleteDatabase('firestore/[DEFAULT]/darbo-planavimas/main');
        console.log('Cleared old Firestore cache');
    } catch (e) {
        console.warn('Could not clear old cache:', e);
    }
}

// Initialize Firestore with standard configuration
// Note: Removed persistentLocalCache due to internal SDK errors
export const db = getFirestore(app);

export const storage = getStorage(app);

export default app;
