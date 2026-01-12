import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

import { NavigationProvider } from './context/NavigationContext';

const ProtectedRoute = ({ children }) => {
    const { currentUser, loading } = useAuth();

    if (loading) return <div className="flex h-screen items-center justify-center">Loading...</div>;

    if (!currentUser) {
        return <Navigate to="/login" />;
    }

    return children;
};

function App() {
    return (
        <BrowserRouter>
            <AuthProvider>
                <NavigationProvider>
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
                </NavigationProvider>
            </AuthProvider>
        </BrowserRouter>
    );
}

export default App;
