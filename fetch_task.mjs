import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc } from "firebase/firestore";

const firebaseConfig = {
    apiKey: "AIzaSyDXaHCrL8hKgaEedSXEIT-XSxhmIcCEuXU",
    authDomain: "darbo-planavimas.firebaseapp.com",
    projectId: "darbo-planavimas",
    storageBucket: "darbo-planavimas.firebasestorage.app",
    messagingSenderId: "198926113678",
    appId: "1:198926113678:web:de7f0253681f8c667e62df",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const TASK_ID = "EgX402PNSBiqoJcJmTHw";

async function fetchTask() {
    const collections = ["tasks", "archived_tasks", "deleted_tasks"];

    for (const col of collections) {
        console.log(`\n--- Checking collection: ${col} ---`);
        const docRef = doc(db, col, TASK_ID);
        const snap = await getDoc(docRef);
        if (snap.exists()) {
            console.log(`FOUND in "${col}"!`);
            const data = snap.data();
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log(`Not found in "${col}".`);
        }
    }

    process.exit(0);
}

fetchTask().catch((err) => {
    console.error("Error:", err);
    process.exit(1);
});
