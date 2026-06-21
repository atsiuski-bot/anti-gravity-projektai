import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';

import DailyWorkProgress from '../components/DailyWorkProgress';
import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { getPriorityRank } from '../utils/priority';
import { Spinner } from '../components/ui/Loading';
import { getLithuanianDateString, getLithuanian3AMCutoff } from '../utils/timeUtils';
import { logError } from '../utils/errorLog';
import { Filter, AlertCircle, ClipboardList } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import ErrorBoundary from '../components/ErrorBoundary';
import { useTaskTimeMonitor } from '../hooks/useTaskTimeMonitor';
import { useOrphanedTaskRecovery } from '../hooks/useOrphanedTaskRecovery';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import CalendarRequestStatusBanner from '../components/CalendarRequestStatusBanner';

import { useNavigation } from '../context/NavigationContext';

// The calendar/report views pull in react-big-calendar + date-fns + the reports
// aggregation — heavy code the worker's primary path (the tasks tab) never needs to
// render. Splitting them into their own chunks keeps that code out of the eagerly
// loaded view bundle; Suspense streams each one in when its tab mounts.
const WorkPlanner = React.lazy(() => import('../components/WorkPlanner'));
const AllUsersCalendar = React.lazy(() => import('../components/AllUsersCalendar'));
const Reports = React.lazy(() => import('../components/Reports'));

export default function WorkerView() {
    const { currentUser, userRole } = useAuth();
    const { usersMap, loading: usersLoading } = useUsers();
    const { activeTab, scrollPositions } = useNavigation();
    const [tasks, setTasks] = useState([]);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);

    const [error, setError] = useState(null);

    // Task time monitoring — 80% warning and 100% limit
    const { warningPopup, limitPopup, dismissWarning, dismissLimit } = useTaskTimeMonitor(tasks);

    // Crash/reload recovery — auto-pause any task left "running" across a restart so
    // it cannot credit hours of ghost time on the next pause.
    useOrphanedTaskRecovery(tasks);


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
                logError(err, { source: 'onSnapshot:workerTasks' });
                setError("Nepavyko užkrauti užduočių. Bandykite vėliau.");
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
        }

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
                    <div className="mt-4 flex items-start gap-2 rounded-card border-l-4 border-feedback-danger bg-red-50 p-4" role="alert">
                        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-body text-feedback-danger">{error}</p>
                    </div>
                )}
            </div>
            
            <div className="mb-6">
                <CalendarRequestStatusBanner />
            </div>


            {/* Tasks Tab */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4 sm:mb-6">
                    <h2 className="text-h2 font-bold text-ink-strong">Mano užduotys</h2>

                    {/* Sort dropdown */}
                    <div className="relative w-full sm:w-auto flex flex-col sm:flex-row space-y-2 sm:space-y-0 sm:space-x-2">
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <select
                                value={sortBy}
                                onChange={(e) => setSortBy(e.target.value)}
                                aria-label="Rūšiuoti pagal"
                                className="w-full sm:w-auto min-h-touch pl-10 pr-4 py-2 border border-line rounded-input text-body-lg text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            >
                                <option value="none">Numatyta tvarka</option>
                                <option value="status">Pagal būseną</option>
                                <option value="priority">Pagal prioritetą</option>
                            </select>
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <select
                                value={filterTag}
                                onChange={(e) => setFilterTag(e.target.value)}
                                aria-label="Filtruoti pagal žymę"
                                className="w-full sm:w-auto min-h-touch pl-10 pr-4 py-2 border border-line rounded-input text-body-lg text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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
                    <div className="rounded-card border border-line bg-surface-card shadow-sm">
                        <EmptyState
                            icon={ClipboardList}
                            title="Nėra užduočių"
                            description="Jums dar nepriskirta jokių užduočių."
                            action={
                                <Button
                                    variant="primary"
                                    onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                                >
                                    Sukurti užduotį
                                </Button>
                            }
                        />
                    </div>
                ) : (
                    <>
                        {/* Mobile: card stack — actions always visible (no group-hover) */}
                        <div className="space-y-4 md:hidden">
                            {sortedTasks.map(task => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    onEdit={() => handleEditTask(task)}
                                    role="worker"
                                />
                            ))}
                        </div>
                        {/* Desktop: denser table */}
                        <div className="hidden md:block">
                            <TaskTable
                                tasks={sortedTasks}
                                onEdit={handleEditTask}
                                role="worker"
                                hideCheckboxes={true}
                            />
                        </div>
                    </>
                )}
            </div>

            {/* Calendar Tab */}
            <div className={activeTab === 'calendar' ? 'block' : 'hidden'}>
                <div className="w-full">
                    <ErrorBoundary boundaryName="worker:calendar" resetKeys={[activeTab]}>
                        <React.Suspense fallback={<Spinner />}>
                            <WorkPlanner />
                        </React.Suspense>
                    </ErrorBoundary>
                </div>
            </div>

            {/* Team Calendar Tab */}
            <div className={activeTab === 'team-calendar' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="worker:team-calendar" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        <AllUsersCalendar />
                    </React.Suspense>
                </ErrorBoundary>
            </div>

            <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="worker:reports" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        <Reports users={[currentUser]} />
                    </React.Suspense>
                </ErrorBoundary>
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

