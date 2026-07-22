import { lazy, Suspense, useState, useEffect, useMemo, useCallback } from 'react';
import { Trophy, BarChart3, TrendingUp, UserCog, CheckCircle2, AlertTriangle, ClipboardList } from 'lucide-react';
import clsx from 'clsx';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../firebase';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { useAchievements } from '../hooks/useAchievements';
import { formatDisplayName } from '../utils/formatters';
import { BADGE_ICONS, tierKey } from '../utils/badgeCatalog';
import { canSeeWholeTeam, isScopedOverseer, isOverseenBy, scopeRoster } from '../utils/teamScope';
import { assignTask, humanActor, MODES } from '../domain';
import { logError } from '../utils/errorLog';
import Modal from './ui/Modal';
import Avatar from './ui/Avatar';
import StatusPill from './ui/StatusPill';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';
import DatePicker from './ui/DatePicker';
import Button from './ui/Button';
import Select from './ui/Select';
import { Spinner } from './ui/Loading';
import { PeriodPicker } from './reports/PeriodPicker';
import { PERIOD_PRESETS, resolvePresetRange } from './reports/periodPresets';
import { getLithuanianDateString } from '../utils/timeUtils';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';

// ── Bulk reassign (sick / away) — pure eligibility core ──────────────────────────────────────
// When a worker is out, an overseer can move their UNFINISHABLE open work onto someone present.
// "Unfinishable" is deliberately narrow (founder constraint): a task qualifies ONLY when it has a
// concrete deadline AND that deadline falls while the worker is still away — i.e. the deadline day
// is on or before the worker's last absence day. A task with no deadline, or a deadline that lands
// on or after the day the worker is back, is EXCLUDED: the worker can still do it when they return,
// so moving it would just churn ownership. Everything is compared as Vilnius calendar-day strings
// (YYYY-MM-DD sorts chronologically), bucketed the same way the rest of the app buckets time.

// Open = still actionable. A worker who is away blocks exactly these; completed/confirmed/archived
// tasks need no reassignment.
const OPEN_TASK_STATUSES = ['pending', 'in-progress'];
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export const isOpenTask = (task) => OPEN_TASK_STATUSES.includes(task?.status);

// The worker's last absence day (Vilnius), or null if they have no recorded absence. work_hours has
// no date field — an absence is an isVacation doc with ISO start/end — so each absence day is the
// Vilnius bucket of its `start`. We take the MAX: the window "ends" on the last day they are out.
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export function absenceWindowEnd(workHoursDocs) {
    let end = null;
    for (const doc of workHoursDocs || []) {
        if (!doc?.isVacation) continue;
        const stamp = doc.start || doc.end || doc.date;
        if (!stamp) continue;
        const day = getLithuanianDateString(new Date(stamp));
        if (!day) continue;
        if (end === null || day > end) end = day;
    }
    return end;
}

// A task's deadline as a Vilnius calendar day, or null when it carries no deadline. The stored
// value may be an ISO timestamp or a bare YYYY-MM-DD; bucketing through getLithuanianDateString
// normalizes both to the same day the deadline actually lands on in Vilnius.
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export function taskDeadlineDay(task) {
    if (!task?.deadline) return null;
    const day = getLithuanianDateString(new Date(task.deadline));
    return day || null;
}

