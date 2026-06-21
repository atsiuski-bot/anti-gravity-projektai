import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { NavigationProvider } from './context/NavigationContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { UsersProvider } from './context/UsersContext';
import Layout from './components/Layout';

// Lazy load pages
const Login = React.lazy(() => import('./pages/Login'));
const Dashboard = React.lazy(() => import('./pages/Dashboard'));

const LoadingFallback = () => (
    <div className="flex h-screen items-center justify-center bg-surface-base">
        <div className="text-center">
            <div className="w-12 h-12 border-4 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
            <p className="text-ink-muted font-medium">Kraunama…</p>
        </div>
    </div>
);

const ProtectedRoute = ({ children }) => {
    const { currentUser, loading } = useAuth();

    if (loading) return <div className="flex h-screen items-center justify-center">Kraunama…</div>;

    if (!currentUser) {
        return <Navigate to="/login" />;
    }

    return children;
};

function App() {
    React.useEffect(() => {
        const req = async () => {
            if ("Notification" in window && Notification.permission === "default") {
                try {
                    await Notification.requestPermission();
                } catch (e) {
                    console.error("Notification request failed", e);
                }
            }
        };
        req();
    }, []);

    return (
        <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <AuthProvider>
                <UsersProvider>
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
                </UsersProvider>
            </AuthProvider>
        </BrowserRouter>
    );
}

// Force rebuild
export default App;
