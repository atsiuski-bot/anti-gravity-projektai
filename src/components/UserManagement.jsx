import React, { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc, query, where, getDocs } from 'firebase/firestore';
import { Users, Shield, ShieldAlert, UserCog } from 'lucide-react';

export default function UserManagement() {
    const [users, setUsers] = useState([]);
    const [error, setError] = useState('');

    useEffect(() => {
        let unsubscribe = () => { };

        try {
            unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
                const usersData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setUsers(usersData);
                // Clear error if successful
                if (error && error.includes('užkrauti vartotojų')) {
                    setError('');
                }
            }, (err) => {
                console.error("Error fetching users:", err);
                setError("Nepavyko užkrauti vartotojų sąrašo. Patikrinkite teises.");
            });
        } catch (err) {
            console.error("Error setting up users listener:", err);
            setError("Įvyko klaida. Bandykite perkrauti puslapį.");
        }

        return () => unsubscribe();
    }, []);

    const countAdmins = () => {
        return users.filter(u => u.role === 'admin').length;
    };

    const handleRoleChange = async (userId, newRole) => {
        setError('');
        try {
            // Check admin limit constraint
            if (newRole === 'admin') {
                const adminCount = countAdmins();
                if (adminCount >= 2) {
                    setError('Maksimalus administratorių skaičius (2) pasiektas. Negalima suteikti administratoriaus teisių.');
                    return;
                }
            }

            const userRef = doc(db, 'users', userId);
            await updateDoc(userRef, {
                role: newRole
            });
        } catch (err) {
            console.error("Error updating role:", err);
            setError('Nepavyko atnaujinti rolės.');
        }
    };

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-8">
            <div className="p-6 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                    <UserCog className="w-6 h-6 text-blue-600" />
                    <h2 className="text-lg font-semibold text-gray-900">Vartotojų valdymas</h2>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                    Valdykite vartotojų roles. Maksimalus administratorių skaičius: 2.
                </p>
            </div>

            {error && (
                <div className="bg-red-50 border-l-4 border-red-500 p-4 m-4">
                    <div className="flex">
                        <div className="flex-shrink-0">
                            <ShieldAlert className="h-5 w-5 text-red-400" />
                        </div>
                        <div className="ml-3">
                            <p className="text-sm text-red-700">{error}</p>
                        </div>
                    </div>
                </div>
            )}

            <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50">
                        <tr>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Vartotojas
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Dabartinė rolė
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Veiksmai
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {users.map((user) => (
                            <tr key={user.id}>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <div className="flex items-center">
                                        {user.photoURL ? (
                                            <img className="h-10 w-10 rounded-full" src={user.photoURL} alt="" />
                                        ) : (
                                            <div className="h-10 w-10 rounded-full bg-gray-200 flex items-center justify-center">
                                                <span className="text-gray-500 font-medium">
                                                    {user.displayName?.charAt(0) || user.email?.charAt(0)}
                                                </span>
                                            </div>
                                        )}
                                        <div className="ml-4">
                                            <div className="text-sm font-medium text-gray-900">
                                                {user.displayName || 'Be vardo'}
                                            </div>
                                            <div className="text-sm text-gray-500">{user.email}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <span className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full 
                                        ${user.role === 'admin' ? 'bg-purple-100 text-purple-800' :
                                            user.role === 'manager' ? 'bg-blue-100 text-blue-800' :
                                                'bg-green-100 text-green-800'}`}>
                                        {user.role === 'admin' ? 'Administratorius' :
                                            user.role === 'manager' ? 'Vadovas' : 'Darbuotojas'}
                                    </span>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    <select
                                        value={user.role}
                                        onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                        className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                                    >
                                        <option value="worker">Darbuotojas</option>
                                        <option value="manager">Vadovas</option>
                                        <option value="admin">Administratorius</option>
                                    </select>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
