import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';

import WorkPlanner from '../components/WorkPlanner';
import AllUsersCalendar from '../components/AllUsersCalendar';
import DailyWorkProgress from '../components/DailyWorkProgress';
import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { getPriorityRank } from '../utils/priority';
import Reports from '../components/Reports';
import { getLithuanianDateString, getLithuanian3AMCutoff } from '../utils/timeUtils';
import { Filter } from 'lucide-react';
import { useTaskTimeMonitor } from '../hooks/useTaskTimeMonitor';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import CalendarRequestStatusBanner from '../components/CalendarRequestStatusBanner';

import { useNavigation } from '../context/NavigationContext';


export default function WorkerView() {
    const { currentUser, userRole } = useAuth();
    const { usersMap, loading: usersLoading } = useUsers();
    const { activeTab, scrollPositions } = useNavigation();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');

    const [error, setError] = useState(null);

    // Task time monitoring — 80% warning and 100% limit
    const { warningPopup, limitPopup, dismissWarning, dismissLimit } = useTaskTimeMonitor(tasks);


    useEffect(() => {
        if (!currentUser || usersLoading) return;

        let unsubscribe = () => { };

        try {
            const q = query(
                collection(db, 'tasks'),
                where('assignedUserId', '==', currentUser.uid)
            );

            unsubscribe = onSnapshot(q, (snapshot) => {
                let tasksData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));

                // Enrich tasks with worker names
                tasksData = tasksData.map(task => ({
                    ...task,
                    assignedUserName: task.assignedUserId && usersMap[task.assignedUserId]
                        ? usersMap[task.assignedUserId].displayName || usersMap[task.assignedUserId].email
                        : null,
                    assignedWorkerColor: task.assignedUserId && usersMap[task.assignedUserId]
                        ? usersMap[task.assignedUserId].color || null
                        : null,
                    creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
                        ? usersMap[task.createdBy].displayName || usersMap[task.createdBy].email
                        : null)
                }));

                // Apply visibility filtering based on day of week and time
                tasksData = filterTasksByVisibility(tasksData);

                // Additional filter: only show done tasks from "Today's Work Day" (3AM - 3AM)
                const cutoff = getLithuanian3AMCutoff(getLithuanianDateString());

                tasksData = tasksData.filter(t => {
                    if (t.completed || t.status === 'completed' || t.status === 'confirmed') {
                        const finishedAt = t.completedAt || t.confirmedAt || t.updatedAt;
                        if (!finishedAt) return false;
                        return new Date(finishedAt) >= cutoff;
                    }
                    return true;
                });

                // Sort by Day -> Priority
                tasksData = sortWorkerTasks(tasksData);

                setTasks(tasksData);
                setError(null);
            }, (err) => {
                console.error("Error fetching worker tasks:", err);
                setError("Nepavyko užkrauti užduočių. Bandykite vėliau.");
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
        }

        const handleResize = () => {
            setViewMode(window.innerWidth < 768 ? 'mobile' : 'desktop');
        };

        window.addEventListener('resize', handleResize);
        handleResize();

        const handleOpenTaskModal = () => {
            setEditingTask(null);
            setIsModalOpen(true);
        };
        window.addEventListener('open-task-modal', handleOpenTaskModal);

        const filterInterval = setInterval(() => {
            setTasks(currentTasks => {
                const filtered = filterTasksByVisibility(currentTasks);
                const newlySorted = sortWorkerTasks(filtered);

                // Only update state if length or order changed
                if (currentTasks.length !== newlySorted.length) return newlySorted;
                for (let i = 0; i < currentTasks.length; i++) {
                    if (currentTasks[i].id !== newlySorted[i].id) return newlySorted;
                }
                return currentTasks; // No change, prevent re-render
            });
        }, 60000); // Every minute

        return () => {
            unsubscribe();
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('open-task-modal', handleOpenTaskModal);
            clearInterval(filterInterval);
        };
    }, [currentUser, usersLoading, usersMap]);

    const handleEditTask = React.useCallback((task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    }, []);

    // Sorting and filtering state
    const [sortBy, setSortBy] = useState('none');
    const [filterTag, setFilterTag] = useState('');

    // Scroll restoration logic
    useEffect(() => {
        requestAnimationFrame(() => {
            const savedScroll = scrollPositions.current[activeTab] || 0;
            window.scrollTo(0, savedScroll);
        });
    }, [activeTab, scrollPositions]);

    const sortedTasks = useMemo(() => {
        let result = [...tasks];

        if (filterTag) {
            result = result.filter(t => t.tag === filterTag);
        }

        if (sortBy === 'status') {
            result.sort((a, b) => {
                const getStatusRank = (task) => {
                    const status = task.status || 'pending';
                    if (status === 'in-progress') return 1;
                    if (status === 'pending') return 2;
                    if (status === 'unapproved') return 3;
                    if (status === 'completed') return 4;
                    if (status === 'confirmed') return 5;
                    return 6;
                };
                const rankA = getStatusRank(a);
                const rankB = getStatusRank(b);
                if (rankA !== rankB) return rankA - rankB;

                // Within same status, sort by priority
                const prioA = getPriorityRank(a.priority);
                const prioB = getPriorityRank(b.priority);
                return prioB - prioA;
            });
        } else if (sortBy === 'priority') {
            result.sort((a, b) => {
                const prioA = getPriorityRank(a.priority);
                const prioB = getPriorityRank(b.priority);
                return prioB - prioA;
            });
        }

        return result;
    }, [tasks, sortBy, filterTag]);

    return (
        <div className="pt-1">
            <div className="mb-2 sm:mb-6">
                {error && (
                    <div className="mt-4 bg-red-50 border-l-4 border-red-500 p-4">
                        <p className="text-sm text-red-700">{error}</p>
                    </div>
                )}
            </div>
            
            <div className="mb-6">
                <CalendarRequestStatusBanner />
            </div>


            {/* Tasks Tab */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4 sm:mb-6">
                    <h2 className="text-xl font-bold text-gray-900 hidden sm:block">Mano užduotys</h2>

                    {/* Sort dropdown */}
                    <div className="relative w-full sm:w-auto flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value)}
                                className="w-full sm:w-auto pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                            >
                                <option value="none">Numatyta tvarka</option>
                                <option value="status">Pagal būseną</option>
                                <option value="priority">Pagal prioritetą</option>
                            </select>
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" />
                            <select
                                value={filterTag}
                                onChange={(e) => setFilterTag(e.target.value)}
                                className="w-full sm:w-auto pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 bg-white"
                            >
                                <option value="">Visi Tagai</option>
                                {TASK_TAGS.map(tag => (
                                    <option key={`filter-${tag}`} value={tag}>{tag}</option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>

                <DailyWorkProgress currentUser={currentUser} tasks={sortedTasks} />


                {sortedTasks.length === 0 ? (
                    <div className="text-center py-12 bg-white rounded-xl shadow-sm border border-gray-200">
                        <p className="text-gray-500">Jums dar nepriskirta jokių užduočių.</p>
                    </div>
                ) : viewMode === 'mobile' ? (
                    <div className="space-y-4">
                        {sortedTasks.map(task => (
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
                        tasks={sortedTasks}
                        onEdit={handleEditTask}
                        role="worker"
                        hideCheckboxes={true}
                    />
                )}
            </div>

            {/* Calendar Tab */}
            <div className={activeTab === 'calendar' ? 'block' : 'hidden'}>
                <div className="w-full">
                    <WorkPlanner />
                </div>
            </div>

            {/* Team Calendar Tab */}
            <div className={activeTab === 'team-calendar' ? 'block' : 'hidden'}>
                <AllUsersCalendar />
            </div>

            <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                <Reports users={[currentUser]} />
            </div>

            {isModalOpen && (
                <TaskModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    task={editingTask}
                    role={userRole || "worker"}
                />
            )}

            {/* Time monitoring popups */}
            {warningPopup && (
                <TaskTimeWarningPopup
                    task={warningPopup.task}
                    remaining={warningPopup.remaining}
                    onDismiss={dismissWarning}
                />
            )}
            {limitPopup && (
                <TaskTimeLimitPopup
                    task={limitPopup.task}
                    estimatedTime={limitPopup.estimatedTime}
                    actualMinutes={limitPopup.actualMinutes}
                    onDismiss={dismissLimit}
                />
            )}
        </div>
    );
}

