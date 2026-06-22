import { useState, useEffect, useRef } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, arrayUnion, getDoc, addDoc, deleteDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { startOfWeek, format, parseISO } from 'date-fns';
import { lt } from 'date-fns/locale';
import { X, AlertCircle, Check, Trash2, Edit, MessageCircle, Clock, RotateCcw } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { deleteTask } from '../utils/taskActions';
import { logCalendarChange } from '../utils/calendarNotifications';
import { DeleteConfirmationModal } from './TaskDetailsModals';
import { SoundManager } from '../utils/soundUtils';
import IconButton from './ui/IconButton';
import Button from './ui/Button';

export default function ManagerNotifications({ onEditAndApprove }) {
    const { currentUser } = useAuth();
    const [calendarNotifications, setCalendarNotifications] = useState([]);
    const [calendarRequests, setCalendarRequests] = useState([]);
    const [taskNotifications, setTaskNotifications] = useState([]);
    const [deleteModalData, setDeleteModalData] = useState(null); // { taskId, notificationId, taskTitle }
    const [actionError, setActionError] = useState(null); // friendly Lithuanian error message for the inline alert region
    const [bulkConfirming, setBulkConfirming] = useState(false); // batch "approve all completions" in flight
    const prevTaskNotifCountRef = useRef(0); // Track count for sound effect


    // 1. Calendar Notifications (Existing Logic)
    useEffect(() => {
        if (!currentUser) return;

        const now = new Date();
        const weekStart = startOfWeek(now, { weekStartsOn: 1 });
        const weekId = format(weekStart, 'yyyy-MM-dd');

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
    }, [currentUser]);

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

    // 3. Calendar Approval Requests (New Logic)
    useEffect(() => {
        if (!currentUser) return;

        const q = query(
            collection(db, 'calendar_requests'),
            where('managerId', '==', currentUser.uid),
            where('status', '==', 'pending')
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const requests = snapshot.docs.map(doc => ({
                id: doc.id,
                source: 'calendar_approval',
                ...doc.data()
            }));
            setCalendarRequests(requests);
        }, (error) => {
            console.error("ManagerNotifications: Calendar Requests Listener Error:", error);
        });

        return () => unsubscribe();
    }, [currentUser]);

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
                await addDoc(collection(db, 'work_hours'), {
                    ...requestedEvent,
                    userId,
                    type: 'planned'
                });
            } else if (type === 'edit') {
                await updateDoc(doc(db, 'work_hours', requestedEvent.id), {
                    start: requestedEvent.start,
                    end: requestedEvent.end,
                    title: requestedEvent.title,
                    isWorkFromHome: requestedEvent.isWorkFromHome,
                    isVacation: requestedEvent.isVacation
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
        } catch (err) {
            console.error("Error declining calendar request:", err);
            setActionError("Nepavyko atmesti užklausos. Bandykite dar kartą.");
        }
    };


    const handleApproveTask = async (notificationId, taskId) => {
        if (!taskId) return;
        try {
            setActionError(null);
            // 1. Approve the task
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                status: 'approved',
                isApproved: true, // Redundant but explicit
                approvedAt: new Date().toISOString(),
                approvedBy: currentUser.uid
            });

            // 2. Dismiss notification
            await handleDismissTask(notificationId);
        } catch (err) {
            console.error("Error approving task:", err);
            setActionError("Nepavyko patvirtinti užduoties. Bandykite dar kartą.");
        }
    };

    const handleEditAndApprove = async (notificationId, taskId) => {
        if (!taskId) return;
        try {
            setActionError(null);
            // 1. Approve the task
            const taskRef = doc(db, 'tasks', taskId);
            await updateDoc(taskRef, {
                status: 'approved',
                isApproved: true,
                approvedAt: new Date().toISOString(),
                approvedBy: currentUser.uid
            });

            // 2. Dismiss notification
            await handleDismissTask(notificationId);

            // 3. Fetch full task data and open edit modal
            if (onEditAndApprove) {
                const taskSnap = await getDoc(taskRef);
                if (taskSnap.exists()) {
                    onEditAndApprove({ id: taskSnap.id, ...taskSnap.data() });
                }
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
    const handleDismissExtension = async (notificationId) => {
        await handleDismissTask(notificationId);
    };

    // Batch-confirm every pending task completion in one action. Each completion is a simple,
    // homogeneous, low-risk approval, so looping the existing per-item handler turns N taps into
    // one. Reverts/edits/deletes stay per-card because they are the exception, not the rule.
    const handleConfirmAllCompletions = async () => {
        const completions = taskNotifications.filter(n => n.type === 'task_completion');
        if (completions.length === 0) return;
        setBulkConfirming(true);
        setActionError(null);
        try {
            for (const n of completions) {
                await handleConfirmCompletion(n.id, n.taskId);
            }
        } catch (err) {
            console.error('Error confirming all completions:', err);
            setActionError('Nepavyko patvirtinti visų užduočių. Bandykite dar kartą.');
        } finally {
            setBulkConfirming(false);
        }
    };

    // --- Task Completion Handlers ---
    const handleConfirmCompletion = async (notificationId, taskId) => {
        if (!taskId) return;
        try {
            setActionError(null);
            await updateDoc(doc(db, 'tasks', taskId), {
                status: 'confirmed',
                isApproved: true,
                confirmedBy: currentUser.uid,
                confirmedAt: new Date().toISOString(),
                updatedAt: new Date().toISOString()
            });
            await handleDismissTask(notificationId);
        } catch (err) {
            console.error('Error confirming task completion:', err);
            setActionError('Nepavyko patvirtinti užduoties. Bandykite dar kartą.');
        }
    };

    const handleRevertTask = async (notificationId, taskId, _userName) => {
        if (!taskId) return;
        try {
            setActionError(null);
            const managerName = currentUser.displayName || currentUser.email || 'Vadovas';
            const autoComment = {
                text: `Vadovas ${managerName} grąžino užduotį į darbų sąrašą tobulinimui.`,
                user: managerName,
                userId: currentUser.uid,
                isSystemComment: true,
                createdAt: new Date().toISOString()
            };
            await updateDoc(doc(db, 'tasks', taskId), {
                status: 'in-progress',
                completed: false,
                completedAt: null,
                confirmedBy: null,
                confirmedAt: null,
                timerStatus: 'paused',
                updatedAt: new Date().toISOString(),
                comments: arrayUnion(autoComment)
            });
            await handleDismissTask(notificationId);
        } catch (err) {
            console.error('Error reverting task:', err);
            setActionError('Nepavyko grąžinti užduoties. Bandykite dar kartą.');
        }
    };

    const allNotifications = [...calendarNotifications, ...calendarRequests, ...taskNotifications];

    // Action-required items must float above informational ones regardless of arrival order:
    // a blocked worker's time-extension request or a pending calendar approval should never sit
    // below a "someone commented" notice just because the notice is newer. Lower rank = higher.
    const urgencyRank = (notif) => {
        if (notif.source === 'calendar_approval') return 0;          // blocks the worker's planning
        if (notif.source === 'task') {
            if (notif.type === 'time_extension_request') return 0;   // worker is blocked on the task
            if (notif.type === 'new_comment') return 2;              // informational
            return 1;                                                // task_completion / assignment — needs action
        }
        return 2;                                                    // calendar-change notice — informational
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

    if (sortedNotifications.length === 0) return null;

    return (
        <div className="mb-6 space-y-4">
            {actionError && (
                <div
                    role="alert"
                    aria-live="assertive"
                    className="max-w-xl rounded-control border border-feedback-danger/30 bg-feedback-danger/10 px-4 py-3 text-body text-feedback-danger"
                >
                    {actionError}
                </div>
            )}

            {/* Batch-approve bar — only when there are several completed tasks to confirm. */}
            {taskNotifications.filter(n => n.type === 'task_completion').length >= 2 && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-2 max-w-xl">
                    <span className="text-sm font-medium text-green-900">
                        Užbaigtos užduotys: {taskNotifications.filter(n => n.type === 'task_completion').length}
                    </span>
                    <Button variant="success" size="md" icon={Check} loading={bulkConfirming} onClick={handleConfirmAllCompletions}>
                        Patvirtinti visas
                    </Button>
                </div>
            )}

            {sortedNotifications.map(notif => {
                if (notif.source === 'calendar') {
                    return (
                        <div key={notif.id} className="bg-blue-50 border border-blue-200 rounded-lg p-4 relative shadow-sm max-w-xl">
                            <IconButton
                                icon={X}
                                label="Uždaryti pranešimą"
                                variant="ghost"
                                onClick={() => handleDismissCalendar(notif.id)}
                                className="absolute top-2 right-2 text-blue-400 hover:text-blue-600"
                            />

                            <div className="flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                                <div>
                                    <h4 className="font-medium text-blue-900">
                                        {formatDisplayName(notif.userName)} atnaujino darbo kalendorių
                                    </h4>
                                    <div className="mt-2 text-sm text-blue-800 space-y-1">
                                        {notif.changes && notif.changes.map((change, index) => {
                                            const start = parseISO(change.start);
                                            const end = parseISO(change.end);
                                            const dayName = format(start, 'EEEE', { locale: lt });
                                            const dayNameCap = dayName.charAt(0).toUpperCase() + dayName.slice(1);
                                            const timeRange = `${format(start, 'HH:mm')} - ${format(end, 'HH:mm')}`;

                                            const isAdd = change.type === 'add';
                                            const isEdit = change.type === 'edit';

                                            return (
                                                <div key={index} className="flex gap-2">
                                                    <span className={
                                                        isAdd ? 'text-green-600 font-medium min-w-[70px]' :
                                                            isEdit ? 'text-amber-600 font-medium min-w-[70px]' :
                                                                'text-red-600 font-medium min-w-[70px]'
                                                    }>
                                                        {isAdd ? '+ Pridėta:' : isEdit ? '~ Pakeista:' : '- Atšaukta:'}
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
                    
                    const actionText = notif.type === 'delete' ? 'nori atšaukti (ištrinti) darbo laiką' :
                                       notif.type === 'add' ? 'nori pridėti darbo laiką' :
                                       'nori pakeisti darbo laiką';

                    return (
                        <div key={notif.id} className="bg-blue-50 border border-blue-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                            <div className="flex items-start gap-4">
                                <div className="w-10 h-10 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center shrink-0">
                                    <Clock className="w-5 h-5" />
                                </div>
                                <div className="flex-1">
                                    <h4 className="font-bold text-blue-900 leading-tight">
                                        {formatDisplayName(notif.userName)} {actionText}
                                    </h4>
                                    <p className="text-sm text-blue-800 mt-1 font-medium">
                                        {dayName}, {notif.type === 'edit' ? `nuo ${oldTimeRange} iki ${timeRange}` : timeRange}
                                    </p>
                                    
                                    <div className="mt-3 bg-surface-card/50 rounded-lg p-3 border border-blue-100">
                                        <p className="text-xs font-bold text-blue-600 uppercase tracking-wider mb-1">Priežastis:</p>
                                        <p className="text-sm text-blue-800 italic">&quot;{notif.reason}&quot;</p>
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

                    if (notif.type === 'new_comment') {
                        return (
                            <div key={notif.id} className="bg-blue-50 border border-blue-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <IconButton
                                    icon={X}
                                    label="Uždaryti pranešimą"
                                    variant="ghost"
                                    onClick={() => handleDismissTask(notif.id)}
                                    className="absolute top-2 right-2 text-blue-400 hover:text-blue-600 sm:hidden"
                                />
                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                                    <div className="flex items-start gap-3 pr-6 sm:pr-0 min-w-0">
                                        <MessageCircle className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
                                        <div className="min-w-0">
                                            <div className="text-sm text-blue-800">
                                                <p><span className="font-semibold">{formatDisplayName(notif.createdByName)}</span> pakomentavo užduotį:</p>
                                                <p className="font-medium mt-1">&quot;{notif.taskTitle}&quot;</p>
                                                {notif.commentText && <p className="mt-2 text-xs italic opacity-80 border-l-2 border-blue-300 pl-2"> &quot;{notif.commentText}&quot;</p>}
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

                    // --- Task Completion Notification ---
                    if (notif.type === 'task_completion') {
                        const completedDate = notif.completedAt
                            ? format(new Date(notif.completedAt), 'yyyy-MM-dd HH:mm')
                            : '';
                        return (
                            <div key={notif.id} className="bg-green-50 border border-green-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">
                                <div className="flex flex-col gap-3">
                                    <div className="flex items-start gap-3">
                                        <Check className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
                                        <div className="text-sm text-green-900">
                                            <p>
                                                <span className="font-semibold">{formatDisplayName(notif.userName)}</span>
                                                {' '}baigė užduotį{' '}
                                                <span className="font-medium">&quot;{notif.taskTitle}&quot;</span>
                                                {completedDate && <span className="text-green-700"> {completedDate}</span>}
                                                .
                                            </p>
                                            <p className="mt-1">
                                                Užduočiai sugaištas laikas:{' '}
                                                <span className="font-semibold">{notif.actualTime || '—'}</span>.
                                            </p>
                                            <p className="mt-1 text-green-700">Patvirtinkite atlikimą arba grąžinkite užduotį tobulinti.</p>
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between mt-2 mb-1 px-2 gap-2">
                                        <Button
                                            variant="success"
                                            size="md"
                                            icon={Check}
                                            className="whitespace-nowrap"
                                            onClick={() => handleConfirmCompletion(notif.id, notif.taskId)}
                                            title="Patvirtinti užduoties atlikimą"
                                        >
                                            Patvirtinti
                                        </Button>
                                        <Button
                                            variant="secondary"
                                            size="md"
                                            icon={RotateCcw}
                                            className="whitespace-nowrap"
                                            onClick={() => handleRevertTask(notif.id, notif.taskId, notif.userName)}
                                            title="Grąžinti į darbų sąrašą"
                                        >
                                            Sugrąžinti į darbų sąrašą
                                        </Button>
                                    </div>
                                </div>
                            </div>
                        );
                    }
                    
                    // --- Time Extension Request Notification ---
                    if (notif.type === 'time_extension_request') {
                        return (
                            <div
                                key={notif.id}
                                className="rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl border bg-red-50 border-red-200"
                            >
                                <div className="flex flex-col gap-3">
                                    {/* Header */}
                                    <div className="flex items-start gap-3">
                                        <Clock className="w-5 h-5 mt-0.5 flex-shrink-0 text-red-600" />
                                        <div>
                                            <div className="text-sm text-red-800">
                                                <p className="font-medium leading-relaxed">
                                                    <span className="font-semibold">
                                                        {formatDisplayName(notif.userName)}
                                                    </span>{' '}
                                                    išnaudojo visą numatomą laiką užduočiai &quot;{notif.taskTitle}&quot; atlikti. Aptarkite tolesnę eigą ir jei reikia, pratęskite numatomą laiką.
                                                </p>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Action Buttons */}
                                <div className="flex items-center justify-end mt-4 mb-1 gap-3 flex-wrap">
                                    {/* Do Not Extend */}
                                    <Button
                                        variant="secondary"
                                        size="md"
                                        icon={X}
                                        className="whitespace-nowrap"
                                        onClick={() => handleDismissExtension(notif.id)}
                                    >
                                        Nepratęsti
                                    </Button>

                                    {/* Edit Task To Extend */}
                                    <Button
                                        variant="primary"
                                        size="md"
                                        icon={Edit}
                                        className="whitespace-nowrap"
                                        onClick={async () => {
                                            // Dismiss notification
                                            await handleDismissTask(notif.id);
                                            // Open task modal without changing status
                                            if (onEditAndApprove) {
                                                try {
                                                    const taskSnap = await getDoc(doc(db, 'tasks', notif.taskId));
                                                    if (taskSnap.exists()) {
                                                        onEditAndApprove({ id: taskSnap.id, ...taskSnap.data() });
                                                    }
                                                } catch (e) {
                                                    console.error("Failed to load task for extending time:", e);
                                                }
                                            }
                                        }}
                                    >
                                        Redaguoti užduotį
                                    </Button>
                                </div>
                            </div>
                        );
                    }

                // Default fallback for task assignments / approvals
                return (
                    <div key={notif.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">

                        <div className="flex flex-col gap-3">
                            <div className="flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                                <div>
                                    <div className="text-sm text-amber-800">
                                        <p><span className="font-semibold">{formatDisplayName(notif.createdByName)}</span> priskyrė Jus vadovu užduočiai:</p>
                                        <p className="font-medium mt-1">&quot;{notif.taskTitle}&quot;</p>
                                        {notif.estimatedTime && <p className="mt-1 text-xs">Planuojamas laikas: <span className="font-medium">{notif.estimatedTime}</span></p>}
                                        {notif.description && <p className="mt-1 text-xs italic opacity-80 border-l-2 border-amber-300 pl-2"> {notif.description}</p>}
                                    </div>
                                </div>
                            </div>

                            <div className="mt-3 mb-1 flex flex-wrap items-center gap-2">
                                <Button
                                    variant="success"
                                    size="md"
                                    icon={Check}
                                    className="whitespace-nowrap"
                                    onClick={() => handleApproveTask(notif.id, notif.taskId)}
                                    title="Patvirtinti užduotį"
                                >
                                    Patvirtinti
                                </Button>

                                <Button
                                    variant="primary"
                                    size="md"
                                    icon={Edit}
                                    className="whitespace-nowrap"
                                    onClick={() => handleEditAndApprove(notif.id, notif.taskId)}
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
