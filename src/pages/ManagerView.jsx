import React, { useState, useEffect } from 'react';
import { ArrowUpDown, Filter, Search } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import CombinedHoursSummary from '../components/CombinedHoursSummary';
import ActiveWorkSessions from '../components/ActiveWorkSessions';
import DailyStatistics from '../components/DailyStatistics';
import DailyWorkProgress from '../components/DailyWorkProgress';
import ManagerNotifications from '../components/ManagerNotifications';
import CalendarRequestStatusBanner from '../components/CalendarRequestStatusBanner';
import ErrorBoundary from '../components/ErrorBoundary';
import { Spinner } from '../components/ui/Loading';
import { useAuth } from '../context/AuthContext';

import { useNavigation } from '../context/NavigationContext';

import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { PRIORITIES, getPriorityLabel } from '../utils/priority';

import { useTaskTimeMonitor } from '../hooks/useTaskTimeMonitor';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import { useManagerData } from '../hooks/useManagerData';
import { useTaskFiltering } from '../hooks/useTaskFiltering';

// Shared with WorkerView: the calendar/report views are the heavy part of the bundle
// (react-big-calendar + date-fns + reports aggregation). Lazy-loading them in BOTH views
// is what actually keeps the code out of the eager shared chunk — a static import in
// either view would re-hoist it. Suspense streams each one in when its tab mounts.
const AllUsersCalendar = React.lazy(() => import('../components/AllUsersCalendar'));
const WorkPlanner = React.lazy(() => import('../components/WorkPlanner'));
const Reports = React.lazy(() => import('../components/Reports'));

