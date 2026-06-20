import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

import ErrorBoundary from './components/ErrorBoundary.jsx'
import PwaUpdatePrompt from './components/PwaUpdatePrompt.jsx'
import { runDatabaseMigration, diagnoseTasks } from './utils/migrateDB.js'
import { installGlobalErrorLogging } from './utils/errorLog.js'

// Capture async failures React error boundaries cannot see (timer/interval throws,
// unhandled promise rejections, Firestore listener errors) into the durable crash log.
// Installed before createRoot so even module-load/pre-mount errors are recorded.
installGlobalErrorLogging();

// Expose migration to window for manual execution in console
window.runMigration = runDatabaseMigration;
window.diagnoseTasks = diagnoseTasks;

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
