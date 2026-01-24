import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc, arrayUnion } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { startOfWeek, format, parseISO } from 'date-fns';
import { lt } from 'date-fns/locale';
import { X, AlertCircle } from 'lucide-react';
import { formatDisplayName } from '../utils/formatters';

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
                        <div key={notif.id} className="bg-amber-50 border border-amber-200 rounded-lg p-4 relative shadow-sm animate-in fade-in slide-in-from-top-2">
                            <button
                                onClick={() => handleDismissTask(notif.id)}
                                className="absolute top-2 right-2 text-amber-400 hover:text-amber-600 p-1"
                                title="Pažymėti kaip perskaitytą"
                            >
                                <X className="w-5 h-5" />
                            </button>

                            <div className="flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
                                <div>
                                    <h4 className="font-medium text-amber-900">
                                        Nauja užduotis laukia patvirtinimo
                                    </h4>
                                    <div className="mt-1 text-sm text-amber-800">
                                        <p><span className="font-semibold">{formatDisplayName(notif.createdByName)}</span> priskyrė Jus vadovu užduočiai:</p>
                                        <p className="font-medium mt-1">"{notif.taskTitle}"</p>
                                        <p className="mt-2 text-xs opacity-75">
                                            Norėdami patvirtinti, raskite užduotį sąraše (ji bus pažymėta kaip "Nepatvirtinta").
                                        </p>
                                    </div>
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
