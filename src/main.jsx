import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

import ErrorBoundary from './components/ErrorBoundary.jsx'
import PwaUpdatePrompt from './components/PwaUpdatePrompt.jsx'
import { runDatabaseMigration, diagnoseTasks } from './utils/migrateDB.js'
import { installGlobalErrorLogging } from './utils/errorLog.js'
import { installStaleChunkRecovery } from './utils/appUpdate.js'

// Capture async failures React error boundaries cannot see (timer/interval throws,
// unhandled promise rejections, Firestore listener errors) into the durable crash log.
// Installed before createRoot so even module-load/pre-mount errors are recorded.
installGlobalErrorLogging();
installStaleChunkRecovery();

// Disarm the boot watchdog in index.html. Reaching this line proves the entry module parsed and
// ran, so a white screen from here on is React's problem (ErrorBoundary) or the network's — both
// of which have their own recovery. Set BEFORE createRoot so a render that throws synchronously
// still counts as "booted" and hands the failure to the boundary instead of the watchdog.
window.__workzBooted = true;

// Console handles for the one-off DB migration + task diagnostic — DEV ONLY.
//
// These shipped in the production bundle, which put an unaudited BULK TASK REWRITE one console line
// away for anyone with a session: nothing about the browser console is privileged, and the migration
// runs with whatever rights the signed-in user already has. There is no legitimate production caller
// — it is a maintenance tool run by hand during development — so the import.meta.env.DEV guard both
// removes the handle and lets the bundler drop the module from the production build entirely.
if (import.meta.env.DEV) {
    window.runMigration = runDatabaseMigration;
    window.diagnoseTasks = diagnoseTasks;
}

// Service-worker registration + the accessible update prompt now live inside the React tree
// (PwaUpdatePrompt), replacing the banned window.confirm that the bare registerSW used.
ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ErrorBoundary>
            <App />
            <PwaUpdatePrompt />
        </ErrorBoundary>
    </React.StrictMode>,
)