/**
 * computeReassignEligibility — split a worker's OPEN tasks into those worth reassigning while they
 * are away and those that should stay. Pure (exported for unit tests).
 *
 * @param {object[]} tasks - the worker's tasks (any status; only open ones are considered).
 * @param {object[]} workHoursDocs - the worker's work_hours docs (only isVacation ones matter).
 * @returns {{ windowEnd: string|null, eligible: object[], ineligible: object[] }}
 *   windowEnd  — last absence day (Vilnius) or null when no absence is recorded.
 *   eligible   — open tasks with a deadline on/before windowEnd (worker can't finish in time).
 *   ineligible — the remaining open tasks (no deadline, or deadline once the worker is back).
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export function computeReassignEligibility(tasks, workHoursDocs) {
    const windowEnd = absenceWindowEnd(workHoursDocs);
    const eligible = [];
    const ineligible = [];
    for (const task of tasks || []) {
        if (!isOpenTask(task)) continue;
        const deadlineDay = taskDeadlineDay(task);
        // Eligible only with a concrete deadline that lands while the worker is still away. No
        // absence window on record => nothing qualifies (we cannot prove they can't finish in time).
        if (windowEnd && deadlineDay && deadlineDay <= windowEnd) eligible.push(task);
        else ineligible.push(task);
    }
    return { windowEnd, eligible, ineligible };
}

// How to fetch ONE worker's tasks for the reassign list, following the app's read-scope rule
// (teamScope §privateScopeConstraints): a scoped overseer may only request rows their subtree stamp
// covers, and a row's `teamManagerIds` array-contains the viewer is the ONLY filter the rules allow
// them — it CANNOT be ANDed with an `assignedUserId ==` equality in the same query (Firestore would
// need a composite index that does not exist, and the established surfaces never compose them, so
// the query silently yields nothing). So for a scoped overseer we fetch their whole subtree slice
// (`teamManagerIds array-contains`) and narrow to this worker client-side; a whole-team viewer
// (admin / unscoped manager) queries the worker's rows directly. Returns the query constraints to
// spread plus whether the result still needs the owner filter applied in JS.
//
// @returns {{ constraints: import('firebase/firestore').QueryConstraint[], filterOwnerClientSide: boolean }}
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests.
export function workerTasksQuerySpec({ workerId, viewerData, viewerUid }) {
    if (isScopedOverseer(viewerData) && viewerUid) {
        return {
            constraints: [where('teamManagerIds', 'array-contains', viewerUid)],
            filterOwnerClientSide: true,
        };
    }
    return {
        constraints: [where('assignedUserId', '==', workerId)],
        filterOwnerClientSide: false,
    };
}

// The day-report drill-down is heavy (its own Firestore listeners), so it only mounts when a
// manager actually switches to the "Statistika" tab — never on the achievements view.
const DailyStatistics = lazy(() => import('./DailyStatistics'));

// The aggregated "Suvestinė" surface (its own period queries + compute) is heavier still, so it
// also only mounts when a manager switches to that tab — never on achievements or the day report.
const WorkerStatsPanel = lazy(() => import('./stats/WorkerStatsPanel'));

// Role presentation — color paired with text (DESIGN_SYSTEM §5), with the rank insignia
// (ADR 0010). `seniorManager` must be present: without it a Vyr. vadovas peer profile fell back
// to the worker entry and read "Vykdytojas".
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    seniorManager: { label: 'Vyr. koordinatorius', tone: 'info' },
    manager: { label: 'Koordinatorius', tone: 'info' },
    worker: { label: 'Meistras', tone: 'neutral' },
};

// One eligible-task row: a checkbox + the task title and its deadline. Native checkbox (the app has
// no canonical Checkbox component); the whole row is the label so the 44px target covers text too.
function ReassignTaskRow({ task, checked, onToggle }) {
    const deadlineDay = taskDeadlineDay(task);
    return (
        <label className="flex min-h-touch cursor-pointer items-start gap-3 rounded-control border border-line bg-surface-card p-3 hover:bg-surface-sunken/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand">
            <input
                type="checkbox"
                checked={checked}
                onChange={() => onToggle(task.id)}
                className="mt-0.5 h-5 w-5 shrink-0 rounded border-line text-brand focus:ring-brand"
            />
            <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-ink-strong">
                    {task.title || 'Be pavadinimo'}
                </span>
                {deadlineDay && (
                    <span className="mt-0.5 block text-caption text-ink-muted">Terminas: {deadlineDay}</span>
                )}
            </span>
        </label>
    );
}

/**
 * BulkReassignModal — move an absent worker's UNFINISHABLE open tasks (see computeReassignEligibility)
 * onto someone who is present. Self-contained: it loads the worker's open tasks and absence window
 * on open, lets the overseer pick which eligible tasks to move and one in-scope target, then loops
 * each selected task through the audited assignTask COMMIT command, reporting per-task success/failure.
 *
 * Why per-task and not one bulk write: assignTask is the first-class, audited assignment operation
 * (ADR 0015) — every move leaves its own decision_log entry, and one task failing (e.g. a rule denial)
 * must not silently take the rest down. The Firestore rules remain the real authority on each write.
 */
