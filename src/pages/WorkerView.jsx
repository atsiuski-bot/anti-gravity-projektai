import React, { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useUsers } from '../context/UsersContext';
import TaskCard from '../components/TaskCard';
import TaskTable from '../components/TaskTable';
import TaskModal from '../components/TaskModal';
import PendingApprovalDisclosure from '../components/PendingApprovalDisclosure';
import CompletedTodayDisclosure from '../components/CompletedTodayDisclosure';

import DailyWorkProgress from '../components/DailyWorkProgress';
import { filterTasksByVisibility, sortWorkerTasks, scopePersonalDayWindow, scopeCompletedToday } from '../utils/taskUtils';
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
import { useRevisionedTaskRecovery } from '../hooks/useRevisionedTaskRecovery';
import { useOrphanedSessionRecovery } from '../hooks/useOrphanedSessionRecovery';
import { useRevisionedSecondaryRecovery } from '../hooks/useRevisionedSecondaryRecovery';
import { useTaskHeartbeat } from '../hooks/useTaskHeartbeat';
import { useSessionHeartbeat } from '../hooks/useSessionHeartbeat';
import TaskTimeWarningPopup from '../components/TaskTimeWarningPopup';
import TaskTimeLimitPopup from '../components/TaskTimeLimitPopup';
import EarningsModal from '../components/EarningsModal';
import CompletionPhotoModal from '../components/CompletionPhotoModal';

import { useNavigation } from '../context/NavigationContext';
import { lazyWithRecovery } from '../utils/appUpdate';

// The calendar/report views pull in react-big-calendar + date-fns + the reports
// aggregation — heavy code the worker's primary path (the tasks tab) never needs to
// render. Splitting them into their own chunks keeps that code out of the eagerly
// loaded view bundle; Suspense streams each one in when its tab mounts.
const WorkPlanner = lazyWithRecovery(() => import('../components/WorkPlanner'));
const AllUsersCalendar = lazyWithRecovery(() => import('../components/AllUsersCalendar'));
const Reports = lazyWithRecovery(() => import('../components/Reports'));

