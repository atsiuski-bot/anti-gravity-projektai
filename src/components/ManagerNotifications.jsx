import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, arrayUnion, getDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { startOfWeek, format, parseISO } from 'date-fns';
import { lt } from 'date-fns/locale';
import { X, AlertCircle, Check, Trash2 } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';
import { deleteTask } from '../utils/taskActions';

export default function ManagerNotifications() {
    const { currentUser } = useAuth();
    const [calendarNotifications, setCalendarNotifications] = useState([]);
    const [taskNotifications, setTaskNotifications] = useState([]);

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
            setTaskNotifications(notifs);
            setTaskNotifications(notifs);
        }, (error) => {
            console.error("ManagerNotifications: Task Notifications Listener Error:", error);
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

    const handleApproveTask = async (notificationId, taskId) => {
        if (!taskId) return;
        try {
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
            alert("Nepavyko patvirtinti užduoties: " + err.message);
        }
    };

    const handleDeleteTaskAction = async (notificationId, taskId) => {
        if (!taskId) return;
        if (!window.confirm("Ar tikrai norite ištrinti šią užduotį?")) return;

        try {
            // Fetch the full task data first so we can archive it properly
            const taskRef = doc(db, 'tasks', taskId);
            const taskSnap = await getDoc(taskRef);

            if (taskSnap.exists()) {
                const taskData = { id: taskSnap.id, ...taskSnap.data() };
                // Use the centralized deleteTask function which now archives the task
                await deleteTask(taskData, currentUser.uid);
            } else {
                console.warn("Task to delete not found, maybe already deleted?", taskId);
            }

            // Dismiss notification regardless (so it doesn't get stuck)
            await handleDismissTask(notificationId);
        } catch (err) {
            console.error("Error deleting task:", err);
            alert("Nepavyko ištrinti užduoties: " + err.message);
        }
    };

    const allNotifications = [...calendarNotifications, ...taskNotifications];

    if (allNotifications.length === 0) return null;

    return (
        <div className="mb-6 space-y-4">
            {allNotifications.map(notif => {
                if (notif.source === 'calendar') {
                    return (
                        <div key={notif.id} className="bg-blue-50 border border-blue-200 rounded-lg p-4 relative shadow-sm">
                            <button
                                onClick={() => handleDismissCalendar(notif.id)}
                                className="absolute top-2 right-2 text-blue-400 hover:text-blue-600 p-1"
                                title="Uždaryti pranešimą"
                            >
                                <X className="w-5 h-5" />
                            </button>

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
                                                        {isAdd ? '+ Pridėta:' : isEdit ? '~ Pakeista:' : '- Ištrinta:'}
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
                } else if (notif.source === 'task') {
                    return (
                        <div key={notif.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2 max-w-xl">


                            <div className="flex flex-col gap-3">
                                <div className="flex items-start gap-3">
                                    <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                                    <div>
                                        <div className="text-sm text-amber-800">
                                            <p><span className="font-semibold">{formatDisplayName(notif.createdByName)}</span> priskyrė Jus vadovu užduočiai:</p>
                                            <p className="font-medium mt-1">"{notif.taskTitle}"</p>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex items-center justify-between mt-3 mb-1 px-2 gap-2">
                                    <div className="w-8 shrink-0"></div> {/* Left spacer to offset center */}

                                    <button
                                        onClick={() => handleApproveTask(notif.id, notif.taskId)}
                                        className="flex items-center justify-center gap-2 px-6 py-2 bg-green-100 text-green-700 hover:bg-green-200 rounded-lg transition-colors text-base font-semibold shadow-sm whitespace-nowrap"
                                        title="Patvirtinti užduotį"
                                    >
                                        <Check className="w-5 h-5" />
                                        Taip, patvirtinti
                                    </button>

                                    <button
                                        onClick={() => handleDeleteTaskAction(notif.id, notif.taskId)}
                                        className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-red-100 text-red-600 hover:bg-red-200 rounded transition-colors text-xs font-medium shrink-0 whitespace-nowrap"
                                        title="Ištrinti užduotį"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                        Ne, ištrinti
                                    </button>
                                </div>
                            </div>
                        </div>
                    );
                }
                return null;
            })}
        </div>
    );
}
