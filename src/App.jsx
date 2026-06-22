import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { NavigationProvider } from './context/NavigationContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UsersProvider } from './context/UsersContext';
import { ToastProvider } from './context/ToastContext';
import { NotificationsProvider } from './context/NotificationsContext';
import Layout from './components/Layout';

// Lazy load pages
const Login = React.lazy(() => import('./pages/Login'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));

const LoadingFallback = () => (
    <div className="flex h-screen items-center justify-center bg-surface-base">
        <div className="text-center" role="status">
            <div className="w-12 h-12 border-4 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-ink-muted font-medium">Kraunama…</p>
        </div>
    </div>
);

const ProtectedRoute = ({ children }) => {
    const { currentUser, loading } = useAuth();

    if (loading) return <div className="flex h-screen items-center justify-center" role="status">Kraunama…</div>;

    if (!currentUser) {
        return <Navigate to="/login" />;
    }

    return children;
};

function App() {
    React.useEffect(() => {
        // Ask for notification permission on the FIRST user interaction, not on load.
        // A cold prompt fired during app startup (no user gesture) is increasingly
        // ignored or auto-dismissed by browsers — and Safari requires a gesture — which
        // burns the one-time ask and inflates the deny rate. Deferring to the first
        // pointer/key event asks once, while the user is engaged, then unbinds.
        if (!("Notification" in window) || Notification.permission !== "default") return undefined;
        const events = ["pointerdown", "keydown"];

        async function requestOnce() {
            events.forEach((ev) => window.removeEventListener(ev, requestOnce));
            try {
                const result = await Notification.requestPermission();
                // Tell NotificationsProvider to register this device's FCM token now that the
                // user has granted permission (it owns currentUser + token persistence).
                if (result === "granted") {
                    window.dispatchEvent(new CustomEvent("notifications-granted"));
                }
            } catch (e) {
                console.error("Notification request failed", e);
            }
        }

        events.forEach((ev) => window.addEventListener(ev, requestOnce));
        return () => events.forEach((ev) => window.removeEventListener(ev, requestOnce));
    }, []);

    return (
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AuthProvider>
                <UsersProvider>
                    <ToastProvider>
                        <NotificationsProvider>
                            <NavigationProvider>
                                <React.Suspense fallback={<LoadingFallback />}>
                                    <Routes>
                                        <Route path="/login" element={<Login />} />
                                        <Route path="/" element={
                                            <ProtectedRoute>
                                                <Layout>
                                                    <Dashboard />
                                                </Layout>
                                            </ProtectedRoute>
                                        } />
                                    </Routes>
                                </React.Suspense>
                            </NavigationProvider>
                        </NotificationsProvider>
                    </ToastProvider>
                </UsersProvider>
            </AuthProvider>
        </BrowserRouter>
    );
}

// Force rebuild
export default App;
