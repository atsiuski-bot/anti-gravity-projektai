import { useEffect, useId, useMemo, useState } from 'react';
import { doc, getDoc, onSnapshot } from 'firebase/firestore';
import { Bookmark, CheckCircle2, RotateCcw, Trash2 } from 'lucide-react';
import { db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { useUsers } from '../context/UsersContext';
import { useReviewShelf } from '../hooks/useReviewShelf';
import { useUndoableAction } from '../hooks/useUndoableAction';
import { setOnReviewShelf, returnTaskForAddition } from '../utils/reviewShelf';
import { formatDisplayName } from '../utils/formatters';
import { logError } from '../utils/errorLog';
import TaskCard from './TaskCard';
import Card from './ui/Card';
import Modal from './ui/Modal';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import { CardSkeleton } from './ui/Loading';
import TaskActionRow from './task/TaskActionRow';

// A shelved task is "back for a look" once its Meistras has finished it — awaiting acceptance,
// accepted, or already swept into the archive. Anything else is still with the Meistras.
const isFinished = (task) => !!task.isArchived || task.status === 'completed' || task.status === 'confirmed';
const isDeleted = (task) => !!task.isDeleted || task.status === 'deleted';
const finishedAt = (task) => task.completedAt || task.confirmedAt || task.archivedAt || task.updatedAt || '';

/**
 * ReviewShelf — the "Peržiūrai" sub-tab of Kom. veiklos: the koordinatorius's own shelf of tasks they
 * marked to look at again later (utils/reviewShelf.js). Each task stays here, live, whatever it goes
 * through — finished, accepted, archived, returned and finished again — until they mark it
 * "Peržiūrėta". From here they open it (comment / edit in the usual preview) or send it back to the
 * Meistras with a note ("Grąžinti papildyti").
 *
 * Each shelved id is read ON ITS OWN (a live listener on /tasks, falling back to one read of
 * /archived_tasks once the task has left the active collection): a per-document read is what the
 * read rules allow a scoped manager, where a list query by "shelved by me" would be denied.
 *
 * @param {Object}   props
 * @param {Function} [props.onEditTask] opens the create/edit form for a live task
 */
export default function ReviewShelf({ onEditTask }) {
    const { currentUser } = useAuth();
    const { users } = useUsers();
    const shelf = useReviewShelf();
    const runUndoable = useUndoableAction();
    // id -> { state: 'ok', task } | { state: 'missing' }. Absent = still loading.
    const [entries, setEntries] = useState({});
    const [returnTarget, setReturnTarget] = useState(null);

    const idsKey = shelf.ids.join('|');
    useEffect(() => {
        const ids = idsKey ? idsKey.split('|') : [];
        let cancelled = false;
        const put = (id, entry) => { if (!cancelled) setEntries((prev) => ({ ...prev, [id]: entry })); };
        // Once a task leaves /tasks (the nightly archive, or a delete) its live read ends — as
        // exists=false for a whole-team reader, or permission-denied for a scoped one, since the
        // rule's team check has no document to read. Either way the task, if it still exists, is in
        // the archive.
        const readArchived = async (id) => {
            try {
                const snap = await getDoc(doc(db, 'archived_tasks', id));
                put(id, snap.exists() ? { state: 'ok', task: { ...snap.data(), id: snap.id, isArchived: true } } : { state: 'missing' });
            } catch (err) {
                logError(err, { source: 'ReviewShelf.readArchived' });
                put(id, { state: 'missing' });
            }
        };
        const unsubs = ids.map((id) => onSnapshot(
            doc(db, 'tasks', id),
            (snap) => {
                if (snap.exists()) put(id, { state: 'ok', task: { ...snap.data(), id: snap.id } });
                else readArchived(id);
            },
            () => readArchived(id),
        ));
        // Drop entries for ids no longer on the shelf.
        setEntries((prev) => Object.fromEntries(Object.entries(prev).filter(([id]) => ids.includes(id))));
        return () => {
            cancelled = true;
            unsubs.forEach((u) => u());
        };
    }, [idsKey]);

    const { ready, inProgress, missing, loading } = useMemo(() => {
        const out = { ready: [], inProgress: [], missing: [], loading: false };
        for (const id of shelf.ids) {
            const e = entries[id];
            if (!e) { out.loading = true; continue; }
            if (e.state === 'missing') { out.missing.push(id); continue; }
            (isFinished(e.task) || isDeleted(e.task) ? out.ready : out.inProgress).push(e.task);
        }
        // Most recently finished first — the result the manager is most likely waiting on.
        out.ready.sort((a, b) => String(finishedAt(b)).localeCompare(String(finishedAt(a))));
        return out;
    }, [shelf.ids, entries]);

    const markReviewed = (taskId) => runUndoable({
        run: () => setOnReviewShelf(currentUser.uid, taskId, false),
        undo: () => setOnReviewShelf(currentUser.uid, taskId, true),
        message: 'Pažymėta kaip peržiūrėta.',
        undoneMessage: 'Grąžinta į „Peržiūrai“.',
        errorMessage: 'Nepavyko pašalinti iš „Peržiūrai“. Bandykite dar kartą.',
    });

    const assigneeName = (task) => {
        const u = users?.find((x) => x.id === task.assignedUserId);
        return formatDisplayName(u?.displayName || u?.email || task.assignedUserName || '') || '';
    };

    const renderTask = (task) => {
        const live = !task.isArchived && !isDeleted(task);
        const canReturn = isFinished(task) && !isDeleted(task);
        const actions = [
            ...(canReturn ? [{ key: 'return', label: 'Grąžinti papildyti', compactLabel: 'Grąžinti', icon: RotateCcw, variant: 'secondary', onClick: () => setReturnTarget(task) }] : []),
            { key: 'reviewed', label: 'Peržiūrėta', icon: CheckCircle2, variant: 'secondary', onClick: () => markReviewed(task.id) },
        ];
        return (
            <li key={task.id}>
                <TaskCard
                    task={task}
                    role="manager"
                    surface="report"
                    actions={actions}
                    detailOverrides={{
                        canManage: true,
                        canDelete: false,
                        onEdit: live && onEditTask ? () => onEditTask(task) : undefined,
                        // The preview's own "Grąžinti" opens the same note-first return, never a bare revert.
                        onRevert: canReturn ? () => setReturnTarget(task) : undefined,
                    }}
                />
            </li>
        );
    };

    if (shelf.ids.length === 0) {
        return (
            <Card>
                <EmptyState
                    icon={Bookmark}
                    title="Peržiūrai nieko nėra"
                    description="Atidarykite užduotį arba „Pridavime“ paspauskite „Peržiūrai“ — užduotis bus laikoma čia, kol pažymėsite ją kaip peržiūrėtą."
                />
            </Card>
        );
    }

    return (
        <div className="space-y-6">
            <p className="text-body text-ink-muted">
                Jūsų pasižymėtos užduotys. Jos lieka čia, kol paspausite „Peržiūrėta“ — net ir priėmus ar suarchyvavus.
            </p>

            {ready.length > 0 && (
                <section aria-labelledby="review-shelf-ready">
                    <h3 id="review-shelf-ready" className="mb-2 text-body font-bold text-ink-strong">Atlikta — laukia peržiūros ({ready.length})</h3>
                    <ul className="grid gap-3 md:grid-cols-2">{ready.map(renderTask)}</ul>
                </section>
            )}

            {inProgress.length > 0 && (
                <section aria-labelledby="review-shelf-progress">
                    <h3 id="review-shelf-progress" className="mb-2 text-body font-bold text-ink-strong">Dar vykdoma ({inProgress.length})</h3>
                    <ul className="grid gap-3 md:grid-cols-2">{inProgress.map(renderTask)}</ul>
                </section>
            )}

            {missing.length > 0 && (
                <section aria-labelledby="review-shelf-missing">
                    <h3 id="review-shelf-missing" className="mb-2 text-body font-bold text-ink-strong">Nepasiekiamos ({missing.length})</h3>
                    <ul className="space-y-2">
                        {missing.map((id) => (
                            <li key={id}>
                                <Card className="flex items-center justify-between gap-3">
                                    <p className="text-body text-ink-muted">Užduotis ištrinta arba Jums nebepasiekiama.</p>
                                    <TaskActionRow actions={[{ key: 'remove', label: 'Pašalinti', icon: Trash2, variant: 'secondary', onClick: () => shelf.remove(id) }]} />
                                </Card>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            {loading && <CardSkeleton />}

            {returnTarget && (
                <ReturnForAdditionDialog
                    task={returnTarget}
                    assigneeName={assigneeName(returnTarget)}
                    onClose={() => setReturnTarget(null)}
                />
            )}
        </div>
    );
}

/**
 * "Grąžinti papildyti" — the note is REQUIRED: a task sent back without saying what to add leaves the
 * Meistras guessing, which is the whole problem this return exists to fix.
 */
function ReturnForAdditionDialog({ task, assigneeName, onClose }) {
    const { currentUser } = useAuth();
    const { showToast } = useToast();
    const fieldId = useId();
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const trimmed = text.trim();

    const submit = async () => {
        if (!trimmed || busy) return;
        setBusy(true);
        setError('');
        try {
            const { partial } = await returnTaskForAddition({ task, text: trimmed, user: currentUser });
            // A partial result means the task IS back with the Meistras and only the note failed, so
            // the dialog must close either way — pressing Grąžinti again would reopen it a second time.
            showToast(
                partial
                    ? 'Užduotis grąžinta, bet komentaras neišsaugotas — parašykite jį užduoties komentaruose.'
                    : 'Užduotis grąžinta papildyti.',
                { tone: partial ? 'warning' : 'success' },
            );
            onClose();
        } catch (err) {
            logError(err, { source: 'ReviewShelf.returnTaskForAddition' });
            setError('Nepavyko grąžinti užduoties. Patikrinkite ryšį ir bandykite dar kartą.');
            setBusy(false);
        }
    };

    return (
        <Modal open onClose={onClose} title="Grąžinti papildyti" size="sm" dismissible={!busy}>
            <div className="space-y-3">
                <p className="text-body text-ink">
                    {/* The name stays in the nominative ("Meistras: …") — Lithuanian names can't be
                        declined reliably in code, so the sentence is built not to need it. */}
                    „{task.title}“ grįš į aktyvių užduočių sąrašą
                    {assigneeName && <> (Meistras: <span className="font-semibold">{assigneeName}</span>)</>}.
                    {' '}Jūsų komentaras bus pridėtas prie užduoties ir nusiųstas pranešime.
                </p>
                <div>
                    <label htmlFor={fieldId} className="mb-1 block text-caption font-medium text-ink-muted">
                        Ką papildyti? (privaloma)
                    </label>
                    <textarea
                        id={fieldId}
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        rows={4}
                        maxLength={2000}
                        placeholder="pvz. Trūksta nuorodos į sąmatą — pridėkite ją ir parašykite, kas toliau."
                        className="min-h-touch w-full rounded-input border border-line bg-surface-card px-3 py-2 text-body-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-ring"
                    />
                </div>
                {error && <p role="alert" className="text-body text-feedback-danger-text">{error}</p>}
                <div className="flex flex-col gap-2 pt-2">
                    <Button variant="primary" size="lg" fullWidth icon={RotateCcw} onClick={submit} loading={busy} disabled={!trimmed}>
                        Grąžinti
                    </Button>
                    <Button variant="secondary" size="lg" fullWidth onClick={onClose} disabled={busy}>
                        Atšaukti
                    </Button>
                </div>
            </div>
        </Modal>
    );
}
