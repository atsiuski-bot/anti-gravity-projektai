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
import TaskHistory from '../components/TaskHistory';
import DailyStatistics from '../components/DailyStatistics';
import DailyWorkProgress from '../components/DailyWorkProgress';
import ManagerNotifications from '../components/ManagerNotifications';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { Layout, Calendar as CalendarIcon, Users as UsersIcon, ListTodo, ArrowUpDown, History, UserCheck } from 'lucide-react';
import { filterTasksByVisibility, sortWorkerTasks } from '../utils/taskUtils';

export default function ManagerView() {
    const { userRole, currentUser } = useAuth();
    const { activeTab } = useNavigation();
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');
    const [sortBy, setSortBy] = useState('none');

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
                    const usersList = [];
                    usersSnapshot.docs.forEach(doc => {
                        const userData = { id: doc.id, ...doc.data() };
                        usersMap[doc.id] = userData;
                        if (!userData.isDisabled) { // Filter out blocked users from the list passed to components
                            usersList.push(userData);
                        }
                    });
                    setUsers(usersList);

                    // Enrich tasks with worker names and colors
                    tasksData = tasksData.map(task => ({
                        ...task,
                        assignedWorkerName: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? usersMap[task.assignedWorkerId].displayName || usersMap[task.assignedWorkerId].email
                            : null,
                        assignedWorkerColor: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? usersMap[task.assignedWorkerId].color
                            : null,
                        creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
                            ? usersMap[task.createdBy].displayName || usersMap[task.createdBy].email
                            : null)
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

        const handleOpenModalEvent = () => handleCreateTask();
        window.addEventListener('open-task-modal', handleOpenModalEvent);

        return () => {
            unsubscribe();
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('open-task-modal', handleOpenModalEvent);
        };
    }, []);

    const handleCreateTask = () => {
        setEditingTask(null);
        setIsModalOpen(true);
    };

    // Sort tasks based on selected criteria
    const sortedTasks = React.useMemo(() => {
        if (sortBy === 'none') return tasks;


        const priorityOrder = {
            'Urgent': 1,
            'High': 2,
            'Medium': 3,
            'Low': 4
        };

        const sorted = [...tasks];

        const comparePriority = (a, b) => {
            const prioA = priorityOrder[a.priority] || 99;
            const prioB = priorityOrder[b.priority] || 99;
            return prioA - prioB;
        };


        const compareUser = (a, b) => {
            const nameA = a.assignedWorkerName || '';
            const nameB = b.assignedWorkerName || '';
            if (!nameA && !nameB) return 0;
            if (!nameA) return 1;
            if (!nameB) return -1;
            return nameA.localeCompare(nameB);
        };

        if (sortBy === 'user') {
            sorted.sort((a, b) => {
                const userDiff = compareUser(a, b);
                if (userDiff !== 0) return userDiff;
                return comparePriority(a, b);
            });
        }

        return sorted;
    }, [tasks, sortBy]);

    const handleEditTask = (task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    };

    return (
        <div className="pt-1 sm:pt-4">
            {error && (
                <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            <ManagerNotifications />

            {/* Tab Navigation */}

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

            {activeTab === 'my-tasks' && (
                <>
                    {/* Reuse worker view logic for "My Tasks" */}
                    {(() => {
                        const myTasks = tasks.filter(t => t.assignedWorkerId === currentUser?.uid);
                        // Managers/Admins might want to see ALL their assigned tasks, not just "Today's" filtered list.
                        // Removed filterTasksByVisibility(myTasks) for this view.
                        const filteredMyTasks = myTasks;
                        const sortedMyTasks = sortWorkerTasks(filteredMyTasks);

                        return (
                            <>
                                <div className="mb-6">
                                    <DailyWorkProgress currentUser={currentUser} />
                                </div>
                                {sortedMyTasks.length === 0 ? (
                                    <div className="text-center py-12 bg-white rounded-xl shadow-sm border border-gray-200">
                                        <p className="text-gray-500">Jums dar nepriskirta jokių užduočių.</p>
                                    </div>
                                ) : viewMode === 'mobile' ? (
                                    <div className="space-y-4">
                                        {sortedMyTasks.map(task => (
                                            <TaskCard
                                                key={task.id}
                                                task={task}
                                                onEdit={() => handleEditTask(task)}
                                                role="worker"
                                            />
                                        ))}
                                    </div>
                                ) : (
                                    <TaskTable
                                        tasks={sortedMyTasks}
                                        onEdit={handleEditTask}
                                        role="worker" // Mimic worker view columns/actions
                                    />
                                )}
                            </>
                        );
                    })()}
                </>
            )}

            {activeTab === 'my-calendar' && (
                <div className="w-full">
                    <WorkPlanner />
                </div>
            )}

            {activeTab === 'team-calendar' && (
                <AllUsersCalendar />
            )}

            {activeTab === 'reports' && (
                <div className="space-y-6">
                    <DailyStatistics currentUser={currentUser} userRole={userRole} users={users} />

                    <div className="pt-8 border-t border-gray-200">
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">Archyvuotos užduotys</h3>
                        <TaskHistory />
                    </div>
                </div>
            )}

            {activeTab === 'my-reports' && (
                <div className="space-y-6">
                    <DailyStatistics
                        currentUser={currentUser}
                        userRole="worker" // Force worker role to show only personal stats
                        users={[]}
                    />
                </div>
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
