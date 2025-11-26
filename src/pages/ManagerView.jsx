import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, getDocs } from 'firebase/firestore';
import { Plus } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import CombinedHoursSummary from '../components/CombinedHoursSummary';
import AllUsersCalendar from '../components/AllUsersCalendar';
import WorkPlanner from '../components/WorkPlanner';
import { useAuth } from '../context/AuthContext';
import { Layout, Calendar as CalendarIcon, Users as UsersIcon, ListTodo, ArrowUpDown } from 'lucide-react';

export default function ManagerView() {
    const { userRole } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop'); // 'mobile' or 'desktop'
    const [activeTab, setActiveTab] = useState('tasks'); // 'tasks', 'my-calendar', 'team-calendar', 'users'
    const [sortBy, setSortBy] = useState('none'); // 'none', 'user', 'day', 'user-day', 'day-user'

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

                    // Enrich tasks with worker names and colors
                    tasksData = tasksData.map(task => ({
                        ...task,
                        assignedWorkerName: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? usersMap[task.assignedWorkerId].displayName || usersMap[task.assignedWorkerId].email
                            : null,
                        assignedWorkerColor: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? usersMap[task.assignedWorkerId].color
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

    // Sort tasks based on selected criteria
    const sortedTasks = React.useMemo(() => {
        if (sortBy === 'none') return tasks;

        const dayOrder = {
            'Pirmadienis': 1,
            'Antradienis': 2,
            'Trečiadienis': 3,
            'Ketvirtadienis': 4,
            'Penktadienis': 5,
            'Šeštadienis': 6,
            'Sekmadienis': 7
        };

        const sorted = [...tasks];

        if (sortBy === 'user') {
            sorted.sort((a, b) => {
                const nameA = a.assignedWorkerName || '';
                const nameB = b.assignedWorkerName || '';
                if (!nameA && !nameB) return 0;
                if (!nameA) return 1;
                if (!nameB) return -1;
                return nameA.localeCompare(nameB);
            });
        } else if (sortBy === 'day') {
            sorted.sort((a, b) => {
                const dayA = dayOrder[a.dayOfWeek] || 999;
                const dayB = dayOrder[b.dayOfWeek] || 999;
                return dayA - dayB;
            });
        } else if (sortBy === 'user-day') {
            sorted.sort((a, b) => {
                const nameA = a.assignedWorkerName || '';
                const nameB = b.assignedWorkerName || '';
                if (!nameA && !nameB) {
                    const dayA = dayOrder[a.dayOfWeek] || 999;
                    const dayB = dayOrder[b.dayOfWeek] || 999;
                    return dayA - dayB;
                }
                if (!nameA) return 1;
                if (!nameB) return -1;
                const nameCompare = nameA.localeCompare(nameB);
                if (nameCompare !== 0) return nameCompare;
                const dayA = dayOrder[a.dayOfWeek] || 999;
                const dayB = dayOrder[b.dayOfWeek] || 999;
                return dayA - dayB;
            });
        } else if (sortBy === 'day-user') {
            sorted.sort((a, b) => {
                const dayA = dayOrder[a.dayOfWeek] || 999;
                const dayB = dayOrder[b.dayOfWeek] || 999;
                const dayCompare = dayA - dayB;
                if (dayCompare !== 0) return dayCompare;
                const nameA = a.assignedWorkerName || '';
                const nameB = b.assignedWorkerName || '';
                if (!nameA && !nameB) return 0;
                if (!nameA) return 1;
                if (!nameB) return -1;
                return nameA.localeCompare(nameB);
            });
        }

        return sorted;
    }, [tasks, sortBy]);

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

            {/* Tab Navigation */}
            <div className="flex border-b border-gray-200 mb-6 overflow-x-auto">
                <button
                    onClick={() => setActiveTab('tasks')}
                    className={`flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${activeTab === 'tasks'
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                        }`}
                >
                    <ListTodo className="w-4 h-4" />
                    Užduotys
                </button>
                <button
                    onClick={() => setActiveTab('my-calendar')}
                    className={`flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${activeTab === 'my-calendar'
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                        }`}
                >
                    <CalendarIcon className="w-4 h-4" />
                    Mano kalendorius
                </button>
                <button
                    onClick={() => setActiveTab('team-calendar')}
                    className={`flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${activeTab === 'team-calendar'
                        ? 'border-blue-500 text-blue-600'
                        : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                        }`}
                >
                    <Layout className="w-4 h-4" />
                    Komandos kalendorius
                </button>
                {userRole === 'admin' && (
                    <button
                        onClick={() => setActiveTab('users')}
                        className={`flex items-center gap-2 px-4 py-2 border-b-2 font-medium text-sm whitespace-nowrap transition-colors ${activeTab === 'users'
                            ? 'border-blue-500 text-blue-600'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        <UsersIcon className="w-4 h-4" />
                        Vartotojai
                    </button>
                )}
            </div>

            {/* Tab Content */}
            {activeTab === 'tasks' && (
                <>
                    <CombinedHoursSummary />

                    {/* Sort dropdown above task list */}
                    <div className="flex justify-end mb-4">
                        <div className="relative">
                            <ArrowUpDown className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value)}
                                className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                            >
                                <option value="none">Numatyta tvarka</option>
                                <option value="user">Pagal vartotoją</option>
                                <option value="day">Pagal dieną</option>
                                <option value="user-day">Vartotojas → Diena</option>
                                <option value="day-user">Diena → Vartotojas</option>
                            </select>
                        </div>
                    </div>

                    {viewMode === 'mobile' ? (
                        <div className="space-y-4">
                            {sortedTasks.map(task => (
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
                            tasks={sortedTasks}
                            onEdit={handleEditTask}
                            role="manager"
                        />
                    )}
                </>
            )}

            {activeTab === 'my-calendar' && (
                <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4">Mano darbo kalendorius</h3>
                    <WorkPlanner />
                </div>
            )}

            {activeTab === 'team-calendar' && (
                <AllUsersCalendar />
            )}

            {activeTab === 'users' && userRole === 'admin' && (
                <UserManagement />
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
