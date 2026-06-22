import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, query, where, getDocs, doc, updateDoc } from 'firebase/firestore';
import { useAuth } from '../context/AuthContext';
import { ShieldCheck } from 'lucide-react';
import Button from './ui/Button';
import { logError } from '../utils/errorLog';

export default function AdminBootstrap() {
    const { currentUser, userRole } = useAuth();
    const [hasAdmins, setHasAdmins] = useState(true); // Default to true to avoid flashing
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

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
        setError('');
        try {
            const userRef = doc(db, 'users', currentUser.uid);
            await updateDoc(userRef, {
                role: 'admin'
            });
            window.location.reload();
        } catch (err) {
            // Self-promotion to admin is denied by the security rules (only an existing admin
            // may change a role), so this write essentially always fails. Surface a clear
            // recovery path instead of silently reloading into the same banner.
            logError(err, { source: 'adminBootstrap:becomeAdmin' });
            setError('Negalima pačiam tapti administratoriumi. Pirmąjį administratorių turi nustatyti sistemos savininkas „Firebase" konsolėje (vartotojo dokumente įrašyti role: "admin", isDisabled: false).');
        }
    };

    if (loading || hasAdmins || userRole === 'admin') return null;

    return (
        <div className="bg-feedback-warning-soft border-l-4 border-feedback-warning-border p-4 mb-6 mx-4 sm:mx-auto max-w-7xl mt-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center">
                    <ShieldCheck className="h-6 w-6 text-feedback-warning mr-3" />
                    <div>
                        <h3 className="text-sm font-medium text-feedback-warning-text">Nėra administratorių</h3>
                        <p className="text-sm text-feedback-warning-text">
                            Sistemoje šiuo metu nėra administratorių. Galite tapti administratoriumi.
                        </p>
                    </div>
                </div>
                <Button
                    onClick={handleBecomeAdmin}
                    className="ml-4 bg-feedback-warning text-white hover:bg-feedback-warning-hover shadow-sm"
                >
                    Tapti administratoriumi
                </Button>
            </div>
            {error && (
                <p role="alert" aria-live="assertive" className="mt-3 text-sm font-medium text-feedback-danger-text">
                    {error}
                </p>
            )}
        </div>
    );
}