export default function WorkerView() {
    const { currentUser, userRole, userData, timerEngineEnabled, timerEngineResolved } = useAuth();
    // Which recovery net owns an orphaned run is a question about the ENGINE, so it cannot be
    // answered before the rollout flag resolves. `!timerEngineEnabled` answered "legacy" during that
    // window — and the legacy closer only clears the projection flags, so it could tear down the
    // visible half of a canonical run and leave active_sessions still claiming it active, which is
    // exactly the wedged state the canonical nets exist to prevent. Recovery is never urgent (it runs
    // on app open, and re-runs), so the honest answer while unresolved is to run neither net.
    // (The canonical side needs no such guard: 'enabled' already implies resolved.)
    const legacyRecoveryOwns = timerEngineResolved && !timerEngineEnabled;
    const { usersMap, loading: usersLoading } = useUsers();
    const { activeTab, scrollPositions } = useNavigation();
    // Raw task docs, exactly as the listener delivered them. Name enrichment, visibility filtering
    // and ordering all happen in the memos below, NOT inside the snapshot callback — see the
    // subscription's dependency note.
    const [rawTasks, setRawTasks] = useState([]);
    // Has the tasks listener reported at least once? An empty task array means "nothing loaded
    // yet" and "this worker genuinely has no tasks" alike, and the empty state cannot tell them
    // apart — so a worker with a RUNNING timer was shown "Kol kas užduočių nėra" plus a "Sukurti
    // užduotį" button on every reload, while the shell colour and header pill simultaneously said a
    // task was running. The window is not brief: the listener below does not even start until the
    // whole users collection resolves. Latches ON only, so a populated list can never flash back to
    // a spinner.
    const [tasksLoaded, setTasksLoaded] = useState(false);
    // Bumped once a minute so the CLOCK-dependent part of the ordering re-runs without a new
    // snapshot: a running task's completion fraction (spent vs estimated) grows as it runs, and that
    // is sort key 4. Nothing else in the pipeline reads the clock except the personal day window.
    const [minuteTick, setMinuteTick] = useState(0);
    const [isModalOpen, setIsModalOpen] = useState(false);
    const [editingTask, setEditingTask] = useState(null);
    // Post-completion earnings popup payload ({ task, totalMinutes }). No longer set from an event
    // directly — it is chained AFTER the completion-photo prompt closes, so the two never stack.
    const [earnings, setEarnings] = useState(null);
    // Post-finish work-end photo prompt payload ({ task, totalMinutes, showEarnings }), set by the
    // 'request-completion-photo' event from both finish doors (timer "Užbaigti" + the limit popup).
    const [completionPhoto, setCompletionPhoto] = useState(null);

    const [error, setError] = useState(null);

    // Enrichment + visibility. Pure derivation over the raw docs, so a roster change re-labels the
    // list without touching the subscription. Deliberately clock-free apart from the day window, and
    // its items keep a stable identity across the minute ticks below.
    const enrichedTasks = useMemo(() => {
        return rawTasks.map(task => ({
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
    }, [rawTasks, usersMap]);

    // Personal day window: keep done tasks only for the current "work day" (03:00–03:00
    // Vilnius). Unapproved own tasks stay visible — the worker must see their own
    // pending-approval item; only the SHARED team list hides those.
    const visibleTasks = useMemo(
        () => scopePersonalDayWindow(filterTasksByVisibility(enrichedTasks)),
        [enrichedTasks]
    );

    // Today's finished work — regular tasks AND the quick work / calls the active list filters out.
    // Derived from the same enriched docs BEFORE visibility filtering, since that filter is exactly
    // what removes them; shown collapsed at the bottom of the tab.
    const completedToday = useMemo(() => scopeCompletedToday(enrichedTasks), [enrichedTasks]);

    // Canonical order, re-derived on each minute tick because sort key 4 (completion fraction) grows
    // as a task runs — the order can change with no data change at all. The PREVIOUS array is
    // returned verbatim when nothing actually moved: this identity is a dependency of the recovery
    // and time-monitor hooks below, so handing them a fresh array every minute would re-arm
    // Firestore work on a tick that changed nothing. Reference equality is the right test here
    // because visibleTasks keeps its item identities between ticks.
    const lastOrderedRef = React.useRef([]);
    const tasks = useMemo(() => {
        const ordered = sortWorkerTasks(visibleTasks);
        const previous = lastOrderedRef.current;
        if (previous.length === ordered.length
            && previous.every((task, index) => task === ordered[index])) {
            return previous;
        }
        lastOrderedRef.current = ordered;
        return ordered;
        // minuteTick is the clock input described above — it carries no value, only a change.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibleTasks, minuteTick]);

    // Task time monitoring — 80% warning and 100% limit
    const { warningPopup, limitPopup, dismissWarning, requestExtension, finishFromLimit } = useTaskTimeMonitor(tasks);

    // Keep the running task's timer "alive" with a per-minute heartbeat so a reload mid-shift can
    // be recovered as continuous work (see useOrphanedTaskRecovery) instead of silently stopping.
    useTaskHeartbeat(tasks, currentUser);

    // Crash/reload recovery — heartbeat-aware: continue a briefly-reloaded timer, but pause a
    // genuinely abandoned one (auto-crediting the untracked gap, opt-out) so it neither credits
    // hours of ghost time nor silently drops real offline work.
    useOrphanedTaskRecovery(tasks, currentUser, legacyRecoveryOwns);
    useRevisionedTaskRecovery(tasks, currentUser, userData, timerEngineEnabled);

    // Heartbeat for the running secondary session (break/call/quick-work) — lets the recovery below
    // finalize a genuinely abandoned session at its last proof of life, not the reopen instant.
    useSessionHeartbeat(currentUser);

    // Same crash/reload recovery for an orphaned break/call/quick-work session — ends it (clamped to
    // 16h, now at the last heartbeat when available) so a forgotten secondary timer can't credit a
    // multi-day "ghost" gap.
    // Split by owning engine, exactly like the task recovery above: the legacy closer only clears
    // projection flags, so it must not run against a canonical run.
    useOrphanedSessionRecovery(currentUser, legacyRecoveryOwns);
    useRevisionedSecondaryRecovery(currentUser, userData, timerEngineEnabled);


    useEffect(() => {
        if (!currentUser || usersLoading) return;

        let unsubscribe = () => { };

        try {
            const q = query(
                collection(db, 'tasks'),
                where('assignedUserId', '==', currentUser.uid)
            );

            unsubscribe = onSnapshot(q, (snapshot) => {
                setRawTasks(snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                })));
                setTasksLoaded(true);
                setError(null);
            }, (err) => {
                logError(err, { source: 'onSnapshot:workerTasks' });
                setError("Nepavyko užkrauti užduočių. Bandykite vėliau.");
                // Stop waiting: the error banner is the honest signal now, and holding the list in
                // a permanent loading state would hide it behind a spinner that never resolves.
                setTasksLoaded(true);
            });
        } catch (err) {
            console.error("Error setting up tasks listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
            setTasksLoaded(true);
        }

        const handleOpenTaskModal = (e) => {
            // A bare event opens a blank create modal; a `detail.task` (from the notification bell,
            // e.g. opening a task that was returned for rework) opens that task for editing.
            setEditingTask(e?.detail?.task || null);
            setIsModalOpen(true);
        };
        window.addEventListener('open-task-modal', handleOpenTaskModal);

        // After a worker finishes their OWN task (either finish door), prompt for a work-end proof
        // photo. The earnings breakdown — when a pay rate is set — rides along as showEarnings and is
        // shown only once this modal closes (chained in the modal's onClose), never stacked over it.
        const handleCompletionPhoto = (e) => {
            if (e?.detail?.task) {
                setCompletionPhoto({
                    task: e.detail.task,
                    totalMinutes: e.detail.totalMinutes,
                    showEarnings: !!e.detail.showEarnings,
                });
            }
        };
        window.addEventListener('request-completion-photo', handleCompletionPhoto);

        return () => {
            unsubscribe();
            window.removeEventListener('open-task-modal', handleOpenTaskModal);
            window.removeEventListener('request-completion-photo', handleCompletionPhoto);
        };
        // usersMap is deliberately NOT a dependency — the same trap useManagerData documents.
        // UsersContext rebuilds it as a brand-new object inside its whole-collection onSnapshot, so
        // its identity changes on EVERY write to ANY user doc, and a running session heartbeats its
        // user doc once a minute. Depending on it tore down and re-created this listener (plus both
        // window listeners) several times a minute per connected device, and Firestore bills the
        // initial snapshot of each new listener — so a worker re-read their whole task list because
        // an unrelated colleague's timer ticked. The names it supplies are applied in the
        // visibleTasks memo above, which is free to re-run on every roster change.
    }, [currentUser, usersLoading]);

    // The clock tick for the ordering (see minuteTick). Its own effect with no dependencies, so it
    // is never torn down by an unrelated re-subscription.
    useEffect(() => {
        const id = setInterval(() => setMinuteTick(tick => tick + 1), 60000);
        return () => clearInterval(id);
    }, []);

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

    // The roster handed to Reports must be the FIRESTORE user document, never the Firebase Auth
    // object. Every consumer keys on the Firestore shape: DailyStatistics derives the live "⏳
    // (Vykdoma)" band from `u.activeSession` matched by `u.id`, and reportData/Reports look up
    // `weeklyExpectedHours` + `payRate` by `id`. The Auth object carries only uid/displayName/email,
    // so passing it silently blanked all of those — a worker's currently-running task had no live
    // band and the gap-filler painted that stretch as "Neaktyvus" (their own work shown as idle),
    // while Planuota/Skirtumas fell back to 0 for anyone whose plan comes from the baseline.
    const reportUsers = useMemo(
        () => (currentUser?.uid && usersMap[currentUser.uid] ? [usersMap[currentUser.uid]] : []),
        [usersMap, currentUser?.uid]
    );

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

                {!tasksLoaded ? (
                    <div className="rounded-card border border-line bg-surface-card shadow-sm p-8">
                        <Spinner label="Kraunamos užduotys…" />
                    </div>
                ) : sortedTasks.length === 0 ? (
                    <div className="rounded-card border border-line bg-surface-card shadow-sm">
                        <EmptyState
                            icon={ClipboardList}
                            title={filterTag || debouncedSearch.trim() ? "Pagal pasirinktus filtrus užduočių nerasta" : "Kol kas užduočių nėra"}
                            description={
                                filterTag || debouncedSearch.trim()
                                    ? "Nė viena užduotis neatitinka pasirinktos žymos ar paieškos frazės."
                                    : "Kai koordinatorius priskirs užduotį, ji atsiras čia. Tuo tarpu galite pažymėti greitą veiklą ar skambutį mygtukais apačioje."
                            }
                            action={
                                filterTag || debouncedSearch.trim() ? (
                                    <Button
                                        variant="secondary"
                                        onClick={() => {
                                            setFilterTag('');
                                            setSearchText('');
                                        }}
                                    >
                                        Išvalyti filtrus
                                    </Button>
                                ) : (
                                    <Button
                                        variant="primary"
                                        onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                                    >
                                        Sukurti užduotį
                                    </Button>
                                )
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
                            />
                        </div>
                    </>
                )}

                {/* Today's finished work — tasks, greiti darbai and skambučiai — collapsed at the
                    bottom, below the active list. */}
                <CompletedTodayDisclosure tasks={completedToday} />
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
                        <Reports users={reportUsers} />
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

            {/* Post-finish work-end photo prompt (skippable). On close, chain the earnings popup when
                a pay rate was set, so the two never stack. */}
            {completionPhoto && (
                <CompletionPhotoModal
                    task={completionPhoto.task}
                    onClose={() => {
                        const pending = completionPhoto;
                        setCompletionPhoto(null);
                        if (pending?.showEarnings && pending.task) {
                            setEarnings({ task: pending.task, totalMinutes: pending.totalMinutes });
                        }
                    }}
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