export default function ManagerView() {
    const { userRole, currentUser } = useAuth();
    const { activeTab, scrollPositions } = useNavigation();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');

    // Use custom hooks
    const { tasks, users, allUsers, manualTaskOrder, saveManualOrder, error } = useManagerData(currentUser);
    const {
        sortedTasks,
        filterUser, setFilterUser,
        filterPriority, setFilterPriority,
        filterTag, setFilterTag,
        searchText, setSearchText,
        sortBy, setSortBy
    } = useTaskFiltering(tasks, manualTaskOrder);

    // Task time monitoring — 80% warning and 100% limit for manager's own tasks
    const { warningPopup, limitPopup, dismissWarning, dismissLimit } = useTaskTimeMonitor(tasks);

    const handleMoveUp = React.useCallback((taskId) => {
        const currentList = [...sortedTasks];
        const index = currentList.findIndex(t => t.id === taskId);
        if (index > 0) {
            const temp = currentList[index];
            currentList[index] = currentList[index - 1];
            currentList[index - 1] = temp;
            const newOrder = currentList.map(t => t.id);
            saveManualOrder(newOrder);
        }
    }, [sortedTasks, saveManualOrder]);

    const handleMoveDown = React.useCallback((taskId) => {
        const currentList = [...sortedTasks];
        const index = currentList.findIndex(t => t.id === taskId);
        if (index < currentList.length - 1) {
            const temp = currentList[index];
            currentList[index] = currentList[index + 1];
            currentList[index + 1] = temp;
            const newOrder = currentList.map(t => t.id);
            saveManualOrder(newOrder);
        }
    }, [sortedTasks, saveManualOrder]);

    useEffect(() => {
        // Simple responsive check
        const handleResize = () => {
            setViewMode(window.innerWidth < 768 ? 'mobile' : 'desktop');
        };

        window.addEventListener('resize', handleResize);
        handleResize(); // Initial check

        const handleOpenModalEvent = () => {
            setEditingTask(null);
            setIsModalOpen(true);
        };
        window.addEventListener('open-task-modal', handleOpenModalEvent);

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('open-task-modal', handleOpenModalEvent);
        };
    }, []);

    const handleEditTask = React.useCallback((task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    }, []);

    // Scroll restoration logic
    useEffect(() => {
        requestAnimationFrame(() => {
            const savedScroll = scrollPositions.current[activeTab] || 0;
            window.scrollTo(0, savedScroll);
        });
    }, [activeTab, scrollPositions]);

    return (
        <div className="pt-1 sm:pt-4">
            {error && (
                <div className="mb-6 bg-red-50 border-l-4 border-feedback-danger p-4" role="alert">
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            <ManagerNotifications onEditAndApprove={handleEditTask} />
            <CalendarRequestStatusBanner />

            {/* Tab Content */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <CombinedHoursSummary />
                <ActiveWorkSessions />



                {/* Filter and Sort Controls */}
                <div className="flex flex-wrap gap-3 mb-4 items-center justify-between">
                    {/* Filters */}
                    <div className="flex flex-wrap gap-2 items-center">
                        <div className="relative">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <input
                                type="search"
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                placeholder="Ieškoti užduočių…"
                                aria-label="Ieškoti užduočių"
                                className="pl-10 pr-4 py-2 border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            />
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <select
                                value={filterUser}
                                onChange={(e) => setFilterUser(e.target.value)}
                                aria-label="Filtruoti pagal darbuotoją"
                                className="pl-10 pr-4 py-2 border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <select
                                value={filterPriority}
                                onChange={(e) => setFilterPriority(e.target.value)}
                                aria-label="Filtruoti pagal prioritetą"
                                className="pl-10 pr-4 py-2 border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            >
                                <option value="">Visi prioritetai</option>
                                <option value={PRIORITIES.URGENT}>{getPriorityLabel(PRIORITIES.URGENT)}</option>
                                <option value={PRIORITIES.HIGH}>{getPriorityLabel(PRIORITIES.HIGH)}</option>
                                <option value={PRIORITIES.MEDIUM}>{getPriorityLabel(PRIORITIES.MEDIUM)}</option>
                                <option value={PRIORITIES.LOW}>{getPriorityLabel(PRIORITIES.LOW)}</option>
                                <option value={PRIORITIES.VERY_LOW}>{getPriorityLabel(PRIORITIES.VERY_LOW)}</option>
                            </select>
                        </div>
                        <div className="relative">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                            <select
                                value={filterTag}
                                onChange={(e) => setFilterTag(e.target.value)}
                                aria-label="Filtruoti pagal žymę"
                                className="pl-10 pr-4 py-2 border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            >
                                <option value="">Visi Tagai</option>
                                {TASK_TAGS.map(tag => (
                                    <option key={`filter-${tag}`} value={tag}>{tag}</option>
                                ))}
                            </select>
                        </div>
                    </div>

                    {/* Sort dropdown */}
                    <div className="relative">
                        <ArrowUpDown className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted" aria-hidden="true" />
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            aria-label="Rūšiuoti užduotis"
                            className="pl-10 pr-4 py-2 border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <option value="none">Numatyta tvarka</option>
                            <option value="status">Pagal būseną</option>
                            <option value="priority">Pagal prioritetą</option>
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
                        hideCheckboxes={true}
                    />
                )}
            </div>

            <div className={activeTab === 'my-tasks' ? 'block' : 'hidden'}>
                {/* Reuse worker view logic for "My Tasks" */}
                {(() => {
                    const myTasks = tasks.filter(t => t.assignedUserId === currentUser?.uid);
                    const filteredMyTasks = myTasks;
                    const sortedMyTasks = sortWorkerTasks(filteredMyTasks);

                    return (
                        <>
                            <div className="mb-6">
                                <DailyWorkProgress currentUser={currentUser} tasks={filterTasksByVisibility(filteredMyTasks)} />
                            </div>
                            {sortedMyTasks.length === 0 ? (
                                <div className="text-center py-12 bg-surface-card rounded-card shadow-sm border border-line">
                                    <p className="text-body text-ink-muted">Jums dar nepriskirta jokių užduočių.</p>
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
                                    hideCheckboxes={true}
                                />
                            )}
                        </>
                    );
                })()}
            </div>

            <div className={activeTab === 'my-calendar' ? 'block' : 'hidden'}>
                <div className="w-full">
                    <ErrorBoundary boundaryName="manager:my-calendar" resetKeys={[activeTab]}>
                        <React.Suspense fallback={<Spinner />}>
                            <WorkPlanner />
                        </React.Suspense>
                    </ErrorBoundary>
                </div>
            </div>

            <div className={activeTab === 'team-calendar' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="manager:team-calendar" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        <AllUsersCalendar />
                    </React.Suspense>
                </ErrorBoundary>
            </div>

            <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="manager:reports" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        <Reports users={allUsers || users} />
                    </React.Suspense>
                </ErrorBoundary>
            </div>

            <div className={activeTab === 'my-reports' ? 'block' : 'hidden'}>
                <div className="space-y-6">
                    <ErrorBoundary boundaryName="manager:my-reports" resetKeys={[activeTab]}>
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole="worker" // Force worker role to show only personal stats
                            users={[]}
                        />
                    </ErrorBoundary>
                </div>
            </div>

            {userRole === 'admin' && (
                <div className={activeTab === 'users' ? 'block' : 'hidden'}>
                    <ErrorBoundary boundaryName="manager:users" resetKeys={[activeTab]}>
                        <UserManagement />
                    </ErrorBoundary>
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

