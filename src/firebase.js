import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore, enableIndexedDbPersistence } from "firebase/firestore";

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
export const db = getFirestore(app);

// Enable offline persistence
enableIndexedDbPersistence(db).catch((err) => {
    if (err.code === 'failed-precondition') {
        // Multiple tabs open, persistence can only be enabled in one tab at a a time.
        console.warn('Firestore persistence failed: multiple tabs open');
    } else if (err.code === 'unimplemented') {
        // The current browser does not support all of the features required to enable persistence
        console.warn('Firestore persistence is not supported by this browser');
    }
});

export default app;
