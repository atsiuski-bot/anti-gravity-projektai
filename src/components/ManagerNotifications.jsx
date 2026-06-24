import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, arrayUnion, getDoc, addDoc, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { format, parseISO, formatDistanceToNow } from 'date-fns';
import { lt } from 'date-fns/locale';
import { X, AlertCircle, Check, CheckCircle2, XCircle, Trash2, Edit, MessageCircle, Clock, RotateCcw, ListTodo, BellOff, Bell, Plus, Ban, UserPlus, Hand, Hourglass } from 'lucide-react';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { notify, categoryOf } from '../utils/notify';
import { notificationCopy } from '../notifications/registry';
import { cn } from '../utils/cn';
import UserChip from './UserChip';
import TaskCard from './TaskCard';
import TaskActionRow from './task/TaskActionRow';
import { deleteTask, extendTaskTime } from '../utils/taskActions';
import { approveTask, unapproveTask, confirmTask, unconfirmTask, humanActor, MODES } from '../domain';
import { useUndoableAction } from '../hooks/useUndoableAction';
import { logCalendarChange } from '../utils/calendarNotifications';
import { getLithuanianWeekId } from '../utils/timeUtils';
import { DeleteConfirmationModal } from './TaskDetailsModals';
import IconButton from './ui/IconButton';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import { TimeUpGlyph, TimeGrantedGlyph, TimeDeniedGlyph } from './icons/timeGlyphs';

// History view caps how many read notifications it renders at once. A recipient's read backlog grows
// without bound (notifications are never deleted), so the list is sorted newest-first and sliced —
// the cap is surfaced (not silent) when it bites, so "older ones exist" is never hidden.
const HISTORY_CAP = 100;

// Glyph for a read/past notification in the history list. Mirrors the active feed's per-type icons so
// a notification looks the same once archived; unknown/legacy types degrade to a neutral bell.
const HISTORY_ICONS = {
    task_approval: CheckCircle2, task_completion: CheckCircle2, task_confirmed: CheckCircle2,
    task_assigned: ListTodo, task_approved: CheckCircle2,
    task_edited: Edit, task_unassigned: Edit, task_deleted: Trash2,
    task_reverted: RotateCcw,
    time_extension_request: Clock, extension_granted: Clock, extension_denied: Clock,
    task_priority_escalated: Clock,
    new_comment: MessageCircle, new_photo: MessageCircle,
    calendar_decision: AlertCircle,
    session_edited: Edit, session_deleted: Trash2, session_auto_closed: Clock,
    session_correction_request: AlertCircle,
    account_approval: UserPlus, recurring_reassign: AlertCircle,
    task_needs_manager: Hand, task_waiting: Hourglass,
    achievement: CheckCircle2, task_overdue: AlertCircle,
};
const historyIcon = (type) => HISTORY_ICONS[type] || Bell;

/**
 * NotificationFeed — the two-way feed rendered inside the notification bell's panel.
 *
 * It merges three live Firestore sources for the signed-in user and renders them as a HYBRID:
 *   - ACTION items (a manager's pending approvals/completions/time-extensions/calendar requests,
 *     and a worker's "returned for rework") are full cards with decision buttons; they stay until
 *     the underlying work is resolved.
 *   - INFO items (comments, and a worker's assigned/approved/confirmed/extension/calendar-decision
 *     notices) are compact read/unread rows.
 *
 * The `request_notifications` listener is recipient-keyed, so it serves workers AND managers; the
 * two calendar listeners are manager-only (a worker neither monitors nor approves calendars).
 * `onClose` lets an action that navigates away (edit-and-approve / open a task) also close the
 * bell panel that hosts this feed.
 */
/**
 * NotificationTaskCard — renders a completed-work approval as the SAME spacious TaskCard the team
 * task list uses, so a manager sees (and acts on) a reported task identically in both places.
 *
 * The notification carries only taskId/taskTitle, so this wrapper subscribes to the live task doc
 * and feeds it to TaskCard in `signoffOnly` mode, so the completion card offers exactly the two
 * decisions a finished task needs — Priimti / Grąžinti (Grąžinti reopens the editor). The optional
 * post-action hooks below are what keep the two-way feed honest — after the card's own write
 * succeeds they dismiss this notification and notify the worker.
 */
function NotificationTaskCard({ taskId, onEdit, onConfirmed, onReverted, onDeleted }) {
    const [task, setTask] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        if (!taskId) { setLoading(false); return undefined; }
        const unsub = onSnapshot(
            doc(db, 'tasks', taskId),
            (snap) => {
                setTask(snap.exists() ? { id: snap.id, ...snap.data() } : null);
                setLoading(false);
            },
            (err) => {
                console.error('NotificationTaskCard: task listener error:', err);
                setLoading(false);
            }
        );
        return () => unsub();
    }, [taskId]);

    if (loading) {
        return <div className="h-28 max-w-xl animate-pulse rounded-card border border-line bg-surface-card shadow-sm" />;
    }
    // Task already gone (deleted/archived): the completion notice is stale — render nothing.
    if (!task) return null;

    return (
        <div className="max-w-xl">
            <TaskCard
                task={task}
                role="manager"
                onEdit={onEdit}
                onConfirmed={onConfirmed}
                onReverted={onReverted}
                onDeleted={onDeleted}
                signoffOnly
            />
        </div>
    );
}

