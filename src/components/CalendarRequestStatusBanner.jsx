import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { CheckCircle2, XCircle, X } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { lt } from 'date-fns/locale';

export default function CalendarRequestStatusBanner() {
    const { currentUser } = useAuth();
    const [notifications, setNotifications] = useState([]);

    useEffect(() => {
        if (!currentUser) return;

        // Listen for requests that are not pending and not dismissed by user
        const q = query(
            collection(db, 'calendar_requests'),
            where('userId', '==', currentUser.uid),
            where('status', 'in', ['approved', 'declined']),
            where('userDismissed', '==', false)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const notifs = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setNotifications(notifs);
        }, (error) => {
            console.error("Error fetching request statuses:", error);
        });

        return () => unsubscribe();
    }, [currentUser]);

    const handleDismiss = async (id) => {
        try {
            await updateDoc(doc(db, 'calendar_requests', id), {
                userDismissed: true
            });
        } catch (err) {
            console.error("Error dismissing notification:", err);
        }
    };

    if (notifications.length === 0) return null;

    return (
        <div className="mb-6 space-y-4">
            {notifications.map(notif => {
                const isApproved = notif.status === 'approved';
                const date = parseISO(notif.requestedEvent.start);
                const dayStr = format(date, 'MMMM do', { locale: lt });
                
                return (
                    <div 
                        key={notif.id}
                        className={`max-w-xl w-full p-4 rounded-lg shadow-sm border flex items-start gap-4 animate-in fade-in slide-in-from-top-2 relative ${
                            isApproved 
                                ? 'bg-green-50 border-green-200 text-green-900' 
                                : 'bg-red-50 border-red-200 text-red-900'
                        }`}
                    >
                        <button 
                            onClick={() => handleDismiss(notif.id)}
                            className="absolute top-2 right-2 text-gray-400 hover:text-gray-600 p-1 transition-colors"
                            title="Uždaryti pranešimą"
                        >
                            <X className="w-5 h-5" />
                        </button>
                        
                        <div className="w-10 h-10 flex items-center justify-center shrink-0 rounded-full bg-white/50">
                            {isApproved ? (
                                <CheckCircle2 className="w-6 h-6 text-green-600" />
                            ) : (
                                <XCircle className="w-6 h-6 text-red-600" />
                            )}
                        </div>
                        
                        <div className="flex-1 pr-6">
                            <h4 className="font-bold leading-tight text-base mb-1">
                                {isApproved ? 'Vadovas patvirtino kalendoriaus pakeitimą' : 'Vadovas atmetė kalendoriaus pakeitimą'}
                            </h4>
                            <p className="text-sm font-medium opacity-90">
                                {isApproved 
                                    ? `Jūsų ${dayStr} kalendoriaus užklausa buvo patvirtinta.`
                                    : `Jūsų ${dayStr} kalendoriaus užklausa buvo atmesta.`}
                            </p>
                            <div className="mt-3 bg-white/40 rounded-lg p-3 border border-black/5">
                                <p className="text-xs font-bold uppercase tracking-wider mb-1 opacity-70">Jūsų nurodyta priežastis:</p>
                                <p className="text-sm italic font-medium opacity-80">"{notif.reason}"</p>
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
