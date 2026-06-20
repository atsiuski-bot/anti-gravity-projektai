import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { UserCog, ShieldAlert, Check, Sliders, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDisplayName } from '../utils/formatters';

export default function UserManagement() {
    const { currentUser, userRole } = useAuth();
    const [users, setUsers] = useState([]);
    const [error, setError] = useState('');

    // Color Picker State
    const [editingColorUser, setEditingColorUser] = useState(null);
    const [tempColor, setTempColor] = useState({ r: 59, g: 130, b: 246 }); // Default blue

    useEffect(() => {
        let unsubscribe = () => { };

        try {
            unsubscribe = onSnapshot(collection(db, 'users'), (snapshot) => {
                const usersData = snapshot.docs.map(doc => ({
                    id: doc.id,
                    ...doc.data()
                }));
                setUsers(usersData);
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
        // eslint-disable-next-line react-hooks/exhaustive-deps -- subscribe once on mount; adding 'error' would tear down/re-create the listener on every error change
    }, []);

    const countAdmins = () => {
        return users.filter(u => u.role === 'admin' && !u.isDisabled).length;
    };

    const handleRoleChange = async (userId, newRole) => {
        setError('');
        try {
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

    // Helper: Hex to RGB
    const hexToRgb = (hex) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
            r: parseInt(result[1], 16),
            g: parseInt(result[2], 16),
            b: parseInt(result[3], 16)
        } : { r: 59, g: 130, b: 246 };
    };

    // Helper: RGB to Hex
    const rgbToHex = (r, g, b) => {
        return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
    };

    const startEditingColor = (user) => {
        setEditingColorUser(user.id);
        setTempColor(hexToRgb(user.color || '#3b82f6'));
    };

    const saveColor = async () => {
        if (!editingColorUser) return;

        const hexColor = rgbToHex(tempColor.r, tempColor.g, tempColor.b);

        try {
            const userRef = doc(db, 'users', editingColorUser);
            await updateDoc(userRef, {
                color: hexColor
            });
            setEditingColorUser(null);
        } catch (err) {
            console.error("Error updating color:", err);
            setError("Nepavyko išsaugoti spalvos.");
        }
    };

    const cancelEditingColor = () => {
        setEditingColorUser(null);
    };

    const handleDefaultManagerChange = async (userId, newManagerId) => {
        console.log(`[UserManagement] Changing default manager for user ${userId} to: ${newManagerId || 'None'}`);
        setError('');
        try {
            const userRef = doc(db, 'users', userId);
            await updateDoc(userRef, {
                defaultManager: newManagerId
            });
            console.log("[UserManagement] Default manager updated successfully");
        } catch (err) {
            console.error("Error updating default manager:", err);
            setError('Nepavyko atnaujinti numatytojo vadovo: ' + err.message);
        }
    };

    const handleToggleBlockUser = async (user) => {
        const userId = user.id;
        const userName = formatDisplayName(user.displayName) || user.email;
        const isCurrentlyDisabled = user.isDisabled;

        if (userId === currentUser?.uid) {
            setError('Negalite užblokuoti savęs.');
            return;
        }

        const actionText = isCurrentlyDisabled ? "atblokuoti" : "užblokuoti/ištrinti";
        if (!window.confirm(`Ar tikrai norite ${actionText} vartotoją "${userName}"?`)) {
            return;
        }

        try {
            setError('');
            const userRef = doc(db, 'users', userId);
            await updateDoc(userRef, {
                isDisabled: !isCurrentlyDisabled
            });
            console.log(`User ${userId} ${isCurrentlyDisabled ? 'unblocked' : 'blocked'}`);
        } catch (err) {
            console.error("Error updating user status:", err);
            if (err.code === 'permission-denied') {
                setError(`Neturite teisių. Jūsų rolė: ${userRole}.`);
            } else {
                setError(`Nepavyko atnaujinti vartotojo statuso: ${err.message}`);
            }
        }
    };

    return (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden mb-8 relative">
            <div className="p-6 border-b border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                    <UserCog className="w-6 h-6 text-blue-600" />
                    <h2 className="text-lg font-semibold text-gray-900">Vartotojų valdymas</h2>
                </div>
                <p className="text-sm text-gray-500 mt-1">
                    Valdykite vartotojų roles ir spalvas.
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
                                Rolė
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Spalva
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Numatytasis vadovas
                            </th>
                            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                                Veiksmai
                            </th>
                        </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                        {users.map((user) => (
                            <tr key={user.id} className={user.isDisabled ? 'bg-gray-50 opacity-75' : ''}>
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
                                                {formatDisplayName(user.displayName) || 'Be vardo'}
                                                {user.isDisabled && <span className="ml-2 text-xs text-red-500 font-bold">(Užblokuotas)</span>}
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
                                <td className="px-6 py-4 whitespace-nowrap">
                                    <button
                                        onClick={() => startEditingColor(user)}
                                        className="w-10 h-10 rounded-full border-2 border-gray-300 shadow-sm hover:ring-2 hover:ring-offset-2 hover:ring-blue-500 transition-all flex items-center justify-center"
                                        style={{ backgroundColor: user.color || '#3b82f6' }}
                                        title="Keisti spalvą"
                                    >
                                        <Sliders className="w-4 h-4 text-white drop-shadow-md opacity-75" />
                                    </button>
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap">
                                    {user.role === 'admin' || user.role === 'manager' ? (
                                        <span className="text-xs text-gray-500 italic">Vadovas</span>
                                    ) : (
                                        <select
                                            value={user.defaultManager || ''}
                                            onChange={(e) => handleDefaultManagerChange(user.id, e.target.value)}
                                            className="block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                                        >
                                            <option value="">Pasirinkti vadovą...</option>
                                            {users
                                                .filter(u => (u.role === 'manager' || u.role === 'admin') && !u.isDisabled)
                                                .map(manager => (
                                                    <option key={manager.id} value={manager.id}>
                                                        {formatDisplayName(manager.displayName) || manager.email}
                                                    </option>
                                                ))}
                                        </select>
                                    )}
                                </td>
                                <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                    <div className="flex flex-col gap-2">
                                        <select
                                            value={user.role}
                                            onChange={(e) => handleRoleChange(user.id, e.target.value)}
                                            className="mt-1 block w-full pl-3 pr-10 py-2 text-base border-gray-300 focus:outline-none focus:ring-blue-500 focus:border-blue-500 sm:text-sm rounded-md"
                                        >
                                            <option value="worker">Darbuotojas</option>
                                            <option value="manager">Vadovas</option>
                                            <option value="admin">Administratorius</option>
                                        </select>
                                        <button
                                            onClick={() => handleToggleBlockUser(user)}
                                            disabled={user.id === currentUser?.uid}
                                            className={`flex items-center justify-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${user.id === currentUser?.uid
                                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                                : user.isDisabled
                                                    ? 'bg-green-50 text-green-600 hover:bg-green-100'
                                                    : 'bg-red-50 text-red-600 hover:bg-red-100'
                                                }`}
                                        >
                                            {user.isDisabled ? (
                                                <>
                                                    <Check className="w-3 h-3" />
                                                    Atblokuoti
                                                </>
                                            ) : (
                                                <>
                                                    <Trash2 className="w-3 h-3" />
                                                    Blokuoti / Ištrinti
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* RGB Color Picker Modal */}
            {editingColorUser && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={cancelEditingColor}>
                    <div
                        className="bg-white rounded-xl shadow-2xl border border-gray-200 p-6 max-w-md w-full"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="flex items-center justify-between mb-6">
                            <h3 className="text-lg font-semibold text-gray-900">Pasirinkite spalvą</h3>
                        </div>

                        {/* RGB Sliders */}
                        <div className="space-y-4 mb-6">
                            {/* Red Slider */}
                            <div>
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-red-600 font-medium">Raudona (R)</span>
                                    <span className="text-gray-500 font-mono">{tempColor.r}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="255"
                                    value={tempColor.r}
                                    onChange={(e) => setTempColor({ ...tempColor, r: parseInt(e.target.value) })}
                                    className="w-full h-2 bg-red-100 rounded-lg appearance-none cursor-pointer accent-red-600"
                                />
                            </div>

                            {/* Green Slider */}
                            <div>
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-green-600 font-medium">Žalia (G)</span>
                                    <span className="text-gray-500 font-mono">{tempColor.g}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="255"
                                    value={tempColor.g}
                                    onChange={(e) => setTempColor({ ...tempColor, g: parseInt(e.target.value) })}
                                    className="w-full h-2 bg-green-100 rounded-lg appearance-none cursor-pointer accent-green-600"
                                />
                            </div>

                            {/* Blue Slider */}
                            <div>
                                <div className="flex justify-between text-sm mb-2">
                                    <span className="text-blue-600 font-medium">Mėlyna (B)</span>
                                    <span className="text-gray-500 font-mono">{tempColor.b}</span>
                                </div>
                                <input
                                    type="range"
                                    min="0"
                                    max="255"
                                    value={tempColor.b}
                                    onChange={(e) => setTempColor({ ...tempColor, b: parseInt(e.target.value) })}
                                    className="w-full h-2 bg-blue-100 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                />
                            </div>
                        </div>

                        {/* Preview */}
                        <div className="mb-6">
                            <label className="block text-sm font-medium text-gray-700 mb-2">Peržiūra</label>
                            <div
                                className="w-full h-16 rounded-lg border border-gray-200 shadow-inner flex items-center justify-center"
                                style={{ backgroundColor: `rgb(${tempColor.r}, ${tempColor.g}, ${tempColor.b})` }}
                            >
                                <span className="bg-white/90 px-2 py-1 rounded text-xs font-mono text-gray-600 shadow-sm">
                                    rgb({tempColor.r}, {tempColor.g}, {tempColor.b})
                                </span>
                            </div>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-3">
                            <button
                                onClick={cancelEditingColor}
                                className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 font-medium transition-colors"
                            >
                                Atšaukti
                            </button>
                            <button
                                onClick={saveColor}
                                className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium shadow-sm transition-colors flex items-center justify-center gap-2"
                            >
                                <Check className="w-4 h-4" />
                                Išsaugoti
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
