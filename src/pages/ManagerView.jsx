import React, { useState, useEffect } from 'react';
import { ArrowUpDown, Filter, X, Activity, ListChecks, Repeat } from 'lucide-react';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import UserManagement from '../components/UserManagement';
import CombinedHoursSummary from '../components/CombinedHoursSummary';
import ActiveWorkSessions from '../components/ActiveWorkSessions';
import DailyWorkProgress from '../components/DailyWorkProgress';
import RecurringTasksPanel from '../components/RecurringTasksPanel';
import ErrorBoundary from '../components/ErrorBoundary';
import { Spinner } from '../components/ui/Loading';
import Select from '../components/ui/Select';
import SearchBox from '../components/ui/SearchBox';
import SearchPopover from '../components/ui/SearchPopover';
import { useAuth } from '../context/AuthContext';

import { useNavigation } from '../context/NavigationContext';

import { filterTasksByVisibility, sortWorkerTasks, TASK_TAGS } from '../utils/taskUtils';
import { PRIORITIES, getPriorityLabel } from '../utils/priority';
import { STATUS_LABELS } from '../utils/taskConstants';

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
const AuditDashboard = React.lazy(() => import('../components/AuditDashboard'));

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
        filterStatus, setFilterStatus,
        searchText, setSearchText,
        searchSuggestions,
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

    // Filter/sort option sets — shared by the mobile toolbar, the desktop control strip, and the
    // desktop data-grid headers (gridControls). Lifted out of the old toolbar IIFE so all three
    // read one source of truth.
    const userOptions = [
        { value: '', label: 'Visi vykdytojai' },
        ...pickerUsers.map((user) => ({ value: user.id, label: user.displayName || user.email })),
    ];
    const priorityOptions = [
        { value: '', label: 'Visi prioritetai' },
        { value: PRIORITIES.URGENT, label: getPriorityLabel(PRIORITIES.URGENT) },
        { value: PRIORITIES.HIGH, label: getPriorityLabel(PRIORITIES.HIGH) },
        { value: PRIORITIES.MEDIUM, label: getPriorityLabel(PRIORITIES.MEDIUM) },
        { value: PRIORITIES.LOW, label: getPriorityLabel(PRIORITIES.LOW) },
        { value: PRIORITIES.VERY_LOW, label: getPriorityLabel(PRIORITIES.VERY_LOW) },
    ];
    const tagOptions = [
        { value: '', label: 'Visi Tagai' },
        ...TASK_TAGS.map((tag) => ({ value: tag, label: tag })),
    ];
    const statusOptions = [
        { value: '', label: 'Visos būsenos' },
        { value: 'pending', label: STATUS_LABELS.pending },
        { value: 'in-progress', label: STATUS_LABELS['in-progress'] },
        { value: 'unapproved', label: STATUS_LABELS.unapproved },
        { value: 'approved', label: STATUS_LABELS.approved },
        { value: 'completed', label: STATUS_LABELS.completed },
        { value: 'confirmed', label: STATUS_LABELS.confirmed },
    ];
    const sortOptions = [
        { value: 'none', label: 'Numatyta tvarka' },
        { value: 'status', label: 'Pagal būseną' },
        { value: 'priority', label: 'Pagal prioritetą' },
        { value: 'user', label: 'Pagal vartotoją' },
        { value: 'deadline-user', label: 'Pagal terminą-vartotoją' },
        { value: 'user-priority', label: 'Pagal vartotoją-prioritetą' },
        { value: 'manual', label: 'Rankiniu būdu' },
    ];
    const hasActiveFilters = !!(searchText || filterUser || filterPriority || filterTag || filterStatus);
    const clearFilters = () => {
        setSearchText('');
        setFilterUser('');
        setFilterPriority('');
        setFilterTag('');
        setFilterStatus('');
    };

    // Desktop data-grid wiring. The team list's headers carry single-axis sort (user/priority/
    // status) + per-column filters; the composite/manual sorts (no single column) stay in the
    // "Daugiau rūšiavimo" launcher. One `sortBy` is the single source of truth, so the launcher
    // binds to '' under a header sort (showing its placeholder, contradicting nothing).
    const MORE_SORT_VALUES = ['none', 'deadline-user', 'user-priority', 'manual'];
    const moreSortOptions = sortOptions.filter((o) => MORE_SORT_VALUES.includes(o.value));
    const activeAdvancedSortLabel = sortBy !== 'none' && MORE_SORT_VALUES.includes(sortBy)
        ? (moreSortOptions.find((o) => o.value === sortBy)?.label ?? null)
        : null;
    const teamGridControls = {
        sort: {
            value: sortBy,
            set: setSortBy,
            columns: { user: 'user', priority: 'priority', status: 'status', tag: 'tag' },
        },
        filters: {
            user: { value: filterUser, set: setFilterUser, options: userOptions },
            priority: { value: filterPriority, set: setFilterPriority, options: priorityOptions },
            status: { value: filterStatus, set: setFilterStatus, options: statusOptions },
            tag: { value: filterTag, set: setFilterTag, options: tagOptions },
        },
    };

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
                {/* The single-line quick-add bar was removed; its AI draft-fill now lives in the
                    "Naujas darbas" modal (TaskModal), beside the title. */}
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
                    <div role="tablist" aria-label="Komandos darbų rodinys">
                        <div className="flex w-full sm:inline-flex sm:w-auto overflow-hidden rounded-control border border-line bg-surface-sunken">
                            <button
                                type="button"
                                role="tab"
                                id="team-active-tab"
                                aria-selected={teamTasksSubTab === 'active'}
                                aria-controls="team-active-panel"
                                onClick={() => setTeamTasksSubTab('active')}
                                className={cn(
                                    'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'active' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Aktyvūs</span>
                                <span className="hidden sm:inline">Aktyvios užduotys</span>
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
                                    'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'list' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Sąrašas</span>
                                <span className="hidden sm:inline">Sąrašas užduočių</span>
                            </button>
                            <div className="w-px bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-recurring-tab"
                                aria-selected={teamTasksSubTab === 'recurring'}
                                aria-controls="team-recurring-panel"
                                onClick={() => setTeamTasksSubTab('recurring')}
                                className={cn(
                                    'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'recurring' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <Repeat className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Pasikartojančios</span>
                                <span className="hidden sm:inline">Pasikartojančios užduotys</span>
                            </button>
                        </div>
                    </div>

                    {/* Užduočių sąrašas toolbar lifted onto the tab row (desktop only) and split
                        off with a vertical divider, so it reads as a separate control cluster — not
                        part of the tab switcher. md+ only; mobile keeps the full toolbar in-panel
                        below. Rendered only on the list sub-tab — Aktyvūs darbai has no filters. */}
                    {teamTasksSubTab === 'list' && (
                        <div className="hidden items-center gap-2 md:ml-auto md:flex md:border-l md:border-line md:pl-4">
                            <SearchPopover
                                value={searchText}
                                onChange={setSearchText}
                                suggestions={searchSuggestions}
                                placeholder="Ieškoti užduočių…"
                                label="Ieškoti užduočių"
                            />
                            <Select
                                value={MORE_SORT_VALUES.includes(sortBy) && sortBy !== 'none' ? sortBy : ''}
                                onChange={setSortBy}
                                options={moreSortOptions}
                                label="Daugiau rūšiavimo"
                                placeholder="Daugiau rūšiavimo"
                                ariaLabel="Daugiau rūšiavimo"
                                icon={ArrowUpDown}
                                className="w-auto min-w-[12rem]"
                            />
                            {activeAdvancedSortLabel && (
                                <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-sunken px-2.5 py-1 text-caption text-ink-muted">
                                    Rūšiuojama:&nbsp;<span className="font-medium text-ink">{activeAdvancedSortLabel}</span>
                                </span>
                            )}
                            {hasActiveFilters && (
                                <button
                                    type="button"
                                    onClick={clearFilters}
                                    className="inline-flex items-center justify-center gap-1.5 min-h-touch px-3 py-2 rounded-input border border-line text-body font-medium text-ink-muted bg-surface-card hover:text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                >
                                    <X className="w-4 h-4" aria-hidden="true" />
                                    Išvalyti filtrus
                                </button>
                            )}
                        </div>
                    )}
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
                {/* Filter & sort controls.
                    Mobile (<md): the full toolbar below — search spans the width, the four
                    classifiers form a 2x2 grid, sort below. Desktop (md+): sort and per-column
                    filters live ON the table headers (TaskTable `gridControls`); collapsed search,
                    the non-column "Daugiau rūšiavimo" launcher, the active-advanced-sort hint and a
                    global clear sit on the tab row above (lifted next to the sub-tab switcher). */}
                <div className="grid grid-cols-2 gap-2 mb-4 md:hidden">
                    <SearchBox
                        value={searchText}
                        onChange={setSearchText}
                        suggestions={searchSuggestions}
                        placeholder="Ieškoti užduočių…"
                        ariaLabel="Ieškoti užduočių"
                        className="col-span-2"
                    />
                    <Select
                        value={filterUser}
                        onChange={setFilterUser}
                        options={userOptions}
                        label="Vykdytojas"
                        ariaLabel="Filtruoti pagal vykdytoją"
                        icon={Filter}
                    />
                    <Select
                        value={sortBy}
                        onChange={setSortBy}
                        options={sortOptions}
                        label="Rūšiavimas"
                        ariaLabel="Rūšiuoti užduotis"
                        icon={ArrowUpDown}
                    />
                    <Select
                        value={filterPriority}
                        onChange={setFilterPriority}
                        options={priorityOptions}
                        label="Prioritetas"
                        ariaLabel="Filtruoti pagal prioritetą"
                        icon={Filter}
                    />
                    <Select
                        value={filterTag}
                        onChange={setFilterTag}
                        options={tagOptions}
                        label="Žyma"
                        ariaLabel="Filtruoti pagal žymę"
                        icon={Filter}
                    />
                    {hasActiveFilters && (
                        <button
                            type="button"
                            onClick={clearFilters}
                            className="col-span-2 inline-flex items-center justify-center gap-1.5 min-h-touch px-3 py-2 rounded-input border border-line text-body font-medium text-ink-muted bg-surface-card hover:text-ink hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <X className="w-4 h-4" aria-hidden="true" />
                            Išvalyti filtrus
                        </button>
                    )}
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
                        gridControls={teamGridControls}
                    />
                )}
                </div>

                {/* Sub-tab 3 — Pasikartojančios užduotys: recurring-task management (turn shared
                    templates into auto-generated jobs). Rendered embedded — the sub-tab switcher
                    supplies the heading, so the panel drops its own collapsible chrome. */}
                <div
                    id="team-recurring-panel"
                    role="tabpanel"
                    aria-labelledby="team-recurring-tab"
                    className={cn(teamTasksSubTab !== 'recurring' && 'hidden')}
                >
                    <RecurringTasksPanel embedded />
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

            {/* Audit dashboard (admin-only): decision_log + integrity_reports. Mounted only while
                active — like the calendar tabs — so its Firestore listeners attach on first visit,
                not eagerly behind a hidden div. */}
            {userRole === 'admin' && activeTab === 'audit' && (
                <ErrorBoundary boundaryName="manager:audit" resetKeys={[activeTab]}>
                    <React.Suspense fallback={<Spinner />}>
                        <AuditDashboard />
                    </React.Suspense>
                </ErrorBoundary>
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

