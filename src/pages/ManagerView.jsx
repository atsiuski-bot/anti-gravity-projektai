import React, { useState, useEffect } from 'react';
import { ArrowUpDown, Activity, ListChecks, Repeat, BadgeCheck, ClipboardCheck, History, BarChart3, LayoutGrid } from 'lucide-react';
import { doc, updateDoc } from 'firebase/firestore';
import { db } from '../firebase';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import IconButton from '../components/ui/IconButton';
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
import FilterPills from '../components/ui/FilterPills';
import { useAuth } from '../context/AuthContext';

import { useNavigation } from '../context/NavigationContext';

import { filterTasksByVisibility, sortWorkerTasks, scopePersonalDayWindow, TASK_TAGS } from '../utils/taskUtils';
import { PRIORITIES, getPriorityLabel } from '../utils/priority';
import { STATUS_LABELS } from '../utils/taskConstants';
import { formatDisplayName } from '../utils/formatters';
import { logError } from '../utils/errorLog';

import { useTaskTimeMonitor } from '../hooks/useTaskTimeMonitor';
import { useOrphanedTaskRecovery } from '../hooks/useOrphanedTaskRecovery';
import { useOrphanedSessionRecovery } from '../hooks/useOrphanedSessionRecovery';
import { useTaskHeartbeat } from '../hooks/useTaskHeartbeat';
import { useSessionHeartbeat } from '../hooks/useSessionHeartbeat';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import { useManagerData } from '../hooks/useManagerData';
import { useTaskFiltering } from '../hooks/useTaskFiltering';
import useFullBleed from '../hooks/useFullBleed';
import { scopeRoster } from '../utils/teamScope';
import { cn } from '../utils/cn';

// Shared with WorkerView: the calendar/report views are the heavy part of the bundle
// (react-big-calendar + date-fns + reports aggregation). Lazy-loading them in BOTH views
// is what actually keeps the code out of the eager shared chunk — a static import in
// either view would re-hoist it. Suspense streams each one in when its tab mounts.
const AllUsersCalendar = React.lazy(() => import('../components/AllUsersCalendar'));
const WorkPlanner = React.lazy(() => import('../components/WorkPlanner'));
const Reports = React.lazy(() => import('../components/Reports'));
const CalendarChangeHistory = React.lazy(() => import('../components/CalendarChangeHistory'));
const AuditDashboard = React.lazy(() => import('../components/AuditDashboard'));
// The priority board pulls in @dnd-kit; lazy-load it so that weight enters the bundle only when a
// manager actually turns the board on (it never touches the worker bundle or the default list).
const PriorityBoard = React.lazy(() => import('../components/board/PriorityBoard'));
// Drag-to-reorder for the flat list (mobile cards + desktop table) ALSO pulls in @dnd-kit, so it is
// lazy-loaded the same way: it enters the bundle only when a manager views the canonical team list,
// never the worker bundle. Both reuse the board's shared manual order (utils/boardOrder).
const SortableTaskCardList = React.lazy(() => import('../components/task/SortableTaskCardList'));
const ReorderableTaskTable = React.lazy(() => import('../components/task/ReorderableTaskTable'));

