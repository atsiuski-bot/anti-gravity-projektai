import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, arrayUnion, getDoc, addDoc, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { format, parseISO } from 'date-fns';
import { lt } from 'date-fns/locale';
import { X, AlertCircle, Check, CheckCircle2, XCircle, Trash2, Edit, MessageCircle, Clock, RotateCcw, ListTodo, BellOff, Plus, Ban, UserPlus } from 'lucide-react';
import { formatDisplayName, isManagerRole } from '../utils/formatters';
import { notify, categoryOf } from '../utils/notify';
import UserChip from './UserChip';
import TaskCard from './TaskCard';
import { deleteTask, extendTaskTime } from '../utils/taskActions';
import { approveTask, unapproveTask, confirmTask, unconfirmTask, humanActor, MODES } from '../domain';
import { useUndoableAction } from '../hooks/useUndoableAction';
import { logCalendarChange } from '../utils/calendarNotifications';
import { getLithuanianWeekId } from '../utils/timeUtils';
import { DeleteConfirmationModal } from './TaskDetailsModals';
import { SoundManager } from '../utils/soundUtils';
import IconButton from './ui/IconButton';
import Button from './ui/Button';
import EmptyState from './ui/EmptyState';
import { TimeUpGlyph, TimeGrantedGlyph, TimeDeniedGlyph } from './icons/timeGlyphs';

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
 * and feeds it to TaskCard. TaskCard already exposes the manager sign-off buttons for a finished
 * task (Priimti / Grąžinti / Redaguoti / Trinti); the optional post-action hooks below are
 * what keep the two-way feed honest — after the card's own write succeeds they dismiss this
 * notification and notify the worker.
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
            />
        </div>
    );
}

