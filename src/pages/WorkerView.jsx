import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, getDocs } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import WeeklyHoursSummary from '../components/WeeklyHoursSummary';
import WorkPlanner from '../components/WorkPlanner';
import AllUsersCalendar from '../components/AllUsersCalendar';

export default function WorkerView() {
    const { currentUser } = useAuth();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');
    const [activeTab, setActiveTab] = useState('tasks'); // 'tasks' or 'calendar'

    const [error, setError] = useState(null);

    // Define filter function before useEffect
    const filterTasksByVisibility = (tasks) => {
        const now = new Date();
        const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
        const hour = now.getHours();
        const minute = now.getMinutes();

        const dayMap = {
            0: 'Sekmadienis',
            1: 'Pirmadienis',
            2: 'Antradienis',
            3: 'Trečiadienis',
            4: 'Ketvirtadienis',
            5: 'Penktadienis',
            6: 'Šeštadienis'
        };

        const currentDayName = dayMap[dayOfWeek];

        // Sunday 19:20 reset logic
        if (dayOfWeek === 0 && (hour > 19 || (hour === 19 && minute >= 20))) {
            // Show only upcoming week (Mon-Sun) + Nepriskirta
            return tasks.filter(task => {
                if (task.dayOfWeek === 'Nepriskirta') return true;
                // All days of the week are "upcoming" after Sunday reset
                return true;
            });
        }

        // Regular filtering
        return tasks.filter(task => {
            if (task.dayOfWeek === 'Nepriskirta') return true;

            // Get the day index for the task
            const taskDayIndex = Object.keys(dayMap).find(key => dayMap[key] === task.dayOfWeek);
            if (taskDayIndex === undefined) return true;

            const taskDay = parseInt(taskDayIndex);

            // Show if task is today
            if (taskDay === dayOfWeek) return true;

            // Show if task is in the future (this week)
            if (taskDay > dayOfWeek) return true;

            // Show if task was yesterday and current time >= 19:30
            const yesterday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            if (taskDay === yesterday && (hour > 19 || (hour === 19 && minute >= 30))) return true;

            // Show if task is from a past day (but not future after Sunday reset)
            if (taskDay < dayOfWeek) return true;

            return false;
        });
    };

    useEffect(() => {
        if (!currentUser) return;

        let unsubscribe = () => { };

        try {
            const q = query(
                collection(db, 'tasks'),
                where('assignedWorkerId', '==', currentUser.uid)
            );

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

                // Apply visibility filtering based on day of week and time
                tasksData = filterTasksByVisibility(tasksData);

                // Sort by completion status and createdAt
                tasksData.sort((a, b) => {
                    // Incomplete tasks first
                    if (a.completed !== b.completed) {
                        return a.completed ? 1 : -1;
                    }
                    // Within same completion status, sort by createdAt (newest first for incomplete, by completedAt for completed)
                    if (a.completed) {
                        const dateA = a.completedAt ? new Date(a.completedAt) : new Date(0);
                        const dateB = b.completedAt ? new Date(b.completedAt) : new Date(0);
                        return dateB - dateA;
                    } else {
                        const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
                        const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
                        return dateB - dateA;
                    }
                });

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

        // Set up interval to re-filter tasks every minute (to handle time-based visibility changes)
        const filterInterval = setInterval(() => {
            setTasks(currentTasks => {
                const filtered = filterTasksByVisibility(currentTasks);
                // Sort again
                filtered.sort((a, b) => {
                    if (a.completed !== b.completed) {
                        return a.completed ? 1 : -1;
                    }
                    if (a.completed) {
                        const dateA = a.completedAt ? new Date(a.completedAt) : new Date(0);
                        const dateB = b.completedAt ? new Date(b.completedAt) : new Date(0);
                        return dateB - dateA;
                    } else {
                        const dateA = a.createdAt ? new Date(a.createdAt) : new Date(0);
                        const dateB = b.createdAt ? new Date(b.createdAt) : new Date(0);
                        return dateB - dateA;
                    }
                });
                return filtered;
            });
        }, 60000); // Every minute

        return () => {
            unsubscribe();
            window.removeEventListener('resize', handleResize);
            clearInterval(filterInterval);
        };
    }, [currentUser]);

    const handleEditTask = (task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    };

    return (
        <div>
            <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-900">Mano užduotys</h2>
                {error && (
                    <div className="mt-4 bg-red-50 border-l-4 border-red-500 p-4">
                        <p className="text-sm text-red-700">{error}</p>
                    </div>
                )}
            </div>

            {/* Tab Navigation */}
            <div className="mb-6 border-b border-gray-200">
                <nav className="-mb-px flex space-x-8">
                    <button
                        onClick={() => setActiveTab('tasks')}
                        className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === 'tasks'
                            ? 'border-blue-500 text-blue-600'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        Užduotys
                    </button>
                    <button
                        onClick={() => setActiveTab('calendar')}
                        className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === 'calendar'
                            ? 'border-blue-500 text-blue-600'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        Mano kalendorius
                    </button>
                    <button
                        onClick={() => setActiveTab('team-calendar')}
                        className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${activeTab === 'team-calendar'
                            ? 'border-blue-500 text-blue-600'
                            : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                            }`}
                    >
                        Komandos kalendorius
                    </button>
                </nav>
            </div>

            {/* Tasks Tab */}
            {activeTab === 'tasks' && (
                <>
                    <WeeklyHoursSummary />

                    {tasks.length === 0 ? (
                        <div className="text-center py-12 bg-white rounded-xl shadow-sm border border-gray-200">
                            <p className="text-gray-500">Jums dar nepriskirta jokių užduočių.</p>
                        </div>
                    ) : viewMode === 'mobile' ? (
                        <div className="space-y-4">
                            {tasks.map(task => (
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
                            tasks={tasks}
                            onEdit={handleEditTask}
                            role="worker"
                        />
                    )}
                </>
            )}

            {/* Calendar Tab */}
            {activeTab === 'calendar' && (
                <WorkPlanner />
            )}

            {/* Team Calendar Tab */}
            {activeTab === 'team-calendar' && (
                <AllUsersCalendar />
            )}

            {isModalOpen && (
                <TaskModal
                    isOpen={isModalOpen}
                    onClose={() => setIsModalOpen(false)}
                    task={editingTask}
                    role="worker"
                />
            )}
        </div>
    );
}
