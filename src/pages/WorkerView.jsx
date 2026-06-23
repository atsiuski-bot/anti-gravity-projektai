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
import Select from '../components/ui/Select';
import SearchBox from '../components/ui/SearchBox';
import SearchPopover from '../components/ui/SearchPopover';
import {
    filterRankTasks,
    buildTaskSuggestions,
    getTaskMatchFields,
    getTaskSuggestionSources,
} from '../utils/taskSearch';
import { getLithuanianDateString, getLithuanian3AMCutoff } from '../utils/timeUtils';
import { logError } from '../utils/errorLog';
import { Filter, AlertCircle, ClipboardList } from 'lucide-react';
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
    const { warningPopup, limitPopup, dismissWarning, dismissLimit } = useTaskTimeMonitor(tasks);

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

    // Sorting and filtering state
    const [sortBy, setSortBy] = useState('none');
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

    const sortedTasks = useMemo(() => {
        let result = [...tasks];

        if (filterTag) {
            result = result.filter(t => t.tag === filterTag);
        }

        // Fuzzy free-text search (diacritic-insensitive, typo-tolerant, ranked by relevance).
        // When a query is present the matches come back ordered by relevance; an explicit sort
        // below overrides that, the default order keeps it.
        if (debouncedSearch.trim()) {
            result = filterRankTasks(result, debouncedSearch, getTaskMatchFields);
        }

        if (sortBy === 'status') {
            result.sort((a, b) => {
                const getStatusRank = (task) => {
                    const status = task.status || 'pending';
                    if (status === 'in-progress') return 1;
                    if (status === 'approved') return 2; // gate cleared, ready to start — near the top
                    if (status === 'pending') return 3;
                    if (status === 'unapproved') return 4;
                    if (status === 'completed') return 5;
                    if (status === 'confirmed') return 6;
                    return 7;
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
    }, [tasks, sortBy, filterTag, debouncedSearch]);

    // Desktop data-grid wiring (worker subset). The worker's table headers carry priority/status
    // sort + the tag filter; there is no user/priority filter and no composite/manual sort here, so
    // the only non-column mode is 'none' — reachable by toggling the active sort header off — and
    // no "Daugiau rūšiavimo" launcher is needed.
    const workerGridControls = {
        sort: {
            value: sortBy,
            set: setSortBy,
            columns: { priority: 'priority', status: 'status' },
        },
        filters: {
            tag: {
                value: filterTag,
                set: setFilterTag,
                options: [
                    { value: '', label: 'Visi Tagai' },
                    ...TASK_TAGS.map((tag) => ({ value: tag, label: tag })),
                ],
            },
        },
    };

    return (
        <div className="pt-1">
            <div className="mb-2 sm:mb-6">
                {error && (
                    <div className="mt-4 flex items-start gap-2 rounded-card border-l-4 border-feedback-danger bg-feedback-danger-soft p-4 wz-shake" role="alert">
                        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                        <p className="text-body text-feedback-danger">{error}</p>
                    </div>
                )}
            </div>
            

            {/* Tasks Tab */}
            <div className={activeTab === 'tasks' ? 'block' : 'hidden'}>
                <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-4 sm:mb-6">
                    <h2 className="text-h2 font-bold text-ink-strong wz-on-shell">Mano užduotys</h2>

                    {/* Mobile (<md): full toolbar — search + sort + tag filter (inline from sm).
                        Desktop (md+): sort and the tag filter live on the table headers (TaskTable
                        `gridControls`); only the collapsed search stays here. The `md:hidden` gate
                        keeps this from doubling up with the desktop strip in the 640–767px band. */}
                    <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center sm:gap-2 md:hidden">
                        <SearchBox
                            value={searchText}
                            onChange={setSearchText}
                            suggestions={searchSuggestions}
                            placeholder="Ieškoti užduočių…"
                            ariaLabel="Ieškoti užduočių"
                            className="col-span-2 sm:col-auto"
                        />
                        <Select
                            value={sortBy}
                            onChange={setSortBy}
                            options={[
                                { value: 'none', label: 'Numatyta tvarka' },
                                { value: 'status', label: 'Pagal būseną' },
                                { value: 'priority', label: 'Pagal prioritetą' },
                            ]}
                            label="Rūšiavimas"
                            ariaLabel="Rūšiuoti pagal"
                            icon={Filter}
                            className="sm:w-auto sm:min-w-[10rem]"
                        />
                        <Select
                            value={filterTag}
                            onChange={setFilterTag}
                            options={[
                                { value: '', label: 'Visi Tagai' },
                                ...TASK_TAGS.map((tag) => ({ value: tag, label: tag })),
                            ]}
                            label="Žyma"
                            ariaLabel="Filtruoti pagal žymę"
                            icon={Filter}
                            className="sm:w-auto sm:min-w-[9rem]"
                        />
                    </div>
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

                <DailyWorkProgress currentUser={currentUser} tasks={sortedTasks} />


                {sortedTasks.length === 0 ? (
                    <div className="rounded-card border border-line bg-surface-card shadow-sm">
                        <EmptyState
                            icon={ClipboardList}
                            title="Kol kas užduočių nėra"
                            description="Kai vadovas priskirs užduotį, ji atsiras čia. Tuo tarpu galite pažymėti greitą darbą ar skambutį mygtukais apačioje."
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
                                gridControls={workerGridControls}
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
                    onDismiss={dismissLimit}
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