export default function ManagerNotifications({ onClose }) {
    const { currentUser, userRole } = useAuth();
    const { setActiveTab } = useNavigation();
    const isManager = isManagerRole(userRole);
    const runUndoable = useUndoableAction();
    const [calendarNotifications, setCalendarNotifications] = useState([]);
    const [calendarRequests, setCalendarRequests] = useState([]);
    const [taskNotifications, setTaskNotifications] = useState([]);
    const [deleteModalData, setDeleteModalData] = useState(null); // { taskId, notificationId, taskTitle }
    const [actionError, setActionError] = useState(null); // friendly Lithuanian error message for the inline alert region
    const [bulkConfirming, setBulkConfirming] = useState(false); // batch "approve all completions" in flight
    const [bulkApprovingCal, setBulkApprovingCal] = useState(false); // batch "approve all calendar requests" in flight
    const [markingAll, setMarkingAll] = useState(false); // "mark all read" in flight
    const [grantingExt, setGrantingExt] = useState(null); // notif.id of an in-flight one-tap time grant
    const prevTaskNotifCountRef = useRef(0); // Track count for sound effect


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

            // Play sound if a new time_extension_request appeared
            const timeExtNotifs = notifs.filter(n => n.type === 'time_extension_request');
            if (timeExtNotifs.length > prevTaskNotifCountRef.current) {
                try { SoundManager.playBeep(); } catch (e) { /* ignore */ }
            }
            prevTaskNotifCountRef.current = timeExtNotifs.length;

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

    const handleApproveCalendarRequest = async (request) => {
        try {
            setActionError(null);
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
            setActionError(null);
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
        setActionError(null);
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
    // is the notification's author (createdBy); a manager self-submitting gets no echo.
    const notifyTaskApproved = async (notif) => {
        await notify({
            recipientId: notif.createdBy,
            type: 'task_approved',
            taskId: notif.taskId,
            taskTitle: notif.taskTitle,
            actorUid: currentUser.uid,
            actorName: currentUser.displayName || currentUser.email,
        });
    };

    // Approving clears the worker's gate — a cleanly reversible decision — so it is now immediate +
    // undoable instead of firing irrevocably on one tap. The catch: it pings the worker ("you may
    // start"). That ping is DEFERRED for the undo window and cancelled on undo, so an undo leaves
    // nothing for the worker to see; the approval state itself commits now (other managers see it
    // live). Undo restores the exact prior status + re-surfaces the manager's approval request.
    const handleApproveTask = (notif) => {
        const taskId = notif?.taskId;
        if (!taskId) return undefined;
        setActionError(null);
        const actor = humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email });
        let prior = { status: null, isApproved: false }; // snapshotted in run, restored in undo
        return runUndoable({
            run: async () => {
                const snap = await getDoc(doc(db, 'tasks', taskId));
                if (snap.exists()) {
                    const d = snap.data();
                    prior = { status: d.status ?? null, isApproved: !!d.isApproved };
                }
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
            setActionError(null);
            // 1. Approve the task (audited approveTask command — ADR 0015, increment 5)
            const taskRef = doc(db, 'tasks', taskId);
            await approveTask(
                { task: { id: taskId, title: notif.taskTitle } },
                { actor: humanActor({ uid: currentUser.uid, displayName: currentUser.displayName, email: currentUser.email }), mode: MODES.COMMIT, reason: 'approved (edit) from notification' },
            );

            // 2. Dismiss notification + tell the worker
            await handleDismissTask(notif.id);
            await notifyTaskApproved(notif);

            // 3. Open the task for editing in whichever view hosts the modal, and close the bell.
            const taskSnap = await getDoc(taskRef);
            if (taskSnap.exists()) {
                onClose?.();
                window.dispatchEvent(new CustomEvent('open-task-modal', { detail: { task: { id: taskSnap.id, ...taskSnap.data() } } }));
            }
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
            setActionError(null);
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
        setActionError(null);
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
        setActionError(null);
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
        // Tell the worker their task came back for rework (action item in their bell).
        await notify({ recipientId: notif.userId, type: 'task_reverted', taskId: notif.taskId, taskTitle: notif.taskTitle, actorUid: currentUser.uid, actorName: currentUser.displayName || currentUser.email });
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
        setActionError(null);
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

    if (sortedNotifications.length === 0) {
        return (
            <EmptyState
                icon={BellOff}
                title="Pranešimų nėra"
                description="Čia matysite užduočių tvirtinimus, komentarus ir kalendoriaus naujienas."
            />
        );
    }

    return (
        <div className="space-y-3">
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

                                    <div className="mt-4 flex gap-3">
                                        <Button
                                            variant="success"
                                            size="md"
                                            icon={Check}
                                            className="flex-1"
                                            onClick={() => handleApproveCalendarRequest(notif)}
                                        >
                                            Patvirtinti
                                        </Button>
                                        <Button
                                            variant="danger"
                                            size="md"
                                            icon={X}
                                            className="flex-1"
                                            onClick={() => handleDeclineCalendarRequest(notif)}
                                        >
                                            Atmesti
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    );
                } else if (notif.source === 'task') {

                    // Worker-facing INFORMATIONAL notices (manager decisions) — compact read/unread rows.
                    if (['task_assigned', 'task_approved', 'task_confirmed', 'extension_granted', 'extension_denied', 'calendar_decision'].includes(notif.type)) {
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
                                <div className="mt-4 flex flex-wrap items-center justify-end gap-3">
                                    <Button variant="secondary" size="md" icon={X} onClick={() => handleDismissTask(notif.id)}>
                                        Pažymėti skaitytu
                                    </Button>
                                    <Button
                                        variant="primary"
                                        size="md"
                                        icon={Edit}
                                        onClick={async () => {
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
                                        }}
                                    >
                                        Priskirti kitą
                                    </Button>
                                </div>
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
                                <div className="mt-3 flex items-center justify-end gap-2">
                                    <Button variant="secondary" size="md" onClick={() => handleDismissTask(notif.id)}>Supratau</Button>
                                    <Button
                                        variant="primary"
                                        size="md"
                                        icon={Edit}
                                        onClick={async () => {
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
                                        }}
                                    >
                                        Atidaryti užduotį
                                    </Button>
                                </div>
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
                                <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
                                    <Button
                                        variant="danger"
                                        size="md"
                                        icon={Ban}
                                        disabled={inFlight}
                                        onClick={() => handleAccountDecision(notif, false)}
                                    >
                                        Užblokuoti
                                    </Button>
                                    <Button
                                        variant="success"
                                        size="md"
                                        icon={Check}
                                        loading={inFlight}
                                        onClick={() => handleAccountDecision(notif, true)}
                                    >
                                        Patvirtinti
                                    </Button>
                                </div>
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
                                    <div className="mt-1 flex flex-wrap items-center justify-end gap-2">
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            onClick={() => handleDismissTask(notif.id)}
                                            title="Pažymėti perskaitytu"
                                        >
                                            Supratau
                                        </Button>
                                        <Button
                                            variant="primary"
                                            size="md"
                                            icon={Edit}
                                            className="whitespace-nowrap"
                                            onClick={() => { setActiveTab('reports'); onClose?.(); }}
                                            title="Atidaryti komandos ataskaitas ir pataisyti įrašą"
                                        >
                                            Atidaryti ataskaitas
                                        </Button>
                                    </div>
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
                                </div>

                                {/* Quick-grant chips — one tap extends the estimate and tells the worker,
                                    instead of the multi-step edit-modal round-trip. The success-toned icon
                                    pairs the meaning with shape, so color is never the sole signal. */}
                                <div className="flex items-center gap-2 flex-wrap mt-3">
                                    <Button
                                        variant="success"
                                        size="md"
                                        icon={TimeGrantedGlyph}
                                        className="whitespace-nowrap"
                                        loading={grantingExt === notif.id}
                                        disabled={!!grantingExt}
                                        onClick={() => handleGrantExtension(notif, '30min')}
                                    >
                                        Pratęsti +30 min
                                    </Button>
                                    <Button
                                        variant="success"
                                        size="md"
                                        icon={TimeGrantedGlyph}
                                        className="whitespace-nowrap"
                                        loading={grantingExt === notif.id}
                                        disabled={!!grantingExt}
                                        onClick={() => handleGrantExtension(notif, '1h')}
                                    >
                                        Pratęsti +1 val.
                                    </Button>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex items-center justify-end mt-4 mb-1 gap-3 flex-wrap">
                                    {/* Do Not Extend */}
                                    <Button
                                        variant="secondary"
                                        size="md"
                                        icon={X}
                                        className="whitespace-nowrap"
                                        disabled={!!grantingExt}
                                        onClick={() => handleDismissExtension(notif)}
                                    >
                                        Nepratęsti
                                    </Button>

                                    {/* Edit Task To Extend — escape hatch for a precise custom amount. */}
                                    <Button
                                        variant="primary"
                                        size="md"
                                        icon={Edit}
                                        className="whitespace-nowrap"
                                        disabled={!!grantingExt}
                                        onClick={async () => {
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
                                        }}
                                    >
                                        Redaguoti užduotį
                                    </Button>
                                </div>
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

                                <div className="mt-3 mb-1 flex flex-wrap items-center gap-2">
                                    <Button
                                        variant="success"
                                        size="md"
                                        icon={Check}
                                        className="whitespace-nowrap"
                                        onClick={() => handleApproveTask(notif)}
                                        title="Patvirtinti užduotį"
                                    >
                                        Patvirtinti
                                    </Button>

                                    <Button
                                        variant="primary"
                                        size="md"
                                        icon={Edit}
                                        className="whitespace-nowrap"
                                        onClick={() => handleEditAndApprove(notif)}
                                        title="Patvirtinti ir redaguoti užduotį"
                                    >
                                        Redaguoti
                                    </Button>

                                    <Button
                                        variant="danger"
                                        size="md"
                                        icon={Trash2}
                                        className="whitespace-nowrap"
                                        onClick={() => handleDeleteTaskAction(notif.id, notif.taskId, notif.taskTitle)}
                                        title="Ištrinti užduotį"
                                    >
                                        Ištrinti
                                    </Button>
                                </div>
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
            <DeleteConfirmationModal
                isOpen={!!deleteModalData}
                onClose={() => setDeleteModalData(null)}
                onConfirm={confirmDelete}
                taskTitle={deleteModalData?.taskTitle}
            />
        </div>
    );
}
