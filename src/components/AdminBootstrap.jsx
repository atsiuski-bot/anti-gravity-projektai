import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { ShieldCheck } from 'lucide-react';

export default function AdminBootstrap() {
    const { currentUser, userRole } = useAuth();
    const [hasAdmins, setHasAdmins] = useState(true); // Default to true to avoid flashing
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const checkAdmins = async () => {
            try {
                const q = query(collection(db, 'users'), where('role', '==', 'admin'));
                const snapshot = await getDocs(q);
                setHasAdmins(!snapshot.empty);
            } catch (error) {
                console.error("Error checking admins:", error);
            } finally {
                setLoading(false);
            }
        };

        checkAdmins();
    }, []);

    const handleBecomeAdmin = async () => {
        if (!currentUser) return;
        try {
            const userRef = doc(db, 'users', currentUser.uid);
            await updateDoc(userRef, {
                role: 'admin'
            });
            window.location.reload();
        } catch (error) {
            console.error("Error becoming admin:", error);
        }
    };

    if (loading || hasAdmins || userRole === 'admin') return null;

    return (
        <div className="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-6 mx-4 sm:mx-auto max-w-7xl mt-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center">
                    <ShieldCheck className="h-6 w-6 text-yellow-600 mr-3" />
                    <div>
                        <h3 className="text-sm font-medium text-yellow-800">Nėra administratorių</h3>
                        <p className="text-sm text-yellow-700">
                            Sistemoje šiuo metu nėra administratorių. Galite tapti administratoriumi.
                        </p>
                    </div>
                </div>
                <button
                    onClick={handleBecomeAdmin}
                    className="ml-4 px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-yellow-600 hover:bg-yellow-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-yellow-500"
                >
                    Tapti administratoriumi
                </button>
            </div>
        </div>
    );
}
