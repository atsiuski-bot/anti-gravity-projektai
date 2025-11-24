import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

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
export default app;
