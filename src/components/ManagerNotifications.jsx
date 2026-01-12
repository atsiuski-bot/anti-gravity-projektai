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
    const [notifications, setNotifications] = useState([]);

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
                ...doc.data()
            })).filter(n => !n.dismissedBy?.includes(currentUser.uid));

            setNotifications(notifs);
        });

        return () => unsubscribe();
    }, [currentUser]);

    const handleDismiss = async (notificationId) => {
        try {
            const notifRef = doc(db, 'calendar_notifications', notificationId);
            await updateDoc(notifRef, {
                dismissedBy: arrayUnion(currentUser.uid)
            });
        } catch (err) {
            console.error("Error dismissing notification:", err);
        }
    };

    if (notifications.length === 0) return null;

    return (
        <div className="mb-6 space-y-4">
            {notifications.map(notif => (
                <div key={notif.id} className="bg-blue-50 border border-blue-200 rounded-lg p-4 relative shadow-sm">
                    <button
                        onClick={() => handleDismiss(notif.id)}
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
                                {notif.changes.map((change, index) => {
                                    const start = parseISO(change.start);
                                    const end = parseISO(change.end);
                                    const dayName = format(start, 'EEEE', { locale: lt });
                                    // Capitalize first letter of day name
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
            ))}
        </div>
    );
}