export default function ManagerView() {
    const { userRole, currentUser, userData } = useAuth();
    const { activeTab, scrollPositions } = useNavigation();
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    const [viewMode, setViewMode] = useState('desktop');
    // The meistras filter pills break out of the centered max-w-7xl box to fill the whole content
    // column on desktop (so the widest possible single-line roster fits, matching the full-bleed
    // board below); gated off on mobile, where that would only cancel the comfortable side padding.
    const [assigneeFilterBleedRef, assigneeFilterBleedStyle] = useFullBleed(viewMode !== 'mobile');
    // Komandos veiklos sub-tabs: live activity, task list, approvals queue, recurring — plus the
    // two oversight sections lifted out of the retired Kom. ataskaitos tab: Pridavimas (tasks
    // awaiting acceptance) and Istorija (already-accepted tasks).
    const [teamTasksSubTab, setTeamTasksSubTab] = useState('active');
    // Komandos kalendorius sub-tabs: the live calendar, the calendar-change history (moved out of
    // Kom. ataskaitos to sit beside the calendar it describes), and Veiklos ataskaita (the
    // work-hours report, also lifted out of the retired Kom. ataskaitos tab).
    const [teamCalendarSubTab, setTeamCalendarSubTab] = useState('calendar');

    // Use custom hooks
    const { tasks, ownTasks, users, allUsers, error } = useManagerData(currentUser);
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
    } = useTaskFiltering(tasks);

    // Desktop-only priority board toggle. The choice is persisted on the user doc (teamBoardView),
    // so it follows the manager across sessions and devices. Firestore latency-compensates the local
    // snapshot, so reading userData directly flips the view as soon as the write is issued.
    const boardView = !!userData?.teamBoardView;
    const toggleBoardView = React.useCallback(async () => {
        if (!currentUser?.uid) return;
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), { teamBoardView: !boardView });
        } catch (err) {
            logError(err, { source: 'manager:toggleBoardView' });
        }
    }, [boardView, currentUser]);

    // Drag-to-reorder is offered only while the list shows its app-wide CANONICAL order (sortBy
    // 'none'): an advanced "Daugiau rūšiavimo" choice or a free-text search reorders the list
    // independently of the manual rank, so a drag there would be silently ignored. `reorderActive`
    // decides whether the (lazy) reorder components mount at all; `dragEnabled` toggles the handles
    // within them — off while a search narrows the list to relevance order.
    const reorderActive = sortBy === 'none';
    const dragEnabled = reorderActive && !searchText.trim();

    // Task time monitoring — 80% warning and 100% limit for manager's own tasks (ownTasks, so a
    // scoped manager whose team listener excludes their own rows is still monitored correctly).
    const { warningPopup, limitPopup, dismissWarning, requestExtension, finishFromLimit } = useTaskTimeMonitor(ownTasks);

    // Keep the running task's timer "alive" with a per-minute heartbeat so a reload mid-shift can
    // be recovered as continuous work, same as WorkerView. Scoped to the manager's OWN tasks.
    useTaskHeartbeat(ownTasks, currentUser);

    // Crash/reload recovery — managers also start own-task timers and break/call/quick-work
    // sessions (the work-controls pill is role-agnostic), so they need the same orphan recovery
    // WorkerView has, or a manager crash credits ghost time with no notice. Scope task recovery to
    // the manager's OWN tasks (ownTasks), never the team list. (Full-sweep C2, 2026-06-24.)
    useOrphanedTaskRecovery(ownTasks, currentUser);

    // Heartbeat for the running secondary session (break/call/quick-work) — lets the recovery
    // below finalize a genuinely abandoned session at its last proof of life, not the reopen instant.
    useSessionHeartbeat(currentUser);
    useOrphanedSessionRecovery(currentUser);

    // Worker-created tasks still awaiting THIS manager's approval (status 'unapproved' — the same
    // items the notification bell surfaces). Derived from the raw team `tasks`, independent of the
    // list sub-tab's filters, so the approvals queue never hides behind an active filter/sort.
    const pendingApprovalTasks = React.useMemo(
        () => sortWorkerTasks(tasks.filter((t) => t.status === 'unapproved' && !t.isDeleted)),
        [tasks]
    );

    // Tags that ACTUALLY occur on the team's tasks — the source for the immediate pill filter
    // (mobile). Never the static catalogue, so a tag with no tasks offers no dead filter; the
    // pill row renders nothing when the team has no tagged task.
    const presentTags = React.useMemo(() => {
        const set = new Set();
        for (const t of tasks) {
            if (t.tag && !t.isDeleted) set.add(t.tag);
        }
        return [...set].sort((a, b) => a.localeCompare(b, 'lt'));
    }, [tasks]);

    // If the selected tag stops occurring, fall back to "Visi" so the list never empties behind an
    // orphaned filter (the desktop header dropdown shares the same filterTag state).
    React.useEffect(() => {
        if (filterTag && !presentTags.includes(filterTag)) setFilterTag('');
    }, [filterTag, presentTags, setFilterTag]);

    // Vykdytojai who actually have an ACTIVE task in the default list — the source for the immediate
    // assignee pill filter (shown on BOTH mobile and desktop). Derived from the default-active set
    // (excludes 'unapproved' + done), unlike the tag pills which mirror every non-deleted task: an
    // assignee pill must never point at someone whose work has all left the list. Names resolve from
    // the live team roster (fresh displayName → "Jonas K." via formatDisplayName), falling back to
    // the denormalised assignedUserName stored on the task.
    const presentAssignees = React.useMemo(() => {
        const nameById = new Map((users || []).map((u) => [u.id, u.displayName || u.email || '']));
        const seen = new Map();
        for (const t of tasks) {
            if (t.isDeleted || t.status === 'deleted') continue;
            const isDone = t.completed || t.status === 'completed' || t.status === 'confirmed';
            if (t.status === 'unapproved' || isDone) continue; // mirror the default active list
            const id = t.assignedUserId;
            if (!id || seen.has(id)) continue;
            const fullName = nameById.get(id) || t.assignedUserName || '';
            seen.set(id, formatDisplayName(fullName) || '—');
        }
        return [...seen.entries()]
            .map(([value, label]) => ({ value, label }))
            .sort((a, b) => a.label.localeCompare(b.label, 'lt'));
    }, [tasks, users]);

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

        // The session-correction notification (ManagerNotifications) navigates to the team calendar
        // tab AND fires this so we land directly on its "Veiklos ataskaita" sub-tab — the work-hours
        // report that hosts the session editor — instead of the default calendar sub-tab.
        const handleOpenTeamReport = () => setTeamCalendarSubTab('report');
        window.addEventListener('open-team-report', handleOpenTeamReport);

        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('open-task-modal', handleOpenModalEvent);
            window.removeEventListener('open-team-report', handleOpenTeamReport);
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
        { value: '', label: 'Visi meistrai' },
        ...pickerUsers.map((user) => ({ value: user.id, label: user.displayName || user.email })),
    ];
    const priorityOptions = [
        { value: '', label: 'Visi prioritetai' },
        { value: PRIORITIES.URGENT, label: getPriorityLabel(PRIORITIES.URGENT) },
        { value: PRIORITIES.HIGH, label: getPriorityLabel(PRIORITIES.HIGH) },
        { value: PRIORITIES.MEDIUM, label: getPriorityLabel(PRIORITIES.MEDIUM) },
        { value: PRIORITIES.LOW, label: getPriorityLabel(PRIORITIES.LOW) },
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
    ];

    // Desktop data-grid wiring. The team list's headers carry single-axis sort (user/priority/
    // status) + per-column filters; the composite/manual sorts (no single column) stay in the
    // "Daugiau rūšiavimo" launcher. One `sortBy` is the single source of truth, so the launcher
    // binds to '' under a header sort (showing its placeholder, contradicting nothing).
    const MORE_SORT_VALUES = ['none', 'deadline-user', 'user-priority'];
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
        <div className="pt-1 sm:pt-2">
            {error && (
                <div className="mb-6 bg-feedback-danger-soft border-l-4 border-feedback-danger p-4" role="alert">
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {/* Tab Content — Komandos veiklos splits into two sub-tabs:
                 1. Aktyvios veiklos — live team activity (ActiveWorkSessions).
                 2. Užduočių sąrašas — the manageable task list + its filters.
                The weekly planned-vs-worked summary that used to head this tab now lives in
                Kom. kalendorius, next to the calendar it summarises. */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                {/* The single-line quick-add bar was removed; its AI draft-fill now lives in the
                    "Nauja veikla" modal (TaskModal), beside the title. */}
                <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:gap-4">
                    <div role="tablist" aria-label="Komandos veiklų rodinys">
                        {/* Mobile: a horizontally scrollable strip (no-scrollbar) so all four
                            sub-tabs keep their natural width and full labels instead of being
                            squeezed equal with flex-1 — the row swipes sideways when it overflows
                            the viewport, without growing taller. md+ keeps the fitted inline pill. */}
                        <div className="flex w-full overflow-x-auto no-scrollbar snap-x snap-mandatory sm:inline-flex sm:w-auto sm:overflow-hidden rounded-control border border-line bg-surface-sunken">
                            <button
                                type="button"
                                role="tab"
                                id="team-active-tab"
                                aria-selected={teamTasksSubTab === 'active'}
                                aria-controls="team-active-panel"
                                onClick={() => setTeamTasksSubTab('active')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'active' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <Activity className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Aktyvūs</span>
                                <span className="hidden sm:inline">Aktyvios užduotys</span>
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-list-tab"
                                aria-selected={teamTasksSubTab === 'list'}
                                aria-controls="team-list-panel"
                                onClick={() => setTeamTasksSubTab('list')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'list' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <ListChecks className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Sąrašas</span>
                                <span className="hidden sm:inline">Sąrašas užduočių</span>
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-approvals-tab"
                                aria-selected={teamTasksSubTab === 'approvals'}
                                aria-controls="team-approvals-panel"
                                onClick={() => setTeamTasksSubTab('approvals')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'approvals' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <BadgeCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span className="sm:hidden">Laukia</span>
                                <span className="hidden sm:inline">Laukia patvirtinimo</span>
                                {pendingApprovalTasks.length > 0 && (
                                    <span
                                        className={cn(
                                            'ml-0.5 inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-caption font-bold leading-none',
                                            teamTasksSubTab === 'approvals'
                                                ? 'bg-white/20 text-white'
                                                : 'bg-feedback-warning-soft text-feedback-warning-text'
                                        )}
                                    >
                                        {pendingApprovalTasks.length}
                                    </span>
                                )}
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-signoff-tab"
                                aria-selected={teamTasksSubTab === 'signoff'}
                                aria-controls="team-signoff-panel"
                                onClick={() => setTeamTasksSubTab('signoff')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'signoff' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <ClipboardCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span>Pridavimas</span>
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-signoff-history-tab"
                                aria-selected={teamTasksSubTab === 'signoffHistory'}
                                aria-controls="team-signoff-history-panel"
                                onClick={() => setTeamTasksSubTab('signoffHistory')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamTasksSubTab === 'signoffHistory' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <History className="h-4 w-4 shrink-0" aria-hidden="true" />
                                <span>Istorija</span>
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                id="team-recurring-tab"
                                aria-selected={teamTasksSubTab === 'recurring'}
                                aria-controls="team-recurring-panel"
                                onClick={() => setTeamTasksSubTab('recurring')}
                                className={cn(
                                    'shrink-0 snap-start whitespace-nowrap inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold transition-colors',
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
                        below. Rendered only on the list sub-tab — Aktyvios veiklos has no filters. */}
                    {teamTasksSubTab === 'list' && (
                        <div className="hidden items-center gap-2 md:ml-auto md:flex md:border-l md:border-line md:pl-4">
                            <SearchPopover
                                value={searchText}
                                onChange={setSearchText}
                                suggestions={searchSuggestions}
                                placeholder="Ieškoti užduočių…"
                                label="Ieškoti užduočių"
                            />
                            {/* Priority-board toggle (desktop-only — it lives in this md+ strip). Flips
                                the list into four drag-and-drop priority columns; the choice persists per
                                user. Primary tint + aria-pressed signal the active state. */}
                            <IconButton
                                icon={LayoutGrid}
                                label={boardView ? 'Rodyti sąrašą' : 'Rodyti prioritetų lentą'}
                                aria-pressed={boardView}
                                variant={boardView ? 'primary' : 'default'}
                                onClick={toggleBoardView}
                            />
                            {/* Manual sort doesn't apply to the board (arrangement happens by dragging),
                                so the "Daugiau rūšiavimo" launcher is hidden while the board is on. */}
                            {!boardView && (
                                <>
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
                                </>
                            )}
                        </div>
                    )}
                </div>

                {/* Sub-tab 1 — Aktyvios veiklos */}
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
                {/* Assignee filter pills — immediate (no dropdown), single-select by VYKDYTOJAS, shown
                    on BOTH mobile and desktop above the list. Only workers with an active task in this
                    list get a pill; they share `filterUser` with the desktop table-header Vykdytojas
                    dropdown, so the two stay in lockstep. (Tag filtering on desktop still lives on the
                    table-header Žymos column; the mobile tag-pill row was replaced by this one.) */}
                {/* The bleed wrapper widens this row to the full content column on desktop; the pills
                    are centered within it so a short roster sits in the middle (not stranded at the
                    left edge) while a long one spreads as wide as possible before wrapping. */}
                <div ref={assigneeFilterBleedRef} style={assigneeFilterBleedStyle}>
                    <FilterPills
                        options={presentAssignees}
                        value={filterUser}
                        onChange={setFilterUser}
                        allLabel="Visi"
                        ariaLabel="Filtruoti pagal meistrą"
                        className="mb-3 justify-center"
                    />
                </div>

                {/* Mobile (<md): the search box + a clear button sit below the pills. Desktop (md+):
                    sort and per-column filters live ON the table headers (TaskTable `gridControls`),
                    with collapsed search + the "Daugiau rūšiavimo" launcher + clear on the tab row
                    above — the dense manager controls stay there (§9 dual density). A clear button
                    still appears on mobile when any filter is active (incl. one set from the desktop
                    headers) so a stale filter is never stranded with no way out. */}
                <div className="mb-4 md:hidden">
                    <SearchBox
                        value={searchText}
                        onChange={setSearchText}
                        suggestions={searchSuggestions}
                        placeholder="Ieškoti užduočių…"
                        ariaLabel="Ieškoti užduočių"
                        className="w-full"
                    />
                </div>

                {viewMode === 'mobile' ? (
                    reorderActive ? (
                        /* Mobile → press-and-hold (long-press) a card to reorder it. The drag engine
                           is lazy-loaded, so @dnd-kit only loads here, never in the worker bundle. */
                        <ErrorBoundary boundaryName="manager:reorder-cards">
                            <React.Suspense fallback={<Spinner />}>
                                <SortableTaskCardList
                                    tasks={sortedTasks}
                                    onEditTask={handleEditTask}
                                    role="manager"
                                    dragEnabled={dragEnabled}
                                />
                            </React.Suspense>
                        </ErrorBoundary>
                    ) : (
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
                    )
                ) : boardView ? (
                    /* Desktop + board toggle on → the four-column drag-and-drop priority board. */
                    <ErrorBoundary boundaryName="manager:priority-board">
                        <React.Suspense fallback={<Spinner />}>
                            <PriorityBoard tasks={sortedTasks} onEditTask={handleEditTask} />
                        </React.Suspense>
                    </ErrorBoundary>
                ) : reorderActive ? (
                    /* Desktop list → a leading drag handle per row reorders it (engine lazy-loaded). */
                    <ErrorBoundary boundaryName="manager:reorder-table">
                        <React.Suspense fallback={<Spinner />}>
                            <ReorderableTaskTable
                                tasks={sortedTasks}
                                onEdit={handleEditTask}
                                role="manager"
                                hideCheckboxes={true}
                                gridControls={teamGridControls}
                                dragEnabled={dragEnabled}
                            />
                        </React.Suspense>
                    </ErrorBoundary>
                ) : (
                    <TaskTable
                        tasks={sortedTasks}
                        onEdit={handleEditTask}
                        role="manager"
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

                {/* Sub-tab 4 — Laukia patvirtinimo: worker-created tasks awaiting this manager's
                    approval (status 'unapproved' — the same items the notification bell surfaces).
                    Always the spacious standard TaskCard (these are few at a time), whose own
                    "Patvirtinti" button clears the approval gate; Redaguoti/Trinti come with it. */}
                <div
                    id="team-approvals-panel"
                    role="tabpanel"
                    aria-labelledby="team-approvals-tab"
                    className={cn(teamTasksSubTab !== 'approvals' && 'hidden')}
                >
                    {pendingApprovalTasks.length === 0 ? (
                        <div className="text-center py-12 bg-surface-card rounded-card shadow-sm border border-line">
                            <p className="text-body text-ink-muted">Nėra užduočių, laukiančių patvirtinimo.</p>
                        </div>
                    ) : (
                        <div className="space-y-4">
                            {pendingApprovalTasks.map(task => (
                                <TaskCard
                                    key={task.id}
                                    task={task}
                                    onEdit={() => handleEditTask(task)}
                                    role="manager"
                                />
                            ))}
                        </div>
                    )}
                </div>

                {/* Sub-tab 5 — Pridavimas: team-finished tasks awaiting THIS manager's acceptance
                    (status 'completed'). Lifted out of the retired Kom. ataskaitos tab; rendered via
                    the shared Reports component constrained to its single 'approval' view, so its
                    internal switcher is suppressed. Conditionally MOUNTED (not display:none) so the
                    listeners attach only on first visit, matching the calendar tabs' lazy intent. */}
                {teamTasksSubTab === 'signoff' && (
                    <div id="team-signoff-panel" role="tabpanel" aria-labelledby="team-signoff-tab">
                        <ErrorBoundary boundaryName="manager:team-signoff">
                            <React.Suspense fallback={<Spinner />}>
                                <Reports users={reportRoster} canExport views={['approval']} />
                            </React.Suspense>
                        </ErrorBoundary>
                    </div>
                )}

                {/* Sub-tab 6 — Istorija: tasks the manager has already accepted (status 'confirmed')
                    plus the archived browser. Same single-view Reports trick as Pridavimas, with the
                    'history' view. */}
                {teamTasksSubTab === 'signoffHistory' && (
                    <div id="team-signoff-history-panel" role="tabpanel" aria-labelledby="team-signoff-history-tab">
                        <ErrorBoundary boundaryName="manager:team-signoff-history">
                            <React.Suspense fallback={<Spinner />}>
                                <Reports users={reportRoster} canExport views={['history']} />
                            </React.Suspense>
                        </ErrorBoundary>
                    </div>
                )}
            </div>

            <div className={activeTab === 'my-tasks' ? 'block' : 'hidden'}>
                {/* Reuse worker view logic for "My Tasks" */}
                {(() => {
                    // Own tasks come from the dedicated owner-scoped listener (ownTasks), so a
                    // scoped manager — whose team listener excludes their own rows — still sees them.
                    // "Mano darbai" is a PERSONAL list, so it keeps the same day window as the
                    // worker's "Mano užduotys": own finished work lingers for the rest of the work
                    // day, then clears (the shared team list instead hides finished items at once).
                    const filteredMyTasks = scopePersonalDayWindow(ownTasks);
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
                <div className="space-y-4">
                    {/* Two sub-tabs, same segmented control as the Kom. ataskaitos switcher:
                        Kalendorius (the live calendar) and Kalendoriaus istorija (the calendar-change
                        log, moved here from Kom. ataskaitos to sit beside the calendar it describes). */}
                    <div role="tablist" aria-label="Komandos kalendoriaus rodinys">
                        <div className="flex w-full sm:inline-flex sm:w-auto overflow-hidden rounded-control border border-line bg-surface-sunken">
                            <button
                                type="button"
                                role="tab"
                                aria-selected={teamCalendarSubTab === 'calendar'}
                                onClick={() => setTeamCalendarSubTab('calendar')}
                                className={cn(
                                    'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamCalendarSubTab === 'calendar' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                Kalendorius
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                aria-selected={teamCalendarSubTab === 'history'}
                                onClick={() => setTeamCalendarSubTab('history')}
                                className={cn(
                                    'flex-1 sm:flex-none inline-flex items-center justify-center px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamCalendarSubTab === 'history' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                Kalendoriaus istorija
                            </button>
                            <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                            <button
                                type="button"
                                role="tab"
                                aria-selected={teamCalendarSubTab === 'report'}
                                onClick={() => setTeamCalendarSubTab('report')}
                                className={cn(
                                    'flex-1 sm:flex-none inline-flex items-center justify-center gap-1.5 px-3 sm:px-4 py-2.5 min-h-touch text-body font-semibold text-center leading-tight transition-colors',
                                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                    teamCalendarSubTab === 'report' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                                )}
                            >
                                <BarChart3 className="h-4 w-4 shrink-0" aria-hidden="true" />
                                Veiklos ataskaita
                            </button>
                        </div>
                    </div>

                    {/* Conditional MOUNT (not display:none): react-big-calendar measures its grid
                        geometry at mount, so it must mount into a laid-out container — switching away
                        and back remounts it correctly, and the history listener only runs on its tab. */}
                    {teamCalendarSubTab === 'calendar' && (
                        <>
                            {/* Komandos veiklos (Savaitės): the weekly planned-vs-worked summary moved
                                here from Kom. veiklos — it belongs beside the calendar it summarises. */}
                            <CombinedHoursSummary />
                            <ErrorBoundary boundaryName="manager:team-calendar">
                                <React.Suspense fallback={<Spinner />}>
                                    <AllUsersCalendar />
                                </React.Suspense>
                            </ErrorBoundary>
                        </>
                    )}

                    {teamCalendarSubTab === 'history' && (
                        <ErrorBoundary boundaryName="manager:team-calendar-history">
                            <React.Suspense fallback={<Spinner />}>
                                <CalendarChangeHistory users={reportRoster} />
                            </React.Suspense>
                        </ErrorBoundary>
                    )}

                    {/* Veiklos ataskaita — the work-hours report, lifted out of the retired
                        Kom. ataskaitos tab to sit beside the calendar whose planned hours it
                        measures against. Shared Reports component constrained to its single
                        'report' view (switcher suppressed); export stays with it (canExport). */}
                    {teamCalendarSubTab === 'report' && (
                        <ErrorBoundary boundaryName="manager:team-report">
                            <React.Suspense fallback={<Spinner />}>
                                <Reports users={reportRoster} canExport views={['report']} />
                            </React.Suspense>
                        </ErrorBoundary>
                    )}
                </div>
            )}

            {/* The standalone "Kom. ataskaitos" tab was retired: its three sections were
                redistributed as sub-tabs of Kom. veiklos (Pridavimas, Istorija) and Kom.
                kalendorius (Veiklos ataskaita). The team work-hours export now lives with the
                Veiklos ataskaita sub-tab there. */}

            <div className={activeTab === 'my-reports' ? 'block' : 'hidden'}>
                <ErrorBoundary boundaryName="manager:my-reports" resetKeys={[activeTab]}>
                    {/* A manager's own "Ataskaitos" is the full report, scoped to themselves
                        (viewRole="worker": personal data only, no team aggregates/dropdown/export)
                        so it is identical to a worker's "Ataskaitos". */}
                    <React.Suspense fallback={<Spinner />}>
                        <Reports users={[currentUser]} viewRole="worker" />
                    </React.Suspense>
                </ErrorBoundary>
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
                    uid={currentUser?.uid}
                    onRequestExtension={requestExtension}
                    onFinish={finishFromLimit}
                />
            )}
        </div>
    );
}

