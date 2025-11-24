import React from 'react';
import { useAuth } from '../context/AuthContext';
import ManagerView from './ManagerView';
import WorkerView from './WorkerView';
import AdminBootstrap from '../components/AdminBootstrap';

export default function Dashboard() {
    const { userRole } = useAuth();

    return (
        <>
            <AdminBootstrap />
            {userRole === 'manager' || userRole === 'admin' ? <ManagerView /> : <WorkerView />}
        </>
    );
}