function BulkReassignModal({ worker, viewerUser, viewerData, viewerUid, roster, onClose }) {
    const [loading, setLoading] = useState(true);
    const [loadError, setLoadError] = useState('');
    const [eligible, setEligible] = useState([]);
    const [ineligibleCount, setIneligibleCount] = useState(0);
    const [windowEnd, setWindowEnd] = useState(null);
    const [selectedIds, setSelectedIds] = useState(() => new Set());
    const [targetId, setTargetId] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [results, setResults] = useState(null); // null until a run completes: { ok, failed }

    const workerName = formatDisplayName(worker?.displayName || worker?.email || 'Meistras');

    // Scope-determining primitives, pulled out of `viewerData` for the load effect below.
    // `viewerData` is AuthContext's live user doc: a BRAND-NEW object identity on every snapshot,
    // including metadata-only ones and the viewer's own heartbeat/status writes. Depending on the
    // object would re-run the load while the modal is open and re-seed `selectedIds` to "all
    // checked", so tasks the manager had deliberately unchecked would still get reassigned.
    // Same pattern as useAssigneeAffinity / DailyStatistics.
    const viewerRole = viewerData?.role;
    const viewerScopedManager = viewerData?.scopedManager;

    // Load the worker's open tasks + absence window once on open. The task query mirrors the report
    // surfaces (see workerTasksQuerySpec): a whole-team viewer queries the worker's rows by
    // assignedUserId; a SCOPED overseer instead fetches their subtree slice by the teamManagerIds
    // stamp — the only filter the rules allow them — then narrows to this worker client-side, because
    // the two constraints cannot be ANDed in one query.
    useEffect(() => {
        let cancelled = false;
        if (!worker?.id) return undefined;
        (async () => {
            setLoading(true);
            setLoadError('');
            try {
                const { constraints, filterOwnerClientSide } = workerTasksQuerySpec({
                    workerId: worker.id,
                    viewerData,
                    viewerUid,
                });
                const tasksQ = query(collection(db, 'tasks'), ...constraints);
                // work_hours has no date field and is world-readable; fetch the worker's docs by userId
                // and bucket the absence days client-side.
                const whQ = query(collection(db, 'work_hours'), where('userId', '==', worker.id));
                const [tasksSnap, whSnap] = await Promise.all([getDocs(tasksQ), getDocs(whQ)]);
                if (cancelled) return;
                let tasks = tasksSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
                // Scoped overseer fetched their whole subtree slice — keep only this worker's tasks.
                if (filterOwnerClientSide) tasks = tasks.filter((t) => t.assignedUserId === worker.id);
                const whDocs = whSnap.docs.map((d) => d.data());
                const { windowEnd: end, eligible: elig, ineligible } = computeReassignEligibility(tasks, whDocs);
                setEligible(elig);
                setIneligibleCount(ineligible.length);
                setWindowEnd(end);
                setSelectedIds(new Set(elig.map((t) => t.id))); // default: all eligible pre-checked
            } catch (err) {
                if (cancelled) return;
                logError(err, { source: 'BulkReassignModal.load', workerId: worker.id });
                setLoadError('Nepavyko užkrauti meistro užduočių. Bandykite dar kartą.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
        // Only the scope-determining primitives (see above) — never the whole `viewerData` object.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [worker?.id, viewerRole, viewerScopedManager, viewerUid]);

    // Target candidates: the viewer's in-scope roster MINUS the absent worker themselves and any
    // disabled account (you cannot hand work to someone who is blocked).
    const targetOptions = useMemo(() => {
        return scopeRoster(roster || [], viewerData, viewerUid)
            .filter((u) => u.id !== worker?.id && !u.isDisabled)
            .map((u) => ({ value: u.id, label: formatDisplayName(u.displayName || u.email || u.id) }));
    }, [roster, viewerData, viewerUid, worker?.id]);

    const toggle = useCallback((id) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }, []);

    const allSelected = eligible.length > 0 && selectedIds.size === eligible.length;
    const toggleAll = () => {
        setSelectedIds(allSelected ? new Set() : new Set(eligible.map((t) => t.id)));
    };

    const targetUser = (roster || []).find((u) => u.id === targetId) || null;
    const targetName = targetUser ? formatDisplayName(targetUser.displayName || targetUser.email || targetId) : '';
    const canSubmit = !submitting && selectedIds.size > 0 && !!targetId;

    // Loop each chosen task through assignTask COMMIT. Per-task isolation: one refusal/failure is
    // recorded and the rest proceed. A human viewer is the actor (the agent-commit boundary in the
    // command would refuse an agent here).
    const handleSubmit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        const actor = humanActor({
            uid: viewerUid,
            displayName: viewerUser?.displayName,
            email: viewerUser?.email,
            role: viewerData?.role,
        });
        const chosen = eligible.filter((t) => selectedIds.has(t.id));
        const ok = [];
        const failed = [];
        for (const task of chosen) {
            try {
                const res = await assignTask(
                    { task: { id: task.id, title: task.title, assignedUserId: task.assignedUserId }, worker: { id: targetId, name: targetName } },
                    { actor, mode: MODES.COMMIT, reason: `Bulk reassign: ${workerName} away` },
                );
                if (res?.ok) ok.push(task);
                else failed.push({ task, reason: res?.reason || 'atmesta' });
            } catch (err) {
                logError(err, { source: 'BulkReassignModal.assign', taskId: task.id });
                failed.push({ task, reason: 'klaida' });
            }
        }
        setResults({ ok: ok.length, failed });
        setSubmitting(false);
    };

    const footer = results ? (
        <Button variant="primary" fullWidth onClick={onClose}>Uždaryti</Button>
    ) : (
        <div className="flex flex-col gap-2">
            <Button
                variant="primary"
                fullWidth
                icon={UserCog}
                loading={submitting}
                disabled={!canSubmit}
                onClick={handleSubmit}
            >
                {selectedIds.size > 0 ? `Perskirti (${selectedIds.size})` : 'Perskirti'}
            </Button>
            <Button variant="secondary" fullWidth disabled={submitting} onClick={onClose}>Atšaukti</Button>
        </div>
    );

    return (
        <Modal
            open
            onClose={submitting ? undefined : onClose}
            title={`Perskirti veiklas — ${workerName}`}
            size="lg"
            dismissible={!submitting}
            closeOnBackdrop={false}
            footer={footer}
        >
            {loading ? (
                <Spinner label="Kraunamos užduotys…" />
            ) : loadError ? (
                <div className="flex items-start gap-2 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
                    <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
                    <span>{loadError}</span>
                </div>
            ) : results ? (
                // Post-run report: how many moved, and which (if any) failed and why.
                <div className="space-y-3">
                    <div className="flex items-start gap-2 rounded-control bg-feedback-success-soft p-3 text-body text-feedback-success-text">
                        <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
                        <span>{`Perskirta užduočių: ${results.ok} ${targetName ? `→ ${targetName}` : ''}`}</span>
                    </div>
                    {results.failed.length > 0 && (
                        <div className="space-y-1 rounded-control bg-feedback-danger-soft p-3 text-body text-feedback-danger-text">
                            <p className="flex items-center gap-2 font-medium">
                                <AlertTriangle className="h-5 w-5 shrink-0" aria-hidden="true" />
                                {`Nepavyko perskirti: ${results.failed.length}`}
                            </p>
                            <ul className="ml-7 list-disc space-y-0.5">
                                {results.failed.map((f) => (
                                    <li key={f.task.id}>{f.task.title || 'Be pavadinimo'}</li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            ) : eligible.length === 0 ? (
                <EmptyState
                    icon={ClipboardList}
                    title="Nėra perskirstytinų veiklų"
                    description={
                        windowEnd
                            ? 'Visos atviros veiklos turi terminą po meistro grįžimo arba neturi termino — jas meistras spės atlikti pats.'
                            : 'Meistras neturi pažymėto nebuvimo laikotarpio, todėl perskirstytinų veiklų nustatyti negalima.'
                    }
                />
            ) : (
                <div className="space-y-4">
                    <p className="text-body text-ink-muted">
                        {`Šios atviros veiklos turi terminą, kurio meistras nespės įvykdyti iki grįžimo${windowEnd ? ` (nebuvimas iki ${windowEnd})` : ''}. Pasirinkite, ką perskirti, ir kam.`}
                    </p>

                    <div>
                        <label htmlFor="reassign-target" className="mb-1 block text-caption font-medium text-ink-muted">
                            Kam perskirti
                        </label>
                        <Select
                            id="reassign-target"
                            value={targetId}
                            onChange={setTargetId}
                            options={targetOptions}
                            label="Meistras"
                            placeholder="Pasirinkite meistrą…"
                            alwaysSheet
                        />
                    </div>

                    <div>
                        <div className="mb-2 flex items-center justify-between">
                            <span className="text-caption font-medium text-ink-muted">{`Veiklos (${eligible.length})`}</span>
                            <button
                                type="button"
                                onClick={toggleAll}
                                className="inline-flex min-h-touch items-center rounded-control px-2 text-body font-medium text-brand hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            >
                                {allSelected ? 'Nuimti visus' : 'Pažymėti visus'}
                            </button>
                        </div>
                        <div className="space-y-2">
                            {eligible.map((task) => (
                                <ReassignTaskRow
                                    key={task.id}
                                    task={task}
                                    checked={selectedIds.has(task.id)}
                                    onToggle={toggle}
                                />
                            ))}
                        </div>
                    </div>

                    {ineligibleCount > 0 && (
                        <p className="text-caption text-ink-muted">
                            {`Dar ${ineligibleCount} atvir(a/os) veikl(a/os) liko nepasiūlytos — be termino arba su terminu po grįžimo.`}
                        </p>
                    )}
                </div>
            )}
        </Modal>
    );
}

/**
 * UserProfileModal — the READ-ONLY peer profile (P2). Opened from any UserChip via the
 * ProfileViewer context. Shows identity (resolved from the live users map, no extra fetch) plus
 * the earned badge shelf. Earned-only: an empty shelf reads as "new here", never a deficit (W4).
 * Self-only controls (photo, settings, logout) live only on the owner's full ProfilePage.
 *
 * A manager who oversees this member also gets a "Statistika" tab — the same embedded day report
 * the team calendar drills into, scoped to this one member. Gated by the team-scope helpers so a
 * scoped manager only sees their own people's hours and the Firestore listeners never request a
 * row the rules would deny; whole-team viewers (admin / senior manager / unscoped manager) see
 * anyone's. Hidden for one's own chip — own stats live on the personal report surfaces.
 */
export default function UserProfileModal({ userId, onClose }) {
    const { usersMap, activeUsers } = useUsers();
    const { currentUser, userData, userRole } = useAuth();
    const { achievements } = useAchievements(userId);
    const [tab, setTab] = useState('achievements');
    // Bulk "Perskirti veiklas" flow — opens a self-contained modal that loads this worker's open
    // tasks + absence window and reassigns the unfinishable ones onto someone present.
    const [reassignOpen, setReassignOpen] = useState(false);

    // "Statistika" period selector — the same ladder (day → year + custom) the team report uses,
    // sitting in its own row above the day report. 'day' keeps DailyStatistics in its live single-
    // day mode (its own stepper); any other preset resolves a from/to range and switches the embedded
    // report to its aggregated span view. Mirrors Reports.jsx so the two surfaces behave identically.
    const [statsPeriod, setStatsPeriod] = useState('day');
    const [statsPeriodOpen, setStatsPeriodOpen] = useState(false);
    const [statsRange, setStatsRange] = useState(() => {
        const today = getLithuanianDateString();
        return { start: `${today.slice(0, 7)}-01`, end: today };
    });
    const chooseStatsPeriod = (period) => {
        setStatsPeriod(period);
        setStatsPeriodOpen(false);
        if (period !== 'day') {
            const range = resolvePresetRange(period);
            if (range) setStatsRange(range);
        }
    };

    const user = usersMap?.[userId];
    const name = formatDisplayName(user?.displayName || user?.email || 'Narys');
    const role = ROLE_META[user?.role] || ROLE_META.worker;

    // May the signed-in viewer see this member's work statistics? Whole-team viewers see anyone;
    // a scoped overseer (scoped manager or senior manager) only their own subtree. Never for one's
    // own chip.
    const isSelf = currentUser?.uid === userId;
    const canViewStats =
        !isSelf &&
        !!user &&
        (canSeeWholeTeam(userData) ||
            (isScopedOverseer(userData) && isOverseenBy(user, currentUser?.uid)));

    // The same overseer who may view this member's stats may also redistribute their work — but only
    // for a WORKER (the Vykdytojas, who carries assignable field tasks). The human-only commit
    // boundary in assignTask is the backstop; this just gates the entry point.
    const canReassign = canViewStats && user?.role === 'worker';

    const showStats = canViewStats && tab === 'stats';
    const showSummary = canViewStats && tab === 'summary';

    return (
        <>
        <Modal
            open
            onClose={onClose}
            ariaLabel={`${name} profilis`}
            size="xl"
            // Fill the scrim's padded line (`h-full`) so the member card reads as a full surface,
            // and widen further when the day report is shown. Deliberately NO max-h here: a
            // caller-side `max-h-[92vh]` is the same tailwind-merge group as Modal's
            // `max-h-[calc(100dvh-9rem)]` and would DELETE that cap — and `vh` measures the
            // URL-bar-hidden viewport, so the card grew taller than the visible area and the
            // close button plus the Pasiekimai/Statistika/Suvestinė tabs were clipped off the top
            // of a phone screen with no way to scroll them back (Modal.jsx §height cap).
            className={clsx('h-full', showStats && 'max-w-4xl')}
        >
            {/* Tab switch — sits ABOVE the identity block. Only a manager who oversees this member
                gets the statistics view. */}
            {canViewStats && (
                <div
                    className="mb-5 flex justify-center"
                    role="tablist"
                    aria-label="Profilio rodinys"
                >
                    <div className="flex overflow-hidden rounded-control border border-line bg-surface-sunken">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'achievements'}
                            onClick={() => setTab('achievements')}
                            className={clsx(
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'achievements' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <Trophy className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Pasiekimai
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'stats'}
                            onClick={() => setTab('stats')}
                            className={clsx(
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'stats' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <BarChart3 className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Statistika
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'summary'}
                            onClick={() => setTab('summary')}
                            className={clsx(
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'summary' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <TrendingUp className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Suvestinė
                        </button>
                    </div>
                </div>
            )}

            {/* Identity block — full (large centered avatar + role) on the achievements view; a
                compact left-aligned row (small avatar + name only) once a stats/summary tab is open
                so the data surface gets the room. */}
            {tab === 'achievements' ? (
                <div className="text-center">
                    <div className="mx-auto mb-3 h-20 w-20">
                        <Avatar src={user?.photoURL || null} name={user?.displayName} email={user?.email} size="lg" />
                    </div>
                    <p className="text-h3 font-semibold text-ink-strong">{name}</p>
                    <div className="mt-2 flex justify-center">
                        <StatusPill tone={role.tone} icon={ROLE_GLYPHS[user?.role]}>{role.label}</StatusPill>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 shrink-0">
                        <Avatar src={user?.photoURL || null} name={user?.displayName} email={user?.email} size="md" />
                    </div>
                    <p className="text-h3 font-semibold text-ink-strong">{name}</p>
                </div>
            )}

            {/* Overseer action — redistribute this worker's unfinishable open tasks while they are
                away. Shown on the achievements view (the at-a-glance profile) so it sits with the
                member's identity, not buried under a data tab. */}
            {canReassign && tab === 'achievements' && (
                <div className="mt-4 flex justify-center">
                    <Button variant="secondary" icon={UserCog} onClick={() => setReassignOpen(true)}>
                        Perskirti veiklas
                    </Button>
                </div>
            )}

            {showStats ? (
                <div className="mt-5 space-y-4">
                    {/* Period selector in its own row, separate from the report's hour totals —
                        same chip ladder + custom range as the team "Veiklos ataskaita" tab. */}
                    <PeriodPicker
                        presets={PERIOD_PRESETS}
                        activeId={statsPeriod}
                        onChoose={chooseStatsPeriod}
                        open={statsPeriodOpen}
                        onToggle={() => setStatsPeriodOpen((o) => !o)}
                        label="Laikotarpis"
                    >
                        <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
                            <div className="flex-1">
                                <label htmlFor="stats-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                                <DatePicker
                                    id="stats-from"
                                    value={statsRange.start}
                                    max={statsRange.end}
                                    onChange={(v) => { setStatsPeriod('custom'); setStatsRange((prev) => ({ ...prev, start: v })); }}
                                />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="stats-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                                <DatePicker
                                    id="stats-to"
                                    value={statsRange.end}
                                    min={statsRange.start}
                                    max={getLithuanianDateString()}
                                    onChange={(v) => { setStatsPeriod('custom'); setStatsRange((prev) => ({ ...prev, end: v })); }}
                                />
                            </div>
                        </div>
                    </PeriodPicker>

                    <Suspense
                        fallback={<div className="py-12 text-center text-body text-ink-muted">Kraunama dienos ataskaita…</div>}
                    >
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={activeUsers}
                            forceUserId={userId}
                            dateRange={statsPeriod === 'day' ? null : statsRange}
                            embedded
                        />
                    </Suspense>
                </div>
            ) : showSummary ? (
                <div className="mt-5">
                    <Suspense
                        fallback={<div className="py-12 text-center text-body text-ink-muted">Kraunama suvestinė…</div>}
                    >
                        <WorkerStatsPanel
                            userId={userId}
                            targetUser={user}
                            viewerData={userData}
                            viewerUid={currentUser?.uid}
                            viewerRole={userRole}
                        />
                    </Suspense>
                </div>
            ) : (
                <div className="mt-5">
                    <h3 className="mb-3 text-caption font-medium text-ink-muted">Pasiekimai</h3>
                    {achievements.length > 0 ? (
                        <div className="grid grid-cols-3 gap-4">
                            {achievements.map((a) => (
                                <Badge key={a.id} tier={tierKey(a.tier)} name={a.name} icon={BADGE_ICONS[a.key]} />
                            ))}
                        </div>
                    ) : (
                        <EmptyState
                            icon={Trophy}
                            title="Dar nėra ženkliukų"
                            description="Šis narys netrukus jų užsidirbs."
                        />
                    )}
                </div>
            )}
        </Modal>

        {reassignOpen && (
            <BulkReassignModal
                worker={user}
                viewerUser={currentUser}
                viewerData={userData}
                viewerUid={currentUser?.uid}
                roster={activeUsers}
                onClose={() => setReassignOpen(false)}
            />
        )}
        </>
    );
}
