import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, getDoc, doc, getFirestore } from "firebase/firestore";
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

// Initialize Firestore with persistent local cache
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({
            tabManager: persistentMultipleTabManager()
        })
    });
} catch (error) {
    if (error.code === 'failed-precondition') {
        db = getFirestore(app);
    } else {
        throw error;
    }
}
export { db };

export const storage = getStorage(app);

export default app;
