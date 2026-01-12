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
import DailyStatsHeader from '../components/DailyStatsHeader';
import { filterTasksByVisibility, sortWorkerTasks } from '../utils/taskUtils';
import DailyStatistics from '../components/DailyStatistics';
import { History, Plus } from 'lucide-react';

import { useNavigation } from '../context/NavigationContext';

export default function WorkerView() {
    const { currentUser } = useAuth();
    const { activeTab } = useNavigation();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');

    const [error, setError] = useState(null);


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
                            : null,
                        creatorName: task.creatorName || (task.createdBy && usersMap[task.createdBy]
                            ? usersMap[task.createdBy].displayName || usersMap[task.createdBy].email
                            : null)
                    }));
                } catch (err) {
                    console.error("Error fetching user names:", err);
                }

                // Apply visibility filtering based on day of week and time
                tasksData = filterTasksByVisibility(tasksData);

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

        // Set up interval to re-filter tasks every minute (to handle time-based visibility changes)
        const filterInterval = setInterval(() => {
            setTasks(currentTasks => {
                const filtered = filterTasksByVisibility(currentTasks);
                return sortWorkerTasks(filtered);
            });
        }, 60000); // Every minute

        return () => {
            unsubscribe();
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('open-task-modal', handleOpenTaskModal);
            clearInterval(filterInterval);
        };
    }, [currentUser]);

    const handleEditTask = (task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    };

    return (
        <div className="pt-1">
            <div className="mb-2 sm:mb-6">
                {error && (
                    <div className="mt-4 bg-red-50 border-l-4 border-red-500 p-4">
                        <p className="text-sm text-red-700">{error}</p>
                    </div>
                )}
            </div>


            {/* Tasks Tab */}
            {activeTab === 'tasks' && (
                <>
                    <div className="flex justify-between items-center mb-4 sm:mb-6">
                        <h2 className="text-xl font-bold text-gray-900 hidden sm:block">Mano užduotys</h2>
                    </div>

                    <DailyStatsHeader currentUser={currentUser} />

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
                <div className="w-full">
                    <WorkPlanner />
                </div>
            )}

            {/* Team Calendar Tab */}
            {activeTab === 'team-calendar' && (
                <AllUsersCalendar />
            )}

            {activeTab === 'reports' && (
                <DailyStatistics
                    currentUser={currentUser}
                    userRole="worker"
                    users={[]} // Workers don't see other users
                />
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
