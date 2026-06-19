const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

// Initialize without credentials - uses ADC or connects without auth for reads
// For Firestore emulator or projects where ADC is set up
initializeApp({ projectId: "darbo-planavimas" });
const db = getFirestore();

const TASK_ID = "EgX402PNSBiqoJcJmTHw";

async function run() {
    const collections = ["tasks", "archived_tasks", "deleted_tasks"];

    for (const col of collections) {
        console.log(`\n=== Collection: ${col} ===`);
        try {
            const snap = await db.collection(col).doc(TASK_ID).get();
            if (snap.exists) {
                console.log("FOUND!");
                const data = snap.data();
                // Pretty print with special handling for Timestamps
                const formatted = JSON.stringify(data, (key, value) => {
                    if (value && value._seconds !== undefined) {
                        return new Date(value._seconds * 1000).toISOString();
                    }
                    return value;
                }, 2);
                console.log(formatted);
            } else {
                console.log("Not found.");
            }
        } catch (err) {
            console.error(`Error reading ${col}:`, err.message);
        }
    }

    process.exit(0);
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
