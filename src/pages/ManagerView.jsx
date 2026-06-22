import React, { useState, useEffect } from 'react';
import { ArrowUpDown, Filter, Search, ChevronDown, X, Activity, ListChecks } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import CombinedHoursSummary from '../components/CombinedHoursSummary';
import ActiveWorkSessions from '../components/ActiveWorkSessions';
import DailyWorkProgress from '../components/DailyWorkProgress';
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
import { scopeRoster } from '../utils/teamScope';
import { cn } from '../utils/cn';

// Shared with WorkerView: the calendar/report views are the heavy part of the bundle
// (react-big-calendar + date-fns + reports aggregation). Lazy-loading them in BOTH views
// is what actually keeps the code out of the eager shared chunk — a static import in
// either view would re-hoist it. Suspense streams each one in when its tab mounts.
const AllUsersCalendar = React.lazy(() => import('../components/AllUsersCalendar'));
const WorkPlanner = React.lazy(() => import('../components/WorkPlanner'));
const Reports = React.lazy(() => import('../components/Reports'));

export default function ManagerView() {
    const { userRole, currentUser, userData } = useAuth();
    const { activeTab, scrollPositions } = useNavigation();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');
    // Komandos darbai splits into two sub-tabs: live activity first, the task list second.
    const [teamTasksSubTab, setTeamTasksSubTab] = useState('active');

    // Use custom hooks
    const { tasks, ownTasks, users, allUsers, manualTaskOrder, saveManualOrder, error } = useManagerData(currentUser);
    // A scoped manager's pickers/reports must only offer their own team; admins & unscoped
    // managers see everyone. (Data rows are already team-scoped by the listeners; this narrows
    // the people you can FILTER/SELECT so no one outside the team is even named.)
    const pickerUsers = scopeRoster(users, userData, currentUser?.uid);
    const reportRoster = scopeRoster(allUsers || users, userData, currentUser?.uid);
    const {
        sortedTasks,
        filterUser, setFilterUser,
        filterPriority, setFilterPriority,
        filterTag, setFilterTag,
        searchText, setSearchText,
        sortBy, setSortBy
    } = useTaskFiltering(tasks, manualTaskOrder);

    // Task time monitoring — 80% warning and 100% limit for manager's own tasks (ownTasks, so a
    // scoped manager whose team listener excludes their own rows is still monitored correctly).
    const { warningPopup, limitPopup, dismissWarning, dismissLimit } = useTaskTimeMonitor(ownTasks);

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

        const handleOpenModalEvent = (e) => {
            // A bare event opens a blank create modal; a `detail.task` (e.g. from the notification
            // bell's "edit & approve" / "open reverted task") opens that task for editing.
            setEditingTask(e?.detail?.task || null);
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
                <div className="mb-6 bg-feedback-danger-soft border-l-4 border-feedback-danger p-4" role="alert">
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {/* Tab Content — Komandos darbai splits into two sub-tabs:
                 1. Aktyvūs darbai   — live team activity (ActiveWorkSessions).
                 2. Užduočių sąrašas — the manageable task list + its filters.
                The weekly planned-vs-worked summary that used to head this tab now lives in
                Kom. kalendorius, next to the calendar it summarises. */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <div role="tablist" aria-label="Komandos darbų rodinys" className="mb-4">
                    <div className="flex w-full sm:inline-flex sm:w-auto overflow-hidden rounded-control border border-line bg-surface-sunken">
                        <button
                            type="button"
                            role="tab"
                            id="team-active-tab"
                            aria-selected={teamTasksSubTab === 'active'}
                            aria-controls="team-active-panel"
                            onClick={() => setTeamTasksSubTab('active')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                teamTasksSubTab === 'active' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
                            Aktyvūs darbai
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            id="team-list-tab"
                            aria-selected={teamTasksSubTab === 'list'}
                            aria-controls="team-list-panel"
                            onClick={() => setTeamTasksSubTab('list')}
                            className={cn(
                                'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                teamTasksSubTab === 'list' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />
                            Užduočių sąrašas
                        </button>
                    </div>
                </div>

                {/* Sub-tab 1 — Aktyvūs darbai */}
                <div
                    id="team-active-panel"
                    role="tabpanel"
                    aria-labelledby="team-active-tab"
                    className={cn(teamTasksSubTab !== 'active' && 'hidden')}
                >
                    <ActiveWorkSessions embedded />
                </div>

                {/* Sub-tab 2 — Užduočių sąrašas */}
                <div
                    id="team-list-panel"
                    role="tabpanel"
                    aria-labelledby="team-list-tab"
                    className={cn(teamTasksSubTab !== 'list' && 'hidden')}
                >
                {/* Filter and Sort Controls.
                    Mobile-first: search spans the full width, the three filters drop into a tidy
                    2-column grid, and sort takes the full width at the bottom — no more ragged
                    wrapping. From lg+ everything collapses back to one inline row, sort pushed
                    to the right. Every control fills its cell (w-full) so tap targets are wide. */}
                {(() => {
                    const hasActiveFilters = !!(searchText || filterUser || filterPriority || filterTag);
                    const FILTER_FIELD =
                        'w-full pl-10 pr-8 py-2.5 border border-line rounded-input text-body text-ink bg-surface-card ' +
                        'focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 ' +
                        'min-h-touch appearance-none';
                    const clearFilters = () => {
                        setSearchText('');
                        setFilterUser('');
                        setFilterPriority('');
                        setFilterTag('');
                    };
                    return (
                <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:flex-wrap lg:items-center lg:justify-between">
                    {/* Filters */}
                    <div className="grid grid-cols-2 gap-2 lg:flex lg:flex-wrap lg:items-center">
                        <div className="relative col-span-2 lg:w-auto">
                            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <input
                                type="search"
                                value={searchText}
                                onChange={(e) => setSearchText(e.target.value)}
                                placeholder="Ieškoti užduočių…"
                                aria-label="Ieškoti užduočių"
                                className="w-full pl-10 pr-4 py-2.5 min-h-touch border border-line rounded-input text-body text-ink bg-surface-card focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            />
                        </div>
                        <div className="relative col-span-2 lg:w-auto">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <select
                                value={filterUser}
                                onChange={(e) => setFilterUser(e.target.value)}
                                aria-label="Filtruoti pagal vykdytoją"
                                className={FILTER_FIELD}
                            >
                                <option value="">Visi vykdytojai</option>
                                {pickerUsers.map(user => (
                                    <option key={user.id} value={user.id}>
                                        {user.displayName || user.email}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="relative lg:w-auto">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <select
                                value={filterPriority}
                                onChange={(e) => setFilterPriority(e.target.value)}
                                aria-label="Filtruoti pagal prioritetą"
                                className={FILTER_FIELD}
                            >
                                <option value="">Visi prioritetai</option>
                                <option value={PRIORITIES.URGENT}>{getPriorityLabel(PRIORITIES.URGENT)}</option>
                                <option value={PRIORITIES.HIGH}>{getPriorityLabel(PRIORITIES.HIGH)}</option>
                                <option value={PRIORITIES.MEDIUM}>{getPriorityLabel(PRIORITIES.MEDIUM)}</option>
                                <option value={PRIORITIES.LOW}>{getPriorityLabel(PRIORITIES.LOW)}</option>
                                <option value={PRIORITIES.VERY_LOW}>{getPriorityLabel(PRIORITIES.VERY_LOW)}</option>
                            </select>
                        </div>
                        <div className="relative lg:w-auto">
                            <Filter className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                            <select
                                value={filterTag}
                                onChange={(e) => setFilterTag(e.target.value)}
                                aria-label="Filtruoti pagal žymę"
                                className={FILTER_FIELD}
                            >
                                <option value="">Visi Tagai</option>
                                {TASK_TAGS.map(tag => (
                                    <option key={`filter-${tag}`} value={tag}>{tag}</option>
                                ))}
                            </select>
                        </div>
                        {/* Quick reset — only shown when something is actually filtered, so it never
                            adds noise to the default state. Spans the grid row on mobile. */}
                        {hasActiveFilters && (
                            <button
                                type="button"
                                onClick={clearFilters}
                                className="col-span-2 lg:col-auto inline-flex items-center justify-center gap-1.5 min-h-touch px-3 py-2 rounded-input border border-line text-body font-medium text-ink-muted bg-surface-card hover:text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                            >
                                <X className="w-4 h-4" aria-hidden="true" />
                                Išvalyti filtrus
                            </button>
                        )}
                    </div>

                    {/* Sort dropdown — full width on mobile, auto on lg+ */}
                    <div className="relative w-full lg:w-auto">
                        <ArrowUpDown className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                        <ChevronDown className="absolute right-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" aria-hidden="true" />
                        <select
                            value={sortBy}
                            onChange={(e) => setSortBy(e.target.value)}
                            aria-label="Rūšiuoti užduotis"
                            className={FILTER_FIELD}
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
                    );
                })()}

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
            </div>

            <div className={activeTab === 'my-tasks' ? 'block' : 'hidden'}>
                {/* Reuse worker view logic for "My Tasks" */}
                {(() => {
                    // Own tasks come from the dedicated owner-scoped listener (ownTasks), so a
                    // scoped manager — whose team listener excludes their own rows — still sees them.
                    const filteredMyTasks = ownTasks;
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

            {/* Calendar tabs render only while active. react-big-calendar measures its grid
                geometry once at mount; mounting inside a display:none tab yields zero widths and a
                misaligned header/gutter that only a window resize would fix. Gating on the active
                tab keeps it mounting into a laid-out container (and honours the lazy-load intent:
                the chunk streams in on first visit, not eagerly while hidden). */}
            {activeTab === 'my-calendar' && (
                <div className="w-full">
                    <ErrorBoundary boundaryName="manager:my-calendar">
                        <React.Suspense fallback={<Spinner />}>
                            <WorkPlanner />
                        </React.Suspense>
                    </ErrorBoundary>
                </div>
            )}

            {activeTab === 'team-calendar' && (
                <div className="space-y-6">
                    {/* Komandos darbai (Savaitės): the weekly planned-vs-worked summary moved here
                        from Kom. darbai — it belongs beside the team calendar it summarises. */}
                    <CombinedHoursSummary />
                    <ErrorBoundary boundaryName="manager:team-calendar">
                        <React.Suspense fallback={<Spinner />}>
                            <AllUsersCalendar />
                        </React.Suspense>
                    </ErrorBoundary>
                </div>
            )}

            <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="manager:reports" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        {/* Team report is the only place export is allowed (Kom. ataskaitos).
                            roster is team-scoped for a scoped manager. */}
                        <Reports users={reportRoster} canExport />
                    </React.Suspense>
                </ErrorBoundary>
            </div>

            <div className={activeTab === 'my-reports' ? 'block' : 'hidden'}>
                <div className="space-y-6">
                    <ErrorBoundary boundaryName="manager:my-reports" resetKeys={[activeTab]}>
                        {/* A manager's own "Ataskaitos" is the full report, scoped to themselves
                            (viewRole="worker": personal data only, no team aggregates/dropdown/export)
                            so it is identical to a worker's "Ataskaitos". */}
                        <React.Suspense fallback={<Spinner />}>
                            <Reports users={[currentUser]} viewRole="worker" />
                        </React.Suspense>
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

