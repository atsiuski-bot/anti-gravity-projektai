import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, getDocs, doc, getDoc, setDoc, where } from 'firebase/firestore';
import { Plus, Users, LayoutDashboard, CheckSquare, Layout, Calendar as CalendarIcon, Users as UsersIcon, ListTodo, ArrowUpDown, History, UserCheck } from 'lucide-react';
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

import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { getPriorityRank } from '../utils/priority';

export default function ManagerView() {
    const { userRole, currentUser } = useAuth();
    const { activeTab, scrollPositions } = useNavigation();
    const [tasks, setTasks] = useState([]);
    const [users, setUsers] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');
    const [sortBy, setSortBy] = useState('none');
    const [manualTaskOrder, setManualTaskOrder] = useState([]);

    const [error, setError] = useState(null);

    // Fetch manual task order
    useEffect(() => {
        if (!currentUser) return;
        const fetchSettings = async () => {
            try {
                const docRef = doc(db, 'user_settings', currentUser.uid);
                const docSnap = await getDoc(docRef);
                if (docSnap.exists() && docSnap.data().manualTaskOrder) {
                    setManualTaskOrder(docSnap.data().manualTaskOrder);
                }
            } catch (err) {
                console.error("Error fetching user settings:", err);
            }
        };
        fetchSettings();
    }, [currentUser]);

    const saveManualOrder = async (newOrder) => {
        setManualTaskOrder(newOrder);
        try {
            await setDoc(doc(db, 'user_settings', currentUser.uid), {
                manualTaskOrder: newOrder
            }, { merge: true });
        } catch (err) {
            console.error("Error saving manual order:", err);
        }
    };

    const handleMoveUp = (taskId) => {
        const currentList = [...sortedTasks];
        const index = currentList.findIndex(t => t.id === taskId);
        if (index > 0) {
            const temp = currentList[index];
            currentList[index] = currentList[index - 1];
            currentList[index - 1] = temp;
            const newOrder = currentList.map(t => t.id);
            saveManualOrder(newOrder);
        }
    };

    const handleMoveDown = (taskId) => {
        const currentList = [...sortedTasks];
        const index = currentList.findIndex(t => t.id === taskId);
        if (index < currentList.length - 1) {
            const temp = currentList[index];
            currentList[index] = currentList[index + 1];
            currentList[index + 1] = temp;
            const newOrder = currentList.map(t => t.id);
            saveManualOrder(newOrder);
        }
    };

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


        const comparePriority = (a, b) => {
            const rankA = getPriorityRank(a.priority);
            const rankB = getPriorityRank(b.priority);
            return rankB - rankA; // Descending rank (Urgent > Low)
        };

        const sorted = [...tasks];


        const compareUser = (a, b) => {
            const nameA = a.assignedWorkerName || '';
            const nameB = b.assignedWorkerName || '';
            if (!nameA && !nameB) return 0;
            if (!nameA) return 1;
            if (!nameB) return -1;
            return nameA.localeCompare(nameB);
        };

        const compareDeadline = (a, b) => {
            const dateA = a.deadline || '9999-99-99'; // No deadline goes last
            const dateB = b.deadline || '9999-99-99';
            return dateA.localeCompare(dateB);
        };

        if (sortBy === 'user') {
            sorted.sort((a, b) => {
                const userDiff = compareUser(a, b);
                if (userDiff !== 0) return userDiff;
                return comparePriority(a, b);
            });
        } else if (sortBy === 'deadline-user') {
            sorted.sort((a, b) => {
                const deadlineDiff = compareDeadline(a, b);
                if (deadlineDiff !== 0) return deadlineDiff;
                return compareUser(a, b);
            });
        } else if (sortBy === 'user-priority') {
            sorted.sort((a, b) => {
                const userDiff = compareUser(a, b);
                if (userDiff !== 0) return userDiff;
                return comparePriority(a, b);
            });
        } else if (sortBy === 'manual') {
            const orderMap = new Map(manualTaskOrder.map((id, index) => [id, index]));
            sorted.sort((a, b) => {
                const idxA = orderMap.has(a.id) ? orderMap.get(a.id) : 999999;
                const idxB = orderMap.has(b.id) ? orderMap.get(b.id) : 999999;

                if (idxA !== idxB) return idxA - idxB;
                return 0;
            });
        } else if (sortBy.startsWith('tag-')) {
            const tag = sortBy.replace('tag-', '');
            sorted.sort((a, b) => {
                // Users should already be fetched by the main component effect


                // Placeholder Function for mobile nav (BottomNavigation usually handles this in mobile layout, 
                // but here we are describing the Desktop Manager View mostly)h (Selected tag first)
                const isTagA = a.tag === tag;
                const isTagB = b.tag === tag;
                if (isTagA && !isTagB) return -1;
                if (!isTagA && isTagB) return 1;

                // 2. Priority
                const prioDiff = comparePriority(a, b);
                if (prioDiff !== 0) return prioDiff;

                // 3. User
                return compareUser(a, b);
            });
        }

        return sorted;
    }, [tasks, sortBy, manualTaskOrder]);

    const handleEditTask = (task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    };

    // Scroll restoration logic
    // Scroll restoration logic
    useEffect(() => {
        requestAnimationFrame(() => {
            const savedScroll = scrollPositions.current[activeTab] || 0;
            window.scrollTo(0, savedScroll);
        });
    }, [activeTab]);

    return (
        <div className="pt-1 sm:pt-4">
            {error && (
                <div className="mb-6 bg-red-50 border-l-4 border-red-500 p-4">
                    <p className="text-sm text-red-700">{error}</p>
                </div>
            )}

            <ManagerNotifications />

            {/* Tab Content */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
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
                            <option value="deadline-user">Pagal terminą-vartotoją</option>
                            <option value="user-priority">Pagal vartotoją-prioritetą</option>
                            <option value="manual">Rankiniu būdu</option>
                            {TASK_TAGS.map(tag => (
                                <option key={`sort-${tag}`} value={`tag-${tag}`}>Rūšiuoti: {tag}</option>
                            ))}
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
                                showReorderControls={sortBy === 'manual'}
                                onMoveUp={handleMoveUp}
                                onMoveDown={handleMoveDown}
                            />
                        ))}
                    </div>
                ) : (
                    <TaskTable
                        tasks={sortedTasks}
                        onEdit={handleEditTask}
                        role="manager"
                        showReorderControls={sortBy === 'manual'}
                        onMoveUp={handleMoveUp}
                        onMoveDown={handleMoveDown}
                    />
                )}
            </div>

            <div className={activeTab === 'my-tasks' ? 'block' : 'hidden'}>
                {/* Reuse worker view logic for "My Tasks" */}
                {(() => {
                    const myTasks = tasks.filter(t => t.assignedWorkerId === currentUser?.uid);
                    const filteredMyTasks = myTasks;
                    const sortedMyTasks = sortWorkerTasks(filteredMyTasks);

                    return (
                        <>
                            <div className="mb-6">
                                <DailyWorkProgress currentUser={currentUser} tasks={filterTasksByVisibility(filteredMyTasks)} />
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
            </div>

            <div className={activeTab === 'my-calendar' ? 'block' : 'hidden'}>
                <div className="w-full">
                    <WorkPlanner />
                </div>
            </div>

            <div className={activeTab === 'team-calendar' ? 'block' : 'hidden'}>
                <AllUsersCalendar />
            </div>

            <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                <div className="space-y-6">
                    <DailyStatistics currentUser={currentUser} userRole="manager" users={users} />
                    <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-200 text-center text-gray-500">
                        Pasirinkite "Užduotys" norėdami valdyti darbus
                    </div>
                    <div className="pt-8 border-t border-gray-200">
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">Archyvuotos užduotys</h3>
                        <TaskHistory />
                    </div>
                </div>
            </div>

            <div className={activeTab === 'my-reports' ? 'block' : 'hidden'}>
                <div className="space-y-6">
                    <DailyStatistics
                        currentUser={currentUser}
                        userRole="worker" // Force worker role to show only personal stats
                        users={[]}
                    />
                </div>
            </div>

            {userRole === 'admin' && (
                <div className={activeTab === 'users' ? 'block' : 'hidden'}>
                    <UserManagement />
                </div>
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