export default function ManagerNotifications({ onClose }) {
    const { currentUser, userRole } = useAuth();
    const { setActiveTab } = useNavigation();
    const isManager = isManagerRole(userRole);
    const runUndoable = useUndoableAction();
    const [view, setView] = useState('active'); // 'active' (live feed) | 'history' (read/past notices)
    const [calendarNotifications, setCalendarNotifications] = useState([]);
    const [calendarRequests, setCalendarRequests] = useState([]);
    const [taskNotifications, setTaskNotifications] = useState([]);
    const [historyNotifications, setHistoryNotifications] = useState([]); // read request_notifications, lazy-loaded
    const [deleteModalData, setDeleteModalData] = useState(null); // { taskId, notificationId, taskTitle }
    const [actionError, setActionError] = useState(null); // friendly Lithuanian error message for the inline alert region
    const [actionNotice, setActionNotice] = useState(null); // neutral Lithuanian notice (e.g. an orphaned request was cleared) — not an error
    const [bulkConfirming, setBulkConfirming] = useState(false); // batch "approve all completions" in flight
    const [bulkApprovingCal, setBulkApprovingCal] = useState(false); // batch "approve all calendar requests" in flight
    const [markingAll, setMarkingAll] = useState(false); // "mark all read" in flight
    const [grantingExt, setGrantingExt] = useState(null); // notif.id of an in-flight one-tap time grant


    // 1. Calendar Notifications (manager-only — workers don't monitor the team calendar)
    useEffect(() => {
        if (!currentUser || !isManager) { setCalendarNotifications([]); return undefined; }

        // Week key = Monday of the Vilnius calendar week. MUST match logCalendarChange's writer
        // key (both derive it via getLithuanianWeekId), so a manager and worker in different
        // timezones near the Monday boundary cannot compute different week strings — which would
        // otherwise hide the worker's calendar change from the manager (silent notification loss).
        const weekId = getLithuanianWeekId();

        const q = query(
            collection(db, 'calendar_notifications'),
            where('weekStart', '==', weekId)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const notifs = snapshot.docs.map(doc => ({
                id: doc.id,
                source: 'calendar',
                ...doc.data()
            })).filter(n => !n.dismissedBy?.includes(currentUser.uid));

            setCalendarNotifications(notifs);
        }, (error) => {
            console.error("ManagerNotifications: Calendar Listener Error:", error);
        });

        return () => unsubscribe();
    }, [currentUser, isManager]);

    // 2. Task Verification Notifications (New Logic)
    useEffect(() => {
        if (!currentUser) return;

        const q = query(
            collection(db, 'request_notifications'),
            where('recipientId', '==', currentUser.uid),
            where('isRead', '==', false)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const notifs = snapshot.docs.map(doc => ({
                id: doc.id,
                source: 'task',
                ...doc.data()
            }));

            // The audible cue for a new notification now lives on the always-on foreground plane
            // (NotificationsContext → SoundManager.playNotificationCue), so it fires for every type and
            // regardless of whether this panel is open — no per-panel playBeep needed here.
            setTaskNotifications(notifs);
        }, (error) => {
            console.error("ManagerNotifications: Task Notifications Listener Error:", error);
        });

        return () => unsubscribe();
    }, [currentUser]);

    // 3. Calendar Approval Requests (manager-only). These fan out to ALL of a worker's managers,
    // so query the `managerIds` array (single-field array-contains needs no composite index) and
    // filter to pending in-memory. The first manager to act flips the status, which drops the card
    // for everyone. Legacy docs predating `managerIds` carried only a single `managerId`; those
    // transient pending requests won't appear until re-submitted (acceptable — they resolve daily).
    useEffect(() => {
        if (!currentUser || !isManager) { setCalendarRequests([]); return undefined; }

        const q = query(
            collection(db, 'calendar_requests'),
            where('managerIds', 'array-contains', currentUser.uid)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const requests = snapshot.docs
                .map(doc => ({ id: doc.id, source: 'calendar_approval', ...doc.data() }))
                .filter(r => r.status === 'pending');
            setCalendarRequests(requests);
        }, (error) => {
            console.error("ManagerNotifications: Calendar Requests Listener Error:", error);
        });

        return () => unsubscribe();
    }, [currentUser, isManager]);

    // 4. History — read (already-dismissed) request_notifications for this recipient. Subscribed
    // LAZILY (only while the Istorija tab is open) so it adds no always-on listener cost; the read
    // rule already lets a recipient read ALL their own notifications, and this two-equality query
    // (recipientId + isRead) mirrors the active feed's shape, so it needs no rule or index change.
    // Newest-first ordering + the HISTORY_CAP slice happen in render (avoids an orderBy composite
    // index). This is the answer to "read notices vanish forever" — they now live on here.
    useEffect(() => {
        if (!currentUser || view !== 'history') { setHistoryNotifications([]); return undefined; }

        const q = query(
            collection(db, 'request_notifications'),
            where('recipientId', '==', currentUser.uid),
            where('isRead', '==', true)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            setHistoryNotifications(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        }, (error) => {
            console.error("ManagerNotifications: History Listener Error:", error);
        });

        return () => unsubscribe();
    }, [currentUser, view]);

    const handleDismissCalendar = async (notificationId) => {
        try {
            const notifRef = doc(db, 'calendar_notifications', notificationId);
            await updateDoc(notifRef, {
                dismissedBy: arrayUnion(currentUser.uid)
            });
        } catch (err) {
            console.error("Error dismissing notification:", err);
        }
    };

    const handleDismissTask = async (notificationId) => {
        try {
            await updateDoc(doc(db, 'request_notifications', notificationId), {
                isRead: true
            });
        } catch (err) {
            console.error("Error dismissing task notification:", err);
        }
    };

    // Reset BOTH feedback banners before any action. Kept as one helper so the neutral notice
    // (e.g. "task already deleted") can never linger across an unrelated action — every handler
    // that used to clear only the error now clears both through this single call.
    const clearActionFeedback = () => {
        setActionError(null);
        setActionNotice(null);
    };

    const handleApproveCalendarRequest = async (request) => {
        try {
            clearActionFeedback();
            const { type, requestedEvent, userId, userName } = request;
            const now = new Date().toISOString();
            
            if (type === 'add') {
                // requestedEvent carries a synthetic id:null for adds (a real id only exists for
                // edit/delete); strip it so it never lands on the work_hours doc and can't clobber
                // doc.id for a future reader doing {id: doc.id, ...data}.
                const addData = { ...requestedEvent, userId, type: 'planned' };
                delete addData.id;
                await addDoc(collection(db, 'work_hours'), addData);
            } else if (type === 'edit') {
                await updateDoc(doc(db, 'work_hours', requestedEvent.id), {
                    start: requestedEvent.start,
                    end: requestedEvent.end,
                    title: requestedEvent.title,
                    isWorkFromHome: requestedEvent.isWorkFromHome,
                    isVacation: requestedEvent.isVacation,
                    absenceType: requestedEvent.absenceType ?? null
                });
            } else if (type === 'delete') {
                await deleteDoc(doc(db, 'work_hours', requestedEvent.id));
            }

            await updateDoc(doc(db, 'calendar_requests', request.id), {
                status: 'approved',
                approvedAt: now,
                approvedBy: currentUser.uid
            });

            await logCalendarChange(
                { uid: userId, displayName: userName, email: '' },
                type === 'edit' ? 'edit' : type,
                new Date(requestedEvent.start),
                new Date(requestedEvent.end)
            );

            // Tell the worker their calendar request was approved (replaces the standalone banner).
            await notify({ recipientId: userId, type: 'calendar_decision', decision: 'approved', reason: request.reason || null, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
        } catch (err) {
            console.error("Error approving calendar request:", err);
            setActionError("Nepavyko patvirtinti užklausos. Bandykite dar kartą.");
        }
    };

    const handleDeclineCalendarRequest = async (request) => {
        try {
            clearActionFeedback();
            await updateDoc(doc(db, 'calendar_requests', request.id), {
                status: 'declined',
                declinedAt: new Date().toISOString(),
                declinedBy: currentUser.uid
            });
            // Tell the worker their calendar request was declined.
            await notify({ recipientId: request.userId, type: 'calendar_decision', decision: 'declined', reason: request.reason || null, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
        } catch (err) {
            console.error("Error declining calendar request:", err);
            setActionError("Nepavyko atmesti užklausos. Bandykite dar kartą.");
        }
    };

    // Only add/edit calendar requests are low-risk enough to batch-approve. A `delete` removes a
    // work_hours entry outright (destructive, irreversible from the bell), so it stays a deliberate
    // per-card decision — never swept into a one-tap bulk action.
    const bulkApprovableCalRequests = calendarRequests.filter(r => r.type === 'add' || r.type === 'edit');
    const calBatchEligible = bulkApprovableCalRequests.length >= 2 &&
        bulkApprovableCalRequests.length === calendarRequests.length;

    // Batch-approve every pending (add/edit) calendar request in one action — the calendar-side
    // mirror of handleConfirmAllCompletions. Loops the existing per-item handler, so each approval
    // still writes work_hours, flips the request, logs the change, and notifies the worker exactly
    // as a single tap would. Deletes are excluded by construction (calBatchEligible gates the bar).
    const handleApproveAllCalendarRequests = async () => {
        if (!calBatchEligible) return;
        setBulkApprovingCal(true);
        clearActionFeedback();
        try {
            for (const request of bulkApprovableCalRequests) {
                await handleApproveCalendarRequest(request);
            }
        } catch (err) {
            console.error('Error approving all calendar requests:', err);
            setActionError('Nepavyko patvirtinti visų užklausų. Bandykite dar kartą.');
        } finally {
            setBulkApprovingCal(false);
        }
    };


    // Notify the worker who submitted a task that it was approved (they may start). The submitter
    // is the notification's author (createdBy); a manager self-submitting gets no echo. `edited`
    // collapses the approve+edit path into a single "patvirtinta ir pakeista" notice (see registry).
    const notifyTaskApproved = async (notif, { edited = false } = {}) => {
        await notify({
            recipientId: notif.createdBy,
            type: 'task_approved',
            taskId: notif.taskId,
            taskTitle: notif.taskTitle,
            ...(edited ? { edited: true } : {}),
            actorUid: currentUser.uid,
            actorName: currentUser.displayName || currentUser.email,
        });
    };

    // Approving clears the worker's gate — a cleanly reversible decision — so it is now immediate +
    // undoable instead of firing irrevocably on one tap. The catch: it pings the worker ("you may
    // start"). That ping is DEFERRED for the undo window and cancelled on undo, so an undo leaves
    // nothing for the worker to see; the approval state itself commits now (other managers see it
    // live). Undo restores the exact prior status + re-surfaces the manager's approval request.
    const handleApproveTask = async (notif) => {
        const taskId = notif?.taskId;
        if (!taskId) return undefined;
        clearActionFeedback();
        // An approval request can outlive its task: the worker who submitted it may hard-delete the
        // task before the manager acts, leaving this notification dangling. Acting on the orphan used
        // to updateDoc a missing doc and surface "Nepavyko patvirtinti — bandykite dar kartą", which
        // reads as a permission denial. Detect the gone task, clear the stale request, and say so.
        // The read sits OUTSIDE runUndoable, so it owns its own error surface: a transient read
        // failure must still show the friendly error (runUndoable only guards the write below).
        let prior; // snapshotted here, restored in undo
        try {
            const snap = await getDoc(doc(db, 'tasks', taskId));
            if (!snap.exists()) {
                await handleDismissTask(notif.id);
                setActionNotice('Ši užduotis jau ištrinta — pasenęs prašymas pašalintas.');
                return undefined;
            }
            const d = snap.data();
            prior = { status: d.status ?? null, isApproved: !!d.isApproved };
        } catch (err) {
            console.error('Error reading task before approve:', err);
            setActionError('Nepavyko patvirtinti užduoties. Bandykite dar kartą.');
            return undefined;
        }
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email });
        return runUndoable({
            run: async () => {
                // Audited approveTask command — ADR 0015, increment 5 (prior state feeds its audit before/after).
                await approveTask(
                    { task: { id: taskId, title: notif.taskTitle, status: prior.status, isApproved: prior.isApproved } },
                    { actor, mode: MODES.COMMIT, reason: 'approved from notification' },
                );
                await handleDismissTask(notif.id);
            },
            deferredEffect: () => notifyTaskApproved(notif),
            undo: async () => {
                await unapproveTask(
                    { task: { id: taskId, title: notif.taskTitle }, priorStatus: prior.status, priorIsApproved: prior.isApproved },
                    { actor, mode: MODES.COMMIT, reason: 'approval undone from notification' },
                );
                await updateDoc(doc(db, 'request_notifications', notif.id), { isRead: false });
            },
            message: 'Užduotis patvirtinta.',
            undoneMessage: 'Atšaukta — patvirtinimas atšauktas.',
            errorMessage: 'Nepavyko patvirtinti užduoties. Bandykite dar kartą.',
        });
    };

    const handleEditAndApprove = async (notif) => {
        const taskId = notif?.taskId;
        if (!taskId) return;
        try {
            clearActionFeedback();
            // 0. The task may have been hard-deleted out from under this request (see handleApproveTask).
            // Read it once: if it's gone, clear the orphan and stop; otherwise reuse this snapshot to
            // open the editor below (no second fetch).
            const taskRef = doc(db, 'tasks', taskId);
            const taskSnap = await getDoc(taskRef);
            if (!taskSnap.exists()) {
                await handleDismissTask(notif.id);
                setActionNotice('Ši užduotis jau ištrinta — pasenęs prašymas pašalintas.');
                return;
            }

            // 1. Approve the task (audited approveTask command — ADR 0015, increment 5)
            await approveTask(
                { task: { id: taskId, title: notif.taskTitle } },
                { actor: humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email }), mode: MODES.COMMIT, reason: 'approved (edit) from notification' },
            );

            // 2. Dismiss notification + tell the worker in ONE notice: "patvirtinta ir pakeista".
            // Sending the combined notice now (rather than a plain "approved" here and a separate
            // "edited" when the editor saves) is what keeps approve-and-edit to a single ping; the
            // __suppressEditNotice flag below stops TaskModal's save from adding a second one.
            await handleDismissTask(notif.id);
            await notifyTaskApproved(notif, { edited: true });

            // 3. Open the task for editing in whichever view hosts the modal, and close the bell. The
            // transient __suppressEditNotice marker rides the in-memory task only (TaskModal builds
            // its Firestore write from the form, never by spreading this object), so it never persists.
            onClose?.();
            window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: { id: taskSnap.id, ...taskSnap.data(), __suppressEditNotice: true } } }));
        } catch (err) {
            console.error("Error in edit and approve:", err);
            setActionError("Nepavyko patvirtinti užduoties. Bandykite dar kartą.");
        }
    };

    const handleDeleteTaskAction = (notificationId, taskId, taskTitle) => {
        setDeleteModalData({ taskId, notificationId, taskTitle });
    };

    const confirmDelete = async ({ keepWorkHours }) => {
        if (!deleteModalData) return;
        const { taskId, notificationId } = deleteModalData;
        try {
            clearActionFeedback();
            // Fetch the full task data first so we can archive it properly
            const taskRef = doc(db, 'tasks', taskId);
            const taskSnap = await getDoc(taskRef);

            if (taskSnap.exists()) {
                const taskData = { id: taskSnap.id, ...taskSnap.data() };
                await deleteTask(taskData, currentUser.uid, { keepWorkHours });
            }

            await handleDismissTask(notificationId);
            setDeleteModalData(null);
        } catch (err) {
            console.error("Error deleting task:", err);
            setActionError("Nepavyko ištrinti užduoties. Bandykite dar kartą.");
        }
    };

    // --- Time Extension Handlers ---
    // "Do not extend" — dismiss the request AND tell the worker the answer was no.
    const handleDismissExtension = async (notif) => {
        await handleDismissTask(notif.id);
        await notify({ recipientId: notif.userId, type: 'extension_denied', taskId: notif.taskId, taskTitle: notif.taskTitle, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
    };

    // One-tap grant: extend the task's estimate by a fixed amount, tell the worker (the same
    // extension_granted notice the "Redaguoti užduotį" path produces), then dismiss the request.
    // Collapses the ~6-step edit-modal round-trip into a single tap for the common case (a small,
    // standard bump); "Redaguoti užduotį" stays as the escape hatch for a precise custom amount.
    const handleGrantExtension = async (notif, additionalTimeString) => {
        const taskId = notif?.taskId;
        if (!taskId || grantingExt) return;
        setGrantingExt(notif.id);
        clearActionFeedback();
        try {
            await extendTaskTime(taskId, additionalTimeString, currentUser.uid);
            await notify({
                recipientId: notif.userId,
                type: 'extension_granted',
                taskId,
                taskTitle: notif.taskTitle,
                actorUid: currentUser.uid,
                actorName: currentUser.displayName || currentUser.email,
            });
            await handleDismissTask(notif.id);
        } catch (err) {
            console.error('Error granting time extension:', err);
            setActionError('Nepavyko pratęsti laiko. Bandykite dar kartą.');
        } finally {
            setGrantingExt(null);
        }
    };

    // --- Task Completion Handlers ---
    // State write only — confirm a finished task (completed -> confirmed). The worker "confirmed"
    // ping is NOT sent here: it is deferred for the undo window (see below) so an undo never leaves a
    // contradicted notification on the worker's phone. No toast either, so the single and the bulk
    // handler share it (the bulk action shows ONE undo snackbar instead of N).
    const confirmCompletionWrite = async (notif) => {
        const taskId = notif?.taskId;
        if (!taskId) return;
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email });
        await confirmTask({ task: { id: taskId, title: notif.taskTitle } }, { actor, mode: MODES.COMMIT, reason: 'confirmed from notification (bulk)' });
        await handleDismissTask(notif.id);
    };

    // Deferred outbound ping — tell the worker their finished task was confirmed. Held for the undo
    // window; skipped entirely if the manager undoes.
    const notifyCompletionConfirmed = (notif) =>
        notify({ recipientId: notif.userId, type: 'task_confirmed', taskId: notif.taskId, taskTitle: notif.taskTitle, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });

    // Inverse — return a confirmed task to "awaiting confirmation" AND bring the manager's completion
    // request back into the feed (the listener filters isRead==false). With the worker ping deferred,
    // this is a fully clean undo: nothing the worker can see ever happened.
    const undoConfirmCompletion = async (notif) => {
        if (!notif?.taskId) return;
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email });
        await unconfirmTask({ task: { id: notif.taskId, title: notif.taskTitle } }, { actor, mode: MODES.COMMIT, reason: 'confirm undone from notification (bulk)' });
        await updateDoc(doc(db, 'request_notifications', notif.id), { isRead: false });
    };

    // (Single per-task confirm now lives on the NotificationTaskCard's own button — TaskCard's
    // performConfirm, which defers its onConfirmed worker-ping for the undo window. The bulk handler
    // below stays here because it acts across ALL completion cards at once.)

    // Batch-confirm every pending task completion in one action — the single highest-risk one-tap in
    // the bell (it signs off ALL finished work at once), so it gets ONE undo snackbar that reverses
    // the whole batch, and the whole batch of worker pings is deferred together (cancelled on undo).
    const handleConfirmAllCompletions = () => {
        const completions = taskNotifications.filter(n => n.type === 'task_completion');
        if (completions.length === 0) return undefined;
        clearActionFeedback();
        setBulkConfirming(true);
        return runUndoable({
            run: async () => { for (const n of completions) await confirmCompletionWrite(n); },
            deferredEffect: async () => { for (const n of completions) await notifyCompletionConfirmed(n); },
            undo: async () => { for (const n of completions) await undoConfirmCompletion(n); },
            message: completions.length === 1 ? 'Užduotis priimta.' : `Priimta užduočių: ${completions.length}.`,
            undoneMessage: 'Atšaukta — grąžinta priėmimui.',
            errorMessage: 'Nepavyko priimti visų užduočių. Bandykite dar kartą.',
        }).finally(() => setBulkConfirming(false));
    };

    // Post-action hooks handed to the completion card's TaskCard. TaskCard performs the actual
    // task write (confirm via status:'confirmed', revert via reopenTask, delete via deleteTask);
    // these run AFTER that write succeeds and only do the feed-side bookkeeping the task list has
    // no need for — dismiss this notification and tell the worker the outcome.
    const handleCardConfirmed = async (notif) => {
        await handleDismissTask(notif.id);
        await notify({ recipientId: notif.userId, type: 'task_confirmed', taskId: notif.taskId, taskTitle: notif.taskTitle, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
    };

    const handleCardReverted = async (notif) => {
        await handleDismissTask(notif.id);
        // Tell the worker their task came back for rework in ONE notice: "grąžinta taisyti ir
        // pakeista". The completion card's Grąžinti ALWAYS reopens the editor (see TaskCard
        // performRevert), and the reopened task carries __suppressEditNotice so the manager's save
        // adds no second ping — this is the single combined notice the worker sees.
        await notify({ recipientId: notif.userId, type: 'task_reverted', edited: true, taskId: notif.taskId, taskTitle: notif.taskTitle, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
    };

    // --- Account approval (system → admin) ---
    // Flip a pending sign-up's status, mirroring UserManagement's block/approve write EXACTLY:
    //   approve → { isDisabled:false, status:'active' }; block → { isDisabled:true, status:'blocked' }
    // (status:'blocked' clears the 'pending' flag so the account no longer reads as awaiting
    // approval). The first admin to act flips the shared user doc; we then dismiss only THIS admin's
    // own notification (each admin received their own), matching the per-recipient model.
    const [decidingAccount, setDecidingAccount] = useState(null); // notif.id of an in-flight decision
    const handleAccountDecision = async (notif, approve) => {
        const targetUid = notif?.targetUserId;
        if (!targetUid || decidingAccount) return;
        setDecidingAccount(notif.id);
        clearActionFeedback();
        try {
            await updateDoc(doc(db, 'users', targetUid), approve
                ? { isDisabled: false, status: 'active' }
                : { isDisabled: true, status: 'blocked' });
            await handleDismissTask(notif.id);
        } catch (err) {
            console.error('Error deciding account approval:', err);
            setActionError(err.code === 'permission-denied'
                ? 'Neturite teisių atlikti šį veiksmą.'
                : 'Nepavyko atnaujinti vartotojo statuso. Bandykite dar kartą.');
        } finally {
            setDecidingAccount(null);
        }
    };

    const allNotifications = [...calendarNotifications, ...calendarRequests, ...taskNotifications];

    // Action-required items must float above informational ones regardless of arrival order:
    // a blocked worker's time-extension request or a pending calendar approval should never sit
    // below a "someone commented" notice just because the notice is newer. Lower rank = higher.
    const urgencyRank = (notif) => {
        if (notif.source === 'calendar_approval') return 0;          // blocks the worker's planning
        if (notif.source === 'task') {
            // A blocked worker (time-extension) or a returned task is the most urgent action.
            if (notif.type === 'time_extension_request' || notif.type === 'task_reverted') return 0;
            return categoryOf(notif.type) === 'action' ? 1 : 2;      // other approvals → 1; info notices → 2
        }
        return 2;                                                    // calendar-change notice — informational
    };

    // "Mark all read" clears only INFORMATIONAL items (comments + worker-facing notices, and a
    // manager's calendar-change notices). Action items that still need a decision are left alone —
    // clearing them would silently skip the work they represent.
    const infoTaskNotifs = taskNotifications.filter(n => categoryOf(n.type) === 'info');
    const hasInfoToClear = infoTaskNotifs.length + calendarNotifications.length > 0;
    const handleMarkAllRead = async () => {
        setMarkingAll(true);
        try {
            await Promise.all([
                ...infoTaskNotifs.map(n => handleDismissTask(n.id)),
                ...calendarNotifications.map(n => handleDismissCalendar(n.id)),
            ]);
        } catch (err) {
            console.error('Error marking all read:', err);
        } finally {
            setMarkingAll(false);
        }
    };

    // Sort by urgency tier first, then newest within a tier.
    const sortedNotifications = allNotifications.sort((a, b) => {
        const getTimestamp = (notif) => {
            if (notif.createdAt) return new Date(notif.createdAt).getTime();
            if (notif.timestamp) return new Date(notif.timestamp).getTime();
            if (notif.changes && notif.changes.length > 0) return new Date(notif.changes[notif.changes.length - 1].timestamp).getTime();
            return 0;
        };
        return (urgencyRank(a) - urgencyRank(b)) || (getTimestamp(b) - getTimestamp(a));
    });

    const activeCount = sortedNotifications.length;
    // History is sorted newest-first and capped in render (no orderBy → no composite index).
    const sortedHistory = [...historyNotifications]
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, HISTORY_CAP);

    return (
        <div className="space-y-3">
            {/* Two views. ACTIVE = the live feed (action items float to the top). ISTORIJA = read /
                already-acted-on notices, so a notification that was dismissed (manually or by acting
                on it) can still be reviewed instead of disappearing forever. The tabs always render,
                so history is reachable even when the active feed is empty. */}
            <div role="tablist" aria-label="Pranešimų rodinys">
                <div className="flex w-full overflow-hidden rounded-control border border-line bg-surface-sunken">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'active'}
                        onClick={() => setView('active')}
                        className={cn(
                            'flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2.5 min-h-touch text-body font-semibold leading-tight transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                            view === 'active' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                        )}
                    >
                        Aktyvūs
                        {activeCount > 0 && (
                            <span className={cn(
                                'inline-flex min-w-[1.25rem] items-center justify-center rounded-full px-1.5 py-0.5 text-caption font-bold leading-none',
                                view === 'active' ? 'bg-white/25 text-white' : 'bg-brand text-white'
                            )}>
                                {activeCount}
                            </span>
                        )}
                    </button>
                    <div className="w-px shrink-0 bg-line" aria-hidden="true" />
                    <button
                        type="button"
                        role="tab"
                        aria-selected={view === 'history'}
                        onClick={() => setView('history')}
                        className={cn(
                            'flex-1 inline-flex items-center justify-center px-3 py-2.5 min-h-touch text-body font-semibold leading-tight transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                            view === 'history' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                        )}
                    >
                        Istorija
                    </button>
                </div>
            </div>

            {view === 'history' ? (
                sortedHistory.length === 0 ? (
                    <EmptyState
                        icon={Bell}
                        title="Istorijoje tuščia"
                        description="Perskaityti ir užbaigti pranešimai bus matomi čia."
                    />
                ) : (
                    <div className="space-y-2">
                        {sortedHistory.map((n) => {
                            const { title, body } = notificationCopy(n);
                            const Icon = historyIcon(n.type);
                            const when = n.createdAt
                                ? formatDistanceToNow(parseISO(n.createdAt), { addSuffix: true, locale: lt })
                                : '';
                            return (
                                <div key={n.id} className="flex items-start gap-3 rounded-card border border-line bg-surface-card p-3">
                                    <Icon className="mt-0.5 h-4 w-4 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                                    <div className="min-w-0 flex-1">
                                        <p className="text-body font-medium text-ink">{title}</p>
                                        {body && <p className="mt-0.5 text-caption text-ink-muted line-clamp-2">{body}</p>}
                                    </div>
                                    {when && <span className="shrink-0 text-caption text-ink-muted whitespace-nowrap">{when}</span>}
                                </div>
                            );
                        })}
                        {historyNotifications.length > HISTORY_CAP && (
                            <p className="pt-1 text-center text-caption text-ink-muted">
                                Rodomi naujausi {HISTORY_CAP} pranešimai.
                            </p>
                        )}
                    </div>
                )
            ) : sortedNotifications.length === 0 ? (
                <EmptyState
                    icon={BellOff}
                    title="Pranešimų nėra"
                    description="Čia matysite užduočių tvirtinimus, komentarus ir kalendoriaus naujienas."
                />
            ) : (
              <>
            {hasInfoToClear && (
                <div className="flex justify-end">
                    <Button variant="ghost" size="sm" loading={markingAll} onClick={handleMarkAllRead}>
                        Žymėti viską skaityta
                    </Button>
                </div>
            )}

            {actionError && (
                <div
                    role="alert"
                    aria-live="assertive"
                    className="rounded-control border border-feedback-danger/30 bg-feedback-danger/10 px-4 py-3 text-body text-feedback-danger"
                >
                    {actionError}
                </div>
            )}

            {/* Neutral notice — e.g. an orphaned approval request was cleared because its task no
                longer exists. Distinct from the danger banner so a benign self-heal never reads as a
                failure (which is what the misleading "couldn't approve" error did before). */}
            {actionNotice && (
                <div
                    role="status"
                    aria-live="polite"
                    className="rounded-control border border-line bg-surface-sunken px-4 py-3 text-body text-ink-muted"
                >
                    {actionNotice}
                </div>
            )}

            {/* Batch-approve bar — only when there are several completed tasks to confirm. */}
            {taskNotifications.filter(n => n.type === 'task_completion').length >= 2 && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-feedback-success-border bg-feedback-success-soft px-4 py-2 max-w-xl">
                    <span className="text-sm font-medium text-feedback-success-text">
                        Užbaigtos užduotys: {taskNotifications.filter(n => n.type === 'task_completion').length}
                    </span>
                    <Button variant="success" size="md" icon={Check} loading={bulkConfirming} onClick={handleConfirmAllCompletions}>
                        Priimti visas
                    </Button>
                </div>
            )}

            {/* Batch-approve bar for calendar requests — only when EVERY pending request is a low-risk
                add/edit (a delete keeps its own per-card decision) and there are several of them. */}
            {calBatchEligible && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-feedback-info-border bg-feedback-info-soft px-4 py-2 max-w-xl">
                    <span className="text-sm font-medium text-feedback-info-text">
                        Kalendoriaus užklausos: {bulkApprovableCalRequests.length}
                    </span>
                    <Button variant="success" size="md" icon={Check} loading={bulkApprovingCal} onClick={handleApproveAllCalendarRequests}>
                        Patvirtinti visas
                    </Button>
                </div>
            )}

            {sortedNotifications.map(notif => {
                if (notif.source === 'calendar') {
                    return (
                        <div key={notif.id} className="bg-feedback-info-soft border border-feedback-info-border rounded-lg p-4 relative shadow-sm max-w-xl">
                            <IconButton
                                icon={X}
                                label="Uždaryti pranešimą"
                                variant="ghost"
                                onClick={() => handleDismissCalendar(notif.id)}
                                className="absolute top-2 right-2 text-ink-muted hover:text-feedback-info"
                            />

                            <div className="flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-feedback-info mt-0.5 flex-shrink-0" />
                                <div>
                                    <h4 className="font-medium text-feedback-info-text">
                                        <UserChip userId={notif.userId} name={notif.userName} /> atnaujino veiklos kalendorių
                                    </h4>
                                    <div className="mt-2 text-sm text-feedback-info-text space-y-1">
                                        {notif.changes && notif.changes.map((change, index) => {
                                            const start = parseISO(change.start);
                                            const end = parseISO(change.end);
                                            const dayName = format(start, 'EEEE', { locale: lt });
                                            const dayNameCap = dayName.charAt(0).toUpperCase() + dayName.slice(1);
                                            const timeRange = `${format(start, 'HH:mm')} - ${format(end, 'HH:mm')}`;

                                            const isAdd = change.type === 'add';
                                            const isEdit = change.type === 'edit';
                                            // Shape carries the change type, not just color (the old
                                            // +/~/- punctuation was a color-only signal — WCAG 1.4.1):
                                            // add = Plus, edit = pencil, cancel = X.
                                            const DeltaIcon = isAdd ? Plus : isEdit ? Edit : X;
                                            const deltaColor = isAdd ? 'text-feedback-success' : isEdit ? 'text-feedback-warning' : 'text-feedback-danger';
                                            const deltaLabel = isAdd ? 'Pridėta:' : isEdit ? 'Pakeista:' : 'Atšaukta:';

                                            return (
                                                <div key={index} className="flex gap-2">
                                                    <span className={`inline-flex items-center gap-1 font-medium min-w-[84px] ${deltaColor}`}>
                                                        <DeltaIcon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
                                                        {deltaLabel}
                                                    </span>
                                                    <span>{dayNameCap}, {timeRange}</span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                } else if (notif.source === 'calendar_approval') {
                    const reqStart = parseISO(notif.requestedEvent.start);
                    const reqEnd = parseISO(notif.requestedEvent.end);
                    const dayName = format(reqStart, 'MMMM do', { locale: lt });
                    const timeRange = `${format(reqStart, 'HH:mm')} - ${format(reqEnd, 'HH:mm')}`;
                    
                    let oldTimeRange = '';
                    if (notif.type === 'edit' && notif.originalEvent) {
                        const oldStart = parseISO(notif.originalEvent.start);
                        const oldEnd = parseISO(notif.originalEvent.end);
                        oldTimeRange = `${format(oldStart, 'HH:mm')} - ${format(oldEnd, 'HH:mm')}`;
                    }
                    
                    const actionText = notif.type === 'delete' ? 'nori atšaukti (ištrinti) veiklos laiką' :
                                       notif.type === 'add' ? 'nori pridėti veiklos laiką' :
                                       'nori pakeisti veiklos laiką';

                    return (
                        <div key={notif.id} className="bg-feedback-info-soft border border-feedback-info-border rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                            <div className="flex items-start gap-4">
                                <div className="w-10 h-10 bg-feedback-info-soft text-feedback-info rounded-full flex items-center justify-center shrink-0">
                                    <Clock className="w-5 h-5" />
                                </div>
                                <div className="flex-1">
                                    <h4 className="font-bold text-feedback-info-text leading-tight">
                                        <UserChip userId={notif.userId} name={notif.userName} /> {actionText}
                                    </h4>
                                    <p className="text-sm text-feedback-info-text mt-1 font-medium">
                                        {dayName}, {notif.type === 'edit' ? `nuo ${oldTimeRange} iki ${timeRange}` : timeRange}
                                    </p>

                                    <div className="mt-3 bg-surface-card/50 rounded-lg p-3 border border-feedback-info-border">
                                        <p className="text-xs font-bold text-feedback-info uppercase tracking-wider mb-1">Priežastis:</p>
                                        <p className="text-sm text-feedback-info-text italic">&quot;{notif.reason}&quot;</p>
                                    </div>

                                    <TaskActionRow
                                        className="mt-4"
                                        actions={[
                                            { key: 'approve', label: 'Patvirtinti', icon: Check, variant: 'success', onClick: () => handleApproveCalendarRequest(notif) },
                                            { key: 'decline', label: 'Atmesti', icon: X, variant: 'danger', onClick: () => handleDeclineCalendarRequest(notif) },
                                        ]}
                                    />
                                </div>
                            </div>
                        </div>
                    );
                } else if (notif.source === 'task') {

                    // Worker-facing INFORMATIONAL notices (manager decisions) — compact read/unread rows.
                    if (['task_assigned', 'task_approved', 'task_confirmed', 'extension_granted', 'extension_denied', 'calendar_decision', 'task_priority_escalated'].includes(notif.type)) {
                        const who = formatDisplayName(notif.createdByName) || 'Vadovas';
                        const task = notif.taskTitle ? `„${notif.taskTitle}“` : '';
                        let Icon = AlertCircle;
                        let tone = 'text-brand';
                        let text = '';
                        switch (notif.type) {
                            case 'task_assigned': Icon = ListTodo; tone = 'text-brand'; text = `${who} priskyrė Jums naują užduotį: ${task}`; break;
                            case 'task_approved': Icon = CheckCircle2; tone = 'text-feedback-success'; text = `Jūsų užduotis patvirtinta — galite pradėti: ${task}`; break;
                            case 'task_confirmed': Icon = CheckCircle2; tone = 'text-feedback-success'; text = `Jūsų atlikta užduotis priimta: ${task}`; break;
                            case 'extension_granted': Icon = TimeGrantedGlyph; tone = 'text-feedback-success'; text = `Numatomas laikas pratęstas užduočiai: ${task}`; break;
                            case 'extension_denied': Icon = TimeDeniedGlyph; tone = 'text-feedback-danger'; text = `Numatomas laikas nepratęstas užduočiai: ${task}. Aptarkite su vadovu tolesnę eigą.`; break;
                            case 'task_priority_escalated': {
                                // System notice: a deadline closed in, so the task's priority was auto-raised.
                                Icon = Clock;
                                tone = notif.priorityLabel === 'Skubus' ? 'text-feedback-danger' : 'text-brand';
                                const lvl = notif.priorityLabel ? `„${notif.priorityLabel}“` : 'aukštesnį';
                                text = `Artėja terminas — ${task ? `${task} ` : ''}prioritetas pakeltas į ${lvl}.`;
                                break;
                            }
                            case 'calendar_decision': {
                                const approved = notif.decision === 'approved';
                                Icon = approved ? CheckCircle2 : XCircle;
                                tone = approved ? 'text-feedback-success' : 'text-feedback-danger';
                                text = approved ? 'Jūsų kalendoriaus užklausa patvirtinta.' : 'Jūsų kalendoriaus užklausa atmesta.';
                                break;
                            }
                            default: break;
                        }
                        return (
                            <div key={notif.id} className="flex items-start gap-3 rounded-card border border-line bg-surface-card p-3 shadow-sm animate-in fade-in slide-in-from-top-2">
                                <Icon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${tone}`} aria-hidden="true" />
                                <p className="min-w-0 flex-1 text-body text-ink">{text}</p>
                                <IconButton icon={X} label="Pažymėti skaitytu" variant="ghost" onClick={() => handleDismissTask(notif.id)} className="-mr-1 -mt-1" />
                            </div>
                        );
                    }

                    // Worker → manager: the vykdytojas raised an attention flag on a task. Two flags
                    // share this card: "Reikia vadovo" (red, action — a decision/attention is owed)
                    // and "Laukiama" (blue, FYI — the worker is blocked). The card names WHO raised it
                    // and which task; the flag itself stays on the task until the worker (or a manager)
                    // clears it from the task's detail sheet, so this is a benign read/dismiss notice.
                    if (notif.type === 'task_needs_manager' || notif.type === 'task_waiting') {
                        const isNeedsManager = notif.type === 'task_needs_manager';
                        const FlagIcon = isNeedsManager ? Hand : Hourglass;
                        const flagLabel = isNeedsManager ? 'Reikia vadovo' : 'Laukiama';
                        const wrapClass = isNeedsManager
                            ? 'border-feedback-danger-border bg-feedback-danger-soft'
                            : 'border-feedback-info-border bg-feedback-info-soft';
                        const textClass = isNeedsManager ? 'text-feedback-danger-text' : 'text-feedback-info-text';
                        const iconClass = isNeedsManager ? 'text-feedback-danger' : 'text-feedback-info';
                        return (
                            <div key={notif.id} className={`rounded-card border p-4 shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl ${wrapClass}`}>
                                <div className="flex items-start gap-3">
                                    <FlagIcon className={`mt-0.5 h-5 w-5 flex-shrink-0 ${iconClass}`} aria-hidden="true" />
                                    <div className={`min-w-0 flex-1 text-sm ${textClass}`}>
                                        <p className="leading-relaxed">
                                            {(notif.createdBy || notif.createdByName)
                                                ? <UserChip userId={notif.createdBy} name={notif.createdByName} />
                                                : <span className="font-semibold">Vykdytojas</span>}{' '}
                                            pažymėjo „{flagLabel}“:
                                        </p>
                                        <p className="mt-1 font-medium">„{notif.taskTitle}“</p>
                                    </div>
                                </div>
                                <div className="mt-3 flex items-center justify-end">
                                    <Button variant="secondary" size="md" onClick={() => handleDismissTask(notif.id)}>
                                        Supratau
                                    </Button>
                                </div>
                            </div>
                        );
                    }

                    // System → manager ACTION: a recurring job's usual assignee is away — reassign.
                    if (notif.type === 'recurring_reassign') {
                        const task = notif.taskTitle ? `„${notif.taskTitle}“` : 'pasikartojanti veikla';
                        return (
                            <div key={notif.id} className="rounded-card border border-feedback-warning-border bg-feedback-warning-soft p-4 shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-warning" aria-hidden="true" />
                                    <div className="min-w-0 flex-1 text-sm text-feedback-warning-text">
                                        <p className="font-medium leading-relaxed">
                                            Pasikartojanti veikla {task}: įprastas vykdytojas šiandien nepasiekiamas (atostogos / nebuvimas). Priskirkite kitą vykdytoją.
                                        </p>
                                    </div>
                                </div>
                                <TaskActionRow
                                    className="mt-4"
                                    actions={[
                                        { key: 'dismiss', label: 'Pažymėti skaitytu', icon: Check, variant: 'secondary', onClick: () => handleDismissTask(notif.id) },
                                        {
                                            key: 'reassign', label: 'Priskirti kitą', icon: Edit, variant: 'primary',
                                            onClick: async () => {
                                                // Dismiss, then open the generated task so the manager can reassign it.
                                                await handleDismissTask(notif.id);
                                                try {
                                                    const taskSnap = await getDoc(doc(db, 'tasks', notif.taskId));
                                                    if (taskSnap.exists()) {
                                                        onClose?.();
                                                        window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: { id: taskSnap.id, ...taskSnap.data() } } }));
                                                    }
                                                } catch (e) {
                                                    console.error('Failed to load recurring task for reassign:', e);
                                                }
                                            },
                                        },
                                    ]}
                                />
                            </div>
                        );
                    }

                    // Worker-facing ACTION: a returned task — open it to fix.
                    if (notif.type === 'task_reverted') {
                        return (
                            <div key={notif.id} className="rounded-card border border-feedback-warning-border bg-feedback-warning-soft p-4 shadow-sm animate-in fade-in slide-in-from-top-2">
                                <div className="flex items-start gap-3">
                                    <RotateCcw className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-warning" aria-hidden="true" />
                                    <div className="min-w-0 flex-1 text-sm text-feedback-warning-text">
                                        <p>{(notif.createdBy || notif.createdByName) ? <UserChip userId={notif.createdBy} name={notif.createdByName} /> : <span className="font-semibold">Vadovas</span>} grąžino užduotį tobulinti:</p>
                                        <p className="mt-1 font-medium">„{notif.taskTitle}“</p>
                                    </div>
                                </div>
                                <TaskActionRow
                                    className="mt-3"
                                    actions={[
                                        { key: 'ack', label: 'Supratau', icon: Check, variant: 'secondary', onClick: () => handleDismissTask(notif.id) },
                                        {
                                            key: 'open', label: 'Atidaryti užduotį', icon: Edit, variant: 'primary',
                                            onClick: async () => {
                                                await handleDismissTask(notif.id);
                                                try {
                                                    const taskSnap = await getDoc(doc(db, 'tasks', notif.taskId));
                                                    if (taskSnap.exists()) {
                                                        onClose?.();
                                                        window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: { id: taskSnap.id, ...taskSnap.data() } } }));
                                                    }
                                                } catch (e) {
                                                    console.error('Failed to load reverted task:', e);
                                                }
                                            },
                                        },
                                    ]}
                                />
                            </div>
                        );
                    }

                    // Worker-facing INFO: an admin corrected or removed the worker's logged (paid)
                    // time. A clear card (not a one-line row) because it changes payable time — the
                    // worker should see WHICH day, the before→after, and WHY.
                    if (notif.type === 'session_edited' || notif.type === 'session_deleted') {
                        const isDelete = notif.type === 'session_deleted';
                        const who = formatDisplayName(notif.createdByName) || 'Administratorius';
                        const Icon = isDelete ? Trash2 : Edit;
                        const headline = isDelete
                            ? `${who} pašalino Jūsų įrašytą veiklos laiką`
                            : `${who} pakoregavo Jūsų įrašytą veiklos laiką`;
                        return (
                            <div key={notif.id} className="rounded-card border border-feedback-info-border bg-feedback-info-soft p-4 shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl relative">
                                <IconButton
                                    icon={X}
                                    label="Pažymėti skaitytu"
                                    variant="ghost"
                                    onClick={() => handleDismissTask(notif.id)}
                                    className="absolute top-2 right-2 text-ink-muted hover:text-feedback-info"
                                />
                                <div className="flex items-start gap-3 pr-6">
                                    <Icon className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-info" aria-hidden="true" />
                                    <div className="min-w-0 flex-1 text-sm text-feedback-info-text">
                                        <p className="font-medium leading-relaxed">{headline}</p>
                                        {notif.day && <p className="mt-1">Diena: <span className="font-semibold">{notif.day}</span></p>}
                                        {notif.summary && !isDelete && (
                                            <p className="mt-1">Trukmė: <span className="font-semibold font-mono">{notif.summary}</span></p>
                                        )}
                                        {notif.reason && (
                                            <p className="mt-2 text-xs italic opacity-80 border-l-2 border-feedback-info-border pl-2">
                                                Priežastis: {notif.reason}
                                            </p>
                                        )}
                                        <p className="mt-2 text-xs text-feedback-info-text/90">
                                            Jei manote, kad tai klaida, susisiekite su vadovu.
                                        </p>
                                    </div>
                                </div>
                            </div>
                        );
                    }

                    // System → admin ACTION: a new sign-up is pending approval. Inline Patvirtinti /
                    // Užblokuoti flip the user's status (mirroring User Management) without leaving
                    // the bell. Created server-side (admin SDK) because the new user is signed out
                    // before the client can write.
                    if (notif.type === 'account_approval') {
                        const inFlight = decidingAccount === notif.id;
                        return (
                            <div key={notif.id} className="rounded-card border border-feedback-info-border bg-feedback-info-soft p-4 shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <div className="flex items-start gap-3">
                                    <UserPlus className="mt-0.5 h-5 w-5 flex-shrink-0 text-feedback-info" aria-hidden="true" />
                                    <div className="min-w-0 flex-1 text-sm text-feedback-info-text">
                                        <p className="font-medium leading-relaxed">
                                            Naujas vartotojas laukia patvirtinimo:
                                        </p>
                                        <p className="mt-1 font-semibold">{notif.targetUserName || notif.targetUserEmail || 'Nežinomas vartotojas'}</p>
                                        {notif.targetUserName && notif.targetUserEmail && (
                                            <p className="mt-0.5 text-xs opacity-80">{notif.targetUserEmail}</p>
                                        )}
                                    </div>
                                </div>
                                <TaskActionRow
                                    className="mt-4"
                                    actions={[
                                        { key: 'block', label: 'Užblokuoti', icon: Ban, variant: 'danger', disabled: inFlight, onClick: () => handleAccountDecision(notif, false) },
                                        { key: 'approve', label: 'Patvirtinti', icon: Check, variant: 'success', loading: inFlight, onClick: () => handleAccountDecision(notif, true) },
                                    ]}
                                />
                            </div>
                        );
                    }

                    if (notif.type === 'new_comment') {
                        return (
                            <div key={notif.id} className="bg-feedback-info-soft border border-feedback-info-border rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <IconButton
                                    icon={X}
                                    label="Uždaryti pranešimą"
                                    variant="ghost"
                                    onClick={() => handleDismissTask(notif.id)}
                                    className="absolute top-2 right-2 text-ink-muted hover:text-feedback-info sm:hidden"
                                />
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                    <div className="flex items-start gap-3 pr-6 sm:pr-0 min-w-0">
                                        <MessageCircle className="w-5 h-5 text-feedback-info mt-0.5 flex-shrink-0" />
                                        <div className="min-w-0">
                                            <div className="text-sm text-feedback-info-text">
                                                <p><UserChip userId={notif.createdBy} name={notif.createdByName} /> pakomentavo užduotį:</p>
                                                <p className="font-medium mt-1">&quot;{notif.taskTitle}&quot;</p>
                                                {notif.commentText && <p className="mt-2 text-xs italic opacity-80 border-l-2 border-feedback-info-border pl-2"> &quot;{notif.commentText}&quot;</p>}
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-end mt-1 px-2 gap-2 sm:mt-0 sm:px-0 sm:shrink-0">
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => handleDismissTask(notif.id)}
                                            title="Uždaryti"
                                        >
                                            Supratau
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    }

                    // Worker → manager ACTION: the worker flagged one of their own logged work-time
                    // rows as wrong. Workers have no session-edit right, so this is a REQUEST, not a
                    // mutation: the manager resolves it manually in „Kom. ataskaitos“ with the existing
                    // session editor. The card surfaces the worker's reason (already encoded with the
                    // day / time span / duration in commentText) and offers a benign dismiss plus a
                    // navigate-to-reports shortcut — never a task delete (this notif carries no taskId).
                    if (notif.type === 'session_correction_request') {
                        return (
                            <div key={notif.id} className="bg-feedback-warning-soft border border-feedback-warning-border rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <div className="flex flex-col gap-3">
                                    <div className="flex items-start gap-3">
                                        <AlertCircle className="w-5 h-5 text-feedback-warning mt-0.5 flex-shrink-0" />
                                        <div className="min-w-0 text-sm text-feedback-warning-text">
                                            <p><UserChip userId={notif.userId} name={notif.userName} /> pranešė apie klaidą veiklos laike:</p>
                                            {notif.commentText && <p className="mt-2 text-xs italic border-l-2 border-feedback-warning-border pl-2">&quot;{notif.commentText}&quot;</p>}
                                            <p className="mt-2 text-xs">Pataisykite įrašą skiltyje „Kom. ataskaitos“ — pasirinkite šio vykdytojo dieną.</p>
                                        </div>
                                    </div>
                                    <TaskActionRow
                                        className="mt-1"
                                        actions={[
                                            { key: 'ack', label: 'Supratau', icon: Check, variant: 'secondary', onClick: () => handleDismissTask(notif.id) },
                                            { key: 'open', label: 'Atidaryti ataskaitas', icon: Edit, variant: 'primary', onClick: () => { setActiveTab('reports'); onClose?.(); } },
                                        ]}
                                    />
                                </div>
                            </div>
                        );
                    }

                    // --- Task Completion Notification ---
                    // Rendered as the SAME TaskCard the team task list uses, fed by the live task
                    // doc, so a reported task looks and behaves identically in both places. The
                    // post-action hooks dismiss this card and notify the worker (the two-way feed
                    // bookkeeping the list itself doesn't do); confirm/revert/edit/delete are
                    // TaskCard's own manager sign-off buttons.
                    if (notif.type === 'task_completion') {
                        return (
                            <NotificationTaskCard
                                key={notif.id}
                                taskId={notif.taskId}
                                onEdit={(t) => {
                                    onClose?.();
                                    window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: t } }));
                                }}
                                onConfirmed={() => handleCardConfirmed(notif)}
                                onReverted={() => handleCardReverted(notif)}
                                onDeleted={() => handleDismissTask(notif.id)}
                            />
                        );
                    }
                    
                    // --- Time Extension Request Notification ---
                    if (notif.type === 'time_extension_request') {
                        return (
                            <div
                                key={notif.id}
                                className="rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl border bg-feedback-danger-soft border-feedback-danger-border"
                            >
                                <div className="flex flex-col gap-3">
                                    {/* Header */}
                                    <div className="flex items-start gap-3">
                                        <TimeUpGlyph className="w-5 h-5 mt-0.5 flex-shrink-0 text-feedback-danger" />
                                        <div>
                                            <div className="text-sm text-feedback-danger-text">
                                                <p className="font-medium leading-relaxed">
                                                    <UserChip userId={notif.userId} name={notif.userName} />{' '}
                                                    išnaudojo visą numatomą laiką užduočiai &quot;{notif.taskTitle}&quot; atlikti. Aptarkite tolesnę eigą ir jei reikia, pratęskite numatomą laiką.
                                                </p>
                                            </div>
                                        </div>
                                    </div>

                                    {/* Worker's note attached to the request (optional). */}
                                    {notif.commentText && (
                                        <blockquote className="rounded-control border-l-2 border-feedback-danger-border bg-surface-card px-3 py-2 text-sm italic text-ink">
                                            „{notif.commentText}“
                                        </blockquote>
                                    )}

                                    {/* Photos attached to the request (optional) — open full-size in a new tab. */}
                                    {Array.isArray(notif.attachmentUrls) && notif.attachmentUrls.length > 0 && (
                                        <div className="flex flex-wrap gap-2">
                                            {notif.attachmentUrls.map((url, idx) => (
                                                <a
                                                    key={url}
                                                    href={url}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="block h-16 w-16 overflow-hidden rounded-control border border-line focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                >
                                                    <img src={url} alt={`Priedas ${idx + 1}`} className="h-full w-full object-cover" loading="lazy" />
                                                </a>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Quick-grant chips — one tap extends the estimate and tells the worker,
                                    instead of the multi-step edit-modal round-trip. The success-toned icon
                                    pairs the meaning with shape, so color is never the sole signal. One
                                    adaptive row (collapses to icon-only together when too tight). */}
                                <TaskActionRow
                                    className="mt-3"
                                    actions={[
                                        { key: 'grant30', label: 'Pratęsti +30 min', icon: TimeGrantedGlyph, variant: 'success', loading: grantingExt === notif.id, disabled: !!grantingExt, onClick: () => handleGrantExtension(notif, '30min') },
                                        { key: 'grant1h', label: 'Pratęsti +1 val.', icon: TimeGrantedGlyph, variant: 'success', loading: grantingExt === notif.id, disabled: !!grantingExt, onClick: () => handleGrantExtension(notif, '1h') },
                                    ]}
                                />

                                {/* Decision row — do-not-extend, or open the task for a precise custom amount. */}
                                <TaskActionRow
                                    className="mt-3 mb-1"
                                    actions={[
                                        { key: 'deny', label: 'Nepratęsti', icon: X, variant: 'secondary', disabled: !!grantingExt, onClick: () => handleDismissExtension(notif) },
                                        {
                                            key: 'edit', label: 'Redaguoti užduotį', icon: Edit, variant: 'primary', disabled: !!grantingExt,
                                            onClick: async () => {
                                                // Dismiss the request, then open the task so the manager can extend the
                                                // estimate (saving a longer time fires the worker's extension_granted notice).
                                                await handleDismissTask(notif.id);
                                                try {
                                                    const taskSnap = await getDoc(doc(db, 'tasks', notif.taskId));
                                                    if (taskSnap.exists()) {
                                                        onClose?.();
                                                        window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: { id: taskSnap.id, ...taskSnap.data() } } }));
                                                    }
                                                } catch (e) {
                                                    console.error("Failed to load task for extending time:", e);
                                                }
                                            },
                                        },
                                    ]}
                                />
                            </div>
                        );
                    }

                // A genuine task approval (the worker submitted a task for the assigned manager to
                // approve). This is the ONLY type whose destructive "Ištrinti" is correct — it owns a
                // real taskId, and every action here (approve / edit-approve / delete) operates on it.
                // Gating to task_approval is what defuses the old bug: an UNKNOWN type used to fall
                // into this card and render a delete button wired to a missing taskId.
                if (notif.type === 'task_approval') {
                    return (
                        <div key={notif.id} className="bg-feedback-warning-soft border border-feedback-warning-border rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">

                            <div className="flex flex-col gap-3">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="w-5 h-5 text-feedback-warning mt-0.5 flex-shrink-0" />
                                    <div>
                                        <div className="text-sm text-feedback-warning-text">
                                            <p><UserChip userId={notif.createdBy} name={notif.createdByName} /> priskyrė Jus vadovu užduočiai:</p>
                                            <p className="font-medium mt-1">&quot;{notif.taskTitle}&quot;</p>
                                            {notif.estimatedTime && <p className="mt-1 text-xs">Planuojamas laikas: <span className="font-medium">{notif.estimatedTime}</span></p>}
                                            {notif.description && <p className="mt-1 text-xs italic border-l-2 border-feedback-warning-border pl-2"> {notif.description}</p>}
                                        </div>
                                    </div>
                                </div>

                                <TaskActionRow
                                    className="mt-3 mb-1"
                                    actions={[
                                        { key: 'approve', label: 'Patvirtinti', icon: Check, variant: 'success', onClick: () => handleApproveTask(notif) },
                                        { key: 'edit', label: 'Redaguoti', icon: Edit, variant: 'primary', onClick: () => handleEditAndApprove(notif) },
                                        { key: 'delete', label: 'Ištrinti', icon: Trash2, variant: 'danger', onClick: () => handleDeleteTaskAction(notif.id, notif.taskId, notif.taskTitle) },
                                    ]}
                                />
                            </div>
                        </div>
                    );
                }

                // SAFE fallback for any UNKNOWN or future request_notification type. Never
                // destructive: it has no task-mutating buttons (the old fallback shipped an
                // "Ištrinti" wired to a possibly-missing taskId). It shows whatever the notification
                // carried — a title and any user-authored note — and offers only a dismiss, so a new
                // type added by another branch degrades to a readable info row instead of a hazard.
                return (
                    <div key={notif.id} className="rounded-card border border-line bg-surface-card p-4 shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl relative">
                        <IconButton
                            icon={X}
                            label="Pažymėti skaitytu"
                            variant="ghost"
                            onClick={() => handleDismissTask(notif.id)}
                            className="absolute top-2 right-2 text-ink-muted hover:text-ink"
                        />
                        <div className="flex items-start gap-3 pr-6">
                            <AlertCircle className="mt-0.5 h-5 w-5 flex-shrink-0 text-ink-muted" aria-hidden="true" />
                            <div className="min-w-0 flex-1 text-sm text-ink">
                                <p className="font-medium leading-relaxed">Naujas pranešimas</p>
                                {notif.taskTitle && <p className="mt-1 font-medium">&quot;{notif.taskTitle}&quot;</p>}
                                {notif.commentText && (
                                    <p className="mt-2 text-xs italic opacity-80 border-l-2 border-line pl-2">
                                        &quot;{notif.commentText}&quot;
                                    </p>
                                )}
                            </div>
                        </div>
                    </div>
                );
            }

            return null;
            })}
              </>
            )}
            <DeleteConfirmationModal
                isOpen={!!deleteModalData}
                onClose={() => setDeleteModalData(null)}
                onConfirm={confirmDelete}
                taskTitle={deleteModalData?.taskTitle}
            />
        </div>
    );
}
