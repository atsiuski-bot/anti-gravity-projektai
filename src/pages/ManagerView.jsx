import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, query, orderBy, getDocs, doc, getDoc, setDoc, where, updateDoc } from 'firebase/firestore';
import { Plus, Users, LayoutDashboard, CheckSquare, Layout, Calendar as CalendarIcon, Users as UsersIcon, ListTodo, ArrowUpDown, History, UserCheck, Filter } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import CombinedHoursSummary from '../components/CombinedHoursSummary';
import AllUsersCalendar from '../components/AllUsersCalendar';
import WorkPlanner from '../components/WorkPlanner';
import TaskHistory from '../components/TaskHistory';
import Reports from '../components/Reports';
import DailyStatistics from '../components/DailyStatistics';
import DailyWorkProgress from '../components/DailyWorkProgress';
import ManagerNotifications from '../components/ManagerNotifications';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';

import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { getPriorityRank, PRIORITIES, getPriorityLabel } from '../utils/priority';

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
    const [filterUser, setFilterUser] = useState('');
    const [filterPriority, setFilterPriority] = useState('');

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
                            ? (usersMap[task.assignedWorkerId].displayName || usersMap[task.assignedWorkerId].email)
                            : null,
                        assignedWorkerColor: task.assignedWorkerId && usersMap[task.assignedWorkerId]
                            ? (usersMap[task.assignedWorkerId].color || null)
                            : null,
                        creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
                            ? (usersMap[task.createdBy].displayName || usersMap[task.createdBy].email)
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

    const formatDisplayName = (name) => {
        if (!name) return 'Nežinomas';
        return name.split('@')[0];
    };

    // Sort tasks based on selected criteria
    const sortedTasks = React.useMemo(() => {
        // Filter out completed, deleted, and unapproved tasks
        let activeTasks = tasks.filter(t =>
            !t.completed &&
            !t.isDeleted &&
            t.status !== 'deleted' &&
            t.status !== 'unapproved' &&
            t.status !== 'confirmed'
        );

        // Apply user filter
        if (filterUser) {
            activeTasks = activeTasks.filter(t => t.assignedWorkerId === filterUser);
        }

        // Apply priority filter
        if (filterPriority) {
            activeTasks = activeTasks.filter(t => t.priority === filterPriority);
        }

        if (sortBy === 'none') return activeTasks;


        const comparePriority = (a, b) => {
            const rankA = getPriorityRank(a.priority);
            const rankB = getPriorityRank(b.priority);
            return rankB - rankA; // Descending rank (Urgent > Low)
        };

        const sorted = [...activeTasks];


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
    }, [tasks, sortBy, manualTaskOrder, filterUser, filterPriority]);

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

                {/* Unapproved Tasks Section */}
                {(() => {
                    const unapprovedTasks = tasks.filter(t =>
                        t.status === 'unapproved' &&
                        (t.taskManager === currentUser.uid || t.managerId === currentUser.uid)
                    );

                    const handleApproveTask = async (task) => {
                        try {
                            await updateDoc(doc(db, 'tasks', task.id), {
                                status: 'active',
                                approvedAt: new Date().toISOString(),
                                approvedBy: currentUser.uid,
                                updatedAt: new Date().toISOString()
                            });
                        } catch (err) {
                            console.error('Error approving task:', err);
                            alert('Klaida patvirtinant užduotį: ' + err.message);
                        }
                    };

                    if (unapprovedTasks.length === 0) return null;

                    return (
                        <div className="mb-6 bg-amber-50 border-2 border-amber-200 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <UserCheck className="w-5 h-5 text-amber-600" />
                                <h3 className="text-lg font-bold text-amber-900">
                                    Laukia patvirtinimo ({unapprovedTasks.length})
                                </h3>
                            </div>
                            <div className="space-y-3">
                                {unapprovedTasks.map(task => {
                                    const worker = users.find(u => u.id === task.assignedWorkerId);
                                    const workerName = worker ? (worker.displayName || worker.email) : task.assignedWorkerName || 'Nežinomas';

                                    return (
                                        <div key={task.id} className="bg-white rounded-lg p-4 border border-amber-200">
                                            <div className="flex items-start justify-between gap-3">
                                                <div className="flex-1">
                                                    <h4 className="font-bold text-gray-900">{task.title}</h4>
                                                    {task.description && (
                                                        <p className="text-sm text-gray-600 mt-1">{task.description}</p>
                                                    )}
                                                    <div className="flex flex-wrap gap-2 mt-2 text-xs text-gray-500">
                                                        <span>Darbuotojas: <span className="font-medium">{formatDisplayName(workerName)}</span></span>
                                                        {task.estimatedTime && <span>• Planuojamas: {task.estimatedTime}</span>}
                                                        {task.priority && <span>• Prioritetas: {task.priority}</span>}
                                                        {task.deadline && <span>• Terminas: {task.deadline}</span>}
                                                    </div>
                                                </div>
                                                <button
                                                    onClick={() => handleApproveTask(task)}
                                                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors font-medium text-sm whitespace-nowrap flex items-center gap-2"
                                                >
                                                    <CheckSquare className="w-4 h-4" />
                                                    Patvirtinti
                                                </button>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}

                {/* Filter and Sort Controls */}
                <div className="flex flex-wrap gap-3 mb-4 items-center justify-between">
                    {/* Filters */}
                    <div className="flex flex-wrap gap-2 items-center">
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <select
                                value={filterUser}
                                onChange={(e) => setFilterUser(e.target.value)}
                                className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                            >
                                <option value="">Visi darbuotojai</option>
                                {users.map(user => (
                                    <option key={user.id} value={user.id}>
                                        {user.displayName || user.email}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <select
                                value={filterPriority}
                                onChange={(e) => setFilterPriority(e.target.value)}
                                className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                            >
                                <option value="">Visi prioritetai</option>
                                <option value={PRIORITIES.URGENT}>{getPriorityLabel(PRIORITIES.URGENT)}</option>
                                <option value={PRIORITIES.HIGH}>{getPriorityLabel(PRIORITIES.HIGH)}</option>
                                <option value={PRIORITIES.MEDIUM}>{getPriorityLabel(PRIORITIES.MEDIUM)}</option>
                                <option value={PRIORITIES.LOW}>{getPriorityLabel(PRIORITIES.LOW)}</option>
                                <option value={PRIORITIES.VERY_LOW}>{getPriorityLabel(PRIORITIES.VERY_LOW)}</option>
                            </select>
                        </div>
                    </div>

                    {/* Sort dropdown */}
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
                <DailyStatistics
                    currentUser={currentUser}
                    userRole={userRole}
                    users={users}
                />
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
