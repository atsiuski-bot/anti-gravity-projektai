import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, getDocs } from 'firebase/firestore';
import { Plus } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import AllUsersHoursSummary from '../components/AllUsersHoursSummary';
import AllWorkersCalendars from '../components/AllWorkersCalendars';
import WorkPlanner from '../components/WorkPlanner';
import { useAuth } from '../context/AuthContext';

export default function ManagerView() {
    const { userRole } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop'); // 'mobile' or 'desktop'

    const [error, setError] = useState(null);

    useEffect(() => {
        let unsubscribe = () => { };

        try {
            const q = query(collection(db, 'tasks'), orderBy('createdAt', 'desc'));
            unsubscribe = onSnapshot(q, async (snapshot) => {
                let tasksData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                // Fetch worker names for assigned tasks
                try {
                    const usersSnapshot = await getDocs(collection(db, 'users'));
                    const usersMap = {};
                    usersSnapshot.docs.forEach(doc => {
                        usersMap[doc.id] = doc.data();
                    });

                    // Enrich tasks with worker names
                    tasksData = tasksData.map(task => ({
                        ...task,
                        assignedWorkerName: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? usersMap[task.assignedWorkerId].displayName || usersMap[task.assignedWorkerId].email
                            : null
                    }));
                } catch (err) {
                    console.error("Error fetching user names:", err);
                }

                setTasks(tasksData);
                setError(null);
            }, (err) => {
                console.error("Error fetching tasks:", err);
                setError("Nepavyko užkrauti užduočių. Patikrinkite teises arba bandykite vėliau.");
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
        }

        // Simple responsive check
        const handleResize = () => {
            setViewMode(window.innerWidth < 768 ? 'mobile' : 'desktop');
        };

        window.addEventListener('resize', handleResize);
        handleResize(); // Initial check

        return () => {
            unsubscribe();
            window.removeEventListener('resize', handleResize);
        };
    }, []);

    const handleCreateTask = () => {
        setEditingTask(null);
        setIsModalOpen(true);
    };

    const handleEditTask = (task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    };

    return (
        <div>
            <div className="flex justify-between items-center mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Visos užduotys</h2>
                <button
                    onClick={handleCreateTask}
                    className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors"
                >
                    <Plus className="w-5 h-5" />
                    Sukurti užduotį
                </button>
            </div>

            {error && (
                <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            <AllUsersHoursSummary />

            <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
                <h3 className="text-lg font-semibold text-gray-900 mb-4">Mano darbo kalendorius</h3>
                <WorkPlanner />
            </div>

            <AllWorkersCalendars />

            {userRole === 'admin' && <UserManagement />}

            {viewMode === 'mobile' ? (
                <div className="space-y-4">
                    {tasks.map(task => (
                        <TaskCard
                            key={task.id}
                            task={task}
                            onEdit={() => handleEditTask(task)}
                            role="manager"
                        />
                    ))}
                </div>
            ) : (
                <TaskTable
                    tasks={tasks}
                    onEdit={handleEditTask}
                    role="manager"
                />
            )}

            {isModalOpen && (
                <TaskModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    task={editingTask}
                    role="manager"
                />
            )}
        </div>
    );
}
