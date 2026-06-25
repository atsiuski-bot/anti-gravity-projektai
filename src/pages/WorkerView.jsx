import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import PendingApprovalDisclosure from '../components/PendingApprovalDisclosure';

import DailyWorkProgress from '../components/DailyWorkProgress';
import { filterTasksByVisibility, sortWorkerTasks, scopePersonalDayWindow } from '../utils/taskUtils';
import { Spinner } from '../components/ui/Loading';
import SearchBox from '../components/ui/SearchBox';
import SearchPopover from '../components/ui/SearchPopover';
import FilterPills from '../components/ui/FilterPills';
import {
    filterRankTasks,
    buildTaskSuggestions,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from '../utils/taskSearch';
import { logError } from '../utils/errorLog';
import { AlertCircle, ClipboardList } from 'lucide-react';
import EmptyState from '../components/ui/EmptyState';
import Button from '../components/ui/Button';
import ErrorBoundary from '../components/ErrorBoundary';
import { useTaskTimeMonitor } from '../hooks/useTaskTimeMonitor';
import { useOrphanedTaskRecovery } from '../hooks/useOrphanedTaskRecovery';
import { useOrphanedSessionRecovery } from '../hooks/useOrphanedSessionRecovery';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import EarningsModal from '../components/EarningsModal';

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
    // Post-completion earnings popup payload ({ task, totalMinutes }), set by the 'task-earnings'
    // event dispatched from TaskTimerControls when the worker finishes their own task.
    const [earnings, setEarnings] = useState(null);

    const [error, setError] = useState(null);

    // Task time monitoring — 80% warning and 100% limit
    const { warningPopup, limitPopup, dismissWarning, requestExtension, finishFromLimit } = useTaskTimeMonitor(tasks);

    // Crash/reload recovery — auto-pause any task left "running" across a restart so
    // it cannot credit hours of ghost time on the next pause.
    useOrphanedTaskRecovery(tasks);

    // Same crash/reload recovery for an orphaned break/call/quick-work session — ends it
    // (clamped to 16h) so a forgotten secondary timer can't credit a multi-day "ghost" gap.
    useOrphanedSessionRecovery(currentUser);


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

                // Personal day window: keep done tasks only for the current "work day" (03:00–03:00
                // Vilnius). Unapproved own tasks stay visible — the worker must see their own
                // pending-approval item; only the SHARED team list hides those.
                tasksData = scopePersonalDayWindow(tasksData);

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

        const handleOpenTaskModal = (e) => {
            // A bare event opens a blank create modal; a `detail.task` (from the notification bell,
            // e.g. opening a task that was returned for rework) opens that task for editing.
            setEditingTask(e?.detail?.task || null);
            setIsModalOpen(true);
        };
        window.addEventListener('open-task-modal', handleOpenTaskModal);

        // The earnings popup is fired by TaskTimerControls.performFinish (worker's own task only)
        // once payRate is set; it carries the finished task + its total minutes for the breakdown.
        const handleEarnings = (e) => {
            if (e?.detail?.task) setEarnings({ task: e.detail.task, totalMinutes: e.detail.totalMinutes });
        };
        window.addEventListener('task-earnings', handleEarnings);

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
            window.removeEventListener('task-earnings', handleEarnings);
            clearInterval(filterInterval);
        };
    }, [currentUser, usersLoading, usersMap]);

    const handleEditTask = React.useCallback((task) => {
        setEditingTask(task);
        setIsModalOpen(true);
    }, []);

    // Filtering state. Sorting is no longer user-driven here — the listener already orders the list
    // by Day → Priority (sortWorkerTasks); the only control is the tag filter, shown as pills.
    const [filterTag, setFilterTag] = useState('');
    // Free-text search, debounced so the list doesn't re-filter on every keystroke.
    const [searchText, setSearchText] = useState('');
    const [debouncedSearch, setDebouncedSearch] = useState('');
    useEffect(() => {
        const handle = setTimeout(() => setDebouncedSearch(searchText), 200);
        return () => clearTimeout(handle);
    }, [searchText]);

    // Scroll restoration logic
    useEffect(() => {
        requestAnimationFrame(() => {
            const savedScroll = scrollPositions.current[activeTab] || 0;
            window.scrollTo(0, savedScroll);
        });
    }, [activeTab, scrollPositions]);

    // Suggestions read from the tag-scoped set (own tasks) — titles and tags only; every row is
    // the signed-in worker's own task, so a "Vykdytojas" suggestion would be noise. Driven by the
    // live searchText so completions feel instant while the list re-filter stays debounced.
    const searchSuggestions = useMemo(() => {
        if (!searchText.trim()) return [];
        const scoped = filterTag ? tasks.filter(t => t.tag === filterTag) : tasks;
        return buildTaskSuggestions(scoped, searchText, getTaskSuggestionSources, {
            kinds: ['task', 'tag'],
        });
    }, [tasks, searchText, filterTag]);

    // Tasks THIS user created that a manager has not yet approved. They are not
    // actionable until approved, so they are lifted out of the main list and shown in
    // the collapsible "Laukia patvirtinimo" disclosure above it (kept sorted by reading
    // from the already-sorted `tasks`).
    const pendingApprovalMine = useMemo(
        () => tasks.filter(
            (t) => t.createdBy === currentUser?.uid && t.status === 'unapproved' && !t.isDeleted
        ),
        [tasks, currentUser?.uid]
    );
    const pendingApprovalIds = useMemo(
        () => new Set(pendingApprovalMine.map((t) => t.id)),
        [pendingApprovalMine]
    );

    // The tag filter offers ONLY the tags that actually occur on the worker's own (non-pending)
    // tasks — never the full static catalogue. With none present the whole filter row is hidden
    // (no empty "Visi" pill), so the worker is never shown a filter that can't do anything.
    const presentTags = useMemo(() => {
        const set = new Set();
        for (const t of tasks) {
            if (t.tag && !pendingApprovalIds.has(t.id)) set.add(t.tag);
        }
        return [...set].sort((a, b) => a.localeCompare(b, 'lt'));
    }, [tasks, pendingApprovalIds]);

    // If the selected tag stops occurring (task retagged / cleared), drop back to "Visi" so the
    // list never silently empties behind a now-orphaned filter.
    useEffect(() => {
        if (filterTag && !presentTags.includes(filterTag)) setFilterTag('');
    }, [filterTag, presentTags]);

    const sortedTasks = useMemo(() => {
        // Exclude the user's own not-yet-approved tasks — they live in the disclosure above.
        let result = tasks.filter((t) => !pendingApprovalIds.has(t.id));

        if (filterTag) {
            result = result.filter(t => t.tag === filterTag);
        }

        // Fuzzy free-text search (diacritic-insensitive, typo-tolerant, ranked by relevance).
        // The listener already ordered the base list by Day → Priority; search re-ranks by
        // relevance, otherwise that default order is kept (no user-driven sort here).
        if (debouncedSearch.trim()) {
            result = filterRankTasks(result, debouncedSearch, getTaskMatchFields);
        }

        return result;
    }, [tasks, filterTag, debouncedSearch, pendingApprovalIds]);

    return (
        <div className="pt-1">
            {error && (
                <div className="mb-4 flex items-start gap-2 rounded-card border-l-4 border-feedback-danger bg-feedback-danger-soft p-4 wz-shake" role="alert">
                    <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {/* Tasks Tab */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <div className="flex flex-row justify-between items-center gap-4 mb-4 sm:mb-6">
                    <h2 className="text-h2 font-bold text-ink-strong wz-on-shell">Mano užduotys</h2>

                    {/* Desktop (md+): collapsed search popover stays in the header. On mobile the search
                        box lives lower in the tab flow (after the weekly goal) — see below — so the
                        header stays compact on phones. Sorting was removed; tags are the pill row. */}
                    <div className="hidden md:flex md:items-center">
                        <SearchPopover
                            value={searchText}
                            onChange={setSearchText}
                            suggestions={searchSuggestions}
                            placeholder="Ieškoti užduočių…"
                            label="Ieškoti užduočių"
                        />
                    </div>
                </div>

                {/* Tag filter — shown immediately as pills (no dropdown), and ONLY the tags that occur
                    on the worker's own tasks. Renders nothing when no task is tagged. */}
                <FilterPills
                    options={presentTags.map((tag) => ({ value: tag, label: tag }))}
                    value={filterTag}
                    onChange={setFilterTag}
                    ariaLabel="Filtruoti pagal žymą"
                    className="mb-4"
                />

                <DailyWorkProgress currentUser={currentUser} tasks={sortedTasks} />

                {/* Mobile search — placed in the tab flow right after the weekly goal (not in the
                    header) so a phone shows goals first, then the search above the task list. Desktop
                    keeps the collapsed popover in the header above. */}
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

                <PendingApprovalDisclosure
                    tasks={pendingApprovalMine}
                    onEdit={handleEditTask}
                    role="worker"
                />

                {sortedTasks.length === 0 ? (
                    <div className="rounded-card border border-line bg-surface-card shadow-sm">
                        <EmptyState
                            icon={ClipboardList}
                            title="Kol kas užduočių nėra"
                            description="Kai koordinatorius priskirs užduotį, ji atsiras čia. Tuo tarpu galite pažymėti greitą veiklą ar skambutį mygtukais apačioje."
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
                        {/* Mobile: card stack — actions always visible (no group-hover).
                            Each card eases in on mount; the wrapper is keyed so a reused card
                            (re-sort / per-second timer tick) never re-plays its entrance — only
                            a genuinely new or filtered-in card animates. */}
                        <div className="space-y-4 md:hidden">
                            {sortedTasks.map(task => (
                                <div key={task.id} className="animate-in fade-in slide-in-from-bottom-2">
                                    <TaskCard
                                        task={task}
                                        onEdit={() => handleEditTask(task)}
                                        role="worker"
                                    />
                                </div>
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

            {/* Calendar Tab — rendered only while active. react-big-calendar measures its
                grid geometry once at mount; mounting it inside a display:none tab yields zero
                widths and a misaligned header/gutter that only a window resize would fix. Gating
                on the active tab keeps it mounting into a laid-out container (and finally honours
                the lazy-load intent: the chunk streams in on first visit, not eagerly while hidden). */}
            {activeTab === 'calendar' && (
                <div className="w-full">
                    <ErrorBoundary boundaryName="worker:calendar">
                        <React.Suspense fallback={<Spinner />}>
                            <WorkPlanner />
                        </React.Suspense>
                    </ErrorBoundary>
                </div>
            )}

            {/* Team Calendar Tab — same react-big-calendar mount-measurement constraint. */}
            {activeTab === 'team-calendar' && (
                <ErrorBoundary boundaryName="worker:team-calendar">
                    <React.Suspense fallback={<Spinner />}>
                        <AllUsersCalendar />
                    </React.Suspense>
                </ErrorBoundary>
            )}

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
                    uid={currentUser?.uid}
                    onRequestExtension={requestExtension}
                    onFinish={finishFromLimit}
                />
            )}

            {/* Post-completion earnings popup — gross (with tax) first, net (take-home) beside it */}
            {earnings && (
                <EarningsModal
                    open
                    onClose={() => setEarnings(null)}
                    task={earnings.task}
                    totalMinutes={earnings.totalMinutes}
                />
            )}
        </div>
    );
}

