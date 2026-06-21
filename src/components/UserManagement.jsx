import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc } from 'firebase/firestore';
import { UserCog, ShieldAlert, Check, Sliders, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { formatDisplayName } from '../utils/formatters';
import { getContrastingTextColor } from '../utils/priority';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { cn } from '../utils/cn';
import Card from './ui/Card';
import Button from './ui/Button';
import StatusPill from './ui/StatusPill';
import Modal from './ui/Modal';
import ConfirmDialog from './ui/ConfirmDialog';

// Role display metadata. Tone avoids the reserved session blue (call) — admin reads as the
// brand accent, manager neutral, worker green; the text label always names the role so color
// is never the sole signal (§5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    manager: { label: 'Vadovas', tone: 'neutral' },
    worker: { label: 'Darbuotojas', tone: 'running' },
};

const SELECT_CLASS =
    'block w-full rounded-input border border-line bg-surface-card py-2.5 pl-3 pr-10 text-body-lg text-ink ' +
    'focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand';

function RoleBadge({ role }) {
    const meta = ROLE_META[role] || ROLE_META.worker;
    return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>;
}

function UserAvatar({ user }) {
    return user.photoURL ? (
        <img className="h-10 w-10 rounded-full object-cover" src={user.photoURL} alt="" />
    ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-sunken">
            <span className="font-medium text-ink-muted">
                {user.displayName?.charAt(0) || user.email?.charAt(0)}
            </span>
        </div>
    );
}

function ColorSwatch({ user, onEdit }) {
    const name = formatDisplayName(user.displayName) || user.email || 'vartotojo';
    const swatchColor = user.color || WORKER_FALLBACK_COLOR;
    // Pick the glyph color from the swatch's luminance so the icon keeps >=3:1 contrast on
    // any user-chosen color (white drops below 3:1 on light backgrounds). (DESIGN_SYSTEM §6)
    const iconColor = getContrastingTextColor(swatchColor);
    return (
        <button
            type="button"
            onClick={() => onEdit(user)}
            aria-label={`Keisti ${name} spalvą`}
            title="Keisti spalvą"
            className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-full border-2 border-line shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            style={{ backgroundColor: swatchColor }}
        >
            <Sliders className="h-4 w-4" style={{ color: iconColor }} aria-hidden="true" />
        </button>
    );
}

function RoleSelect({ user, onChange }) {
    const name = formatDisplayName(user.displayName) || user.email || '';
    return (
        <select
            value={user.role}
            onChange={(e) => onChange(user.id, e.target.value)}
            aria-label={`${name} rolė`}
            className={SELECT_CLASS}
        >
            <option value="worker">Darbuotojas</option>
            <option value="manager">Vadovas</option>
            <option value="admin">Administratorius</option>
        </select>
    );
}

function ManagerControl({ user, managers, onChange }) {
    const name = formatDisplayName(user.displayName) || user.email || '';
    if (user.role === 'admin' || user.role === 'manager') {
        return <span className="text-body italic text-ink-muted">Vadovas</span>;
    }
    return (
        <select
            value={user.defaultManager || ''}
            onChange={(e) => onChange(user.id, e.target.value)}
            aria-label={`${name} numatytasis vadovas`}
            className={SELECT_CLASS}
        >
            <option value="">Pasirinkti vadovą...</option>
            {managers.map((m) => (
                <option key={m.id} value={m.id}>
                    {formatDisplayName(m.displayName) || m.email}
                </option>
            ))}
        </select>
    );
}

function BlockButton({ user, isSelf, onRequest, fullWidth }) {
    return (
        <Button
            variant={user.isDisabled ? 'secondary' : 'danger'}
            size="md"
            icon={user.isDisabled ? Check : Trash2}
            disabled={isSelf}
            fullWidth={fullWidth}
            onClick={() => onRequest(user)}
        >
            {user.isDisabled ? 'Atblokuoti' : 'Blokuoti / Ištrinti'}
        </Button>
    );
}

function ColorSlider({ label, labelClass, value, onChange, track, accent }) {
    return (
        <div>
            <div className="mb-2 flex justify-between text-body">
                <span className={cn('font-medium', labelClass)}>{label}</span>
                <span className="font-mono text-ink-muted">{value}</span>
            </div>
            <input
                type="range"
                min="0"
                max="255"
                value={value}
                onChange={(e) => onChange(parseInt(e.target.value, 10))}
                aria-label={label}
                className={cn(
                    'h-2 w-full cursor-pointer appearance-none rounded-full',
                    track,
                    accent,
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2'
                )}
            />
        </div>
    );
}

export default function UserManagement() {
    const { currentUser, userRole } = useAuth();
    const [users, setUsers] = useState([]);
    const [error, setError] = useState('');

    // Color Picker State
    const [editingColorUser, setEditingColorUser] = useState(null);
    const [tempColor, setTempColor] = useState({ r: 59, g: 130, b: 246 }); // Default blue

    // Block/unblock confirmation (replaces window.confirm — §8)
    const [blockTarget, setBlockTarget] = useState(null);
    const [blocking, setBlocking] = useState(false);

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

    const managers = users.filter(
        (u) => (u.role === 'manager' || u.role === 'admin') && !u.isDisabled
    );

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
        setTempColor(hexToRgb(user.color || WORKER_FALLBACK_COLOR));
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
        setError('');
        try {
            const userRef = doc(db, 'users', userId);
            await updateDoc(userRef, {
                defaultManager: newManagerId
            });
        } catch (err) {
            console.error("Error updating default manager:", err);
            setError('Nepavyko atnaujinti numatytojo vadovo. Bandykite dar kartą.');
        }
    };

    const requestBlock = (user) => {
        if (user.id === currentUser?.uid) {
            setError('Negalite užblokuoti savęs.');
            return;
        }
        setError('');
        setBlockTarget(user);
    };

    const confirmBlock = async () => {
        if (!blockTarget) return;
        const user = blockTarget;
        setBlocking(true);
        try {
            const userRef = doc(db, 'users', user.id);
            await updateDoc(userRef, { isDisabled: !user.isDisabled });
            setBlockTarget(null);
        } catch (err) {
            console.error("Error updating user status:", err);
            if (err.code === 'permission-denied') {
                setError(`Neturite teisių. Jūsų rolė: ${userRole}.`);
            } else {
                setError('Nepavyko atnaujinti vartotojo statuso. Bandykite dar kartą.');
            }
            setBlockTarget(null);
        } finally {
            setBlocking(false);
        }
    };

    return (
        <Card as="section" className="mb-8 overflow-hidden">
            <div className="border-b border-line bg-surface-sunken p-6">
                <div className="flex items-center gap-2">
                    <UserCog className="h-6 w-6 text-brand" aria-hidden="true" />
                    <h2 className="text-h2 text-ink-strong">Vartotojų valdymas</h2>
                </div>
                <p className="mt-1 text-body text-ink-muted">
                    Valdykite vartotojų roles ir spalvas.
                </p>
            </div>

            {error && (
                <div className="m-4 flex items-start gap-3 rounded-control border-l-4 border-feedback-danger bg-feedback-danger/10 p-4">
                    <ShieldAlert className="h-5 w-5 shrink-0 text-feedback-danger" aria-hidden="true" />
                    <p className="text-body text-feedback-danger">{error}</p>
                </div>
            )}

            {/* Mobile / touch: one card per user (never a horizontally-scrolling table — §9) */}
            <ul className="divide-y divide-line md:hidden">
                {users.map((user) => (
                    <li key={user.id} className={cn('p-4', user.isDisabled && 'bg-surface-sunken/60')}>
                        <div className="flex items-start gap-3">
                            <UserAvatar user={user} />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="truncate text-body font-semibold text-ink-strong">
                                        {formatDisplayName(user.displayName) || 'Be vardo'}
                                    </p>
                                    {user.isDisabled && <StatusPill tone="danger" icon={Trash2}>Užblokuotas</StatusPill>}
                                </div>
                                <p className="truncate text-body text-ink-muted">{user.email}</p>
                                <div className="mt-2">
                                    <RoleBadge role={user.role} />
                                </div>
                            </div>
                            <ColorSwatch user={user} onEdit={startEditingColor} />
                        </div>

                        <div className="mt-4 grid gap-3">
                            <label className="block">
                                <span className="mb-1 block text-caption font-medium text-ink-muted">Rolė</span>
                                <RoleSelect user={user} onChange={handleRoleChange} />
                            </label>
                            {user.role === 'worker' && (
                                <label className="block">
                                    <span className="mb-1 block text-caption font-medium text-ink-muted">
                                        Numatytasis vadovas
                                    </span>
                                    <ManagerControl user={user} managers={managers} onChange={handleDefaultManagerChange} />
                                </label>
                            )}
                            <BlockButton
                                user={user}
                                isSelf={user.id === currentUser?.uid}
                                onRequest={requestBlock}
                                fullWidth
                            />
                        </div>
                    </li>
                ))}
            </ul>

            {/* Desktop / wide: denser table is allowed (§9) */}
            <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full divide-y divide-line">
                    <thead className="bg-surface-sunken">
                        <tr>
                            {['Vartotojas', 'Rolė', 'Spalva', 'Numatytasis vadovas', 'Veiksmai'].map((h) => (
                                <th
                                    key={h}
                                    className="px-6 py-3 text-left text-caption font-medium uppercase tracking-wider text-ink-muted"
                                >
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-line bg-surface-card">
                        {users.map((user) => (
                            <tr key={user.id} className={user.isDisabled ? 'bg-surface-sunken/60' : ''}>
                                <td className="whitespace-nowrap px-6 py-4">
                                    <div className="flex items-center gap-3">
                                        <UserAvatar user={user} />
                                        <div>
                                            <div className="flex items-center gap-2 text-body font-medium text-ink-strong">
                                                {formatDisplayName(user.displayName) || 'Be vardo'}
                                                {user.isDisabled && (
                                                    <StatusPill tone="danger" icon={Trash2}>Užblokuotas</StatusPill>
                                                )}
                                            </div>
                                            <div className="text-body text-ink-muted">{user.email}</div>
                                        </div>
                                    </div>
                                </td>
                                <td className="whitespace-nowrap px-6 py-4">
                                    <RoleBadge role={user.role} />
                                </td>
                                <td className="whitespace-nowrap px-6 py-4">
                                    <ColorSwatch user={user} onEdit={startEditingColor} />
                                </td>
                                <td className="px-6 py-4">
                                    <ManagerControl user={user} managers={managers} onChange={handleDefaultManagerChange} />
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex flex-col gap-2">
                                        <RoleSelect user={user} onChange={handleRoleChange} />
                                        <BlockButton
                                            user={user}
                                            isSelf={user.id === currentUser?.uid}
                                            onRequest={requestBlock}
                                        />
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            {/* RGB Color Picker — canonical Modal (replaces the hand-rolled scaffold) */}
            <Modal
                open={!!editingColorUser}
                onClose={cancelEditingColor}
                title="Pasirinkite spalvą"
                size="md"
                footer={
                    <div className="flex gap-3">
                        <Button variant="secondary" fullWidth onClick={cancelEditingColor}>
                            Atšaukti
                        </Button>
                        <Button variant="primary" icon={Check} fullWidth onClick={saveColor}>
                            Išsaugoti
                        </Button>
                    </div>
                }
            >
                <div className="space-y-4">
                    <ColorSlider
                        label="Raudona (R)"
                        labelClass="text-red-600"
                        value={tempColor.r}
                        onChange={(v) => setTempColor({ ...tempColor, r: v })}
                        track="bg-red-100"
                        accent="accent-red-600"
                    />
                    <ColorSlider
                        label="Žalia (G)"
                        labelClass="text-green-600"
                        value={tempColor.g}
                        onChange={(v) => setTempColor({ ...tempColor, g: v })}
                        track="bg-green-100"
                        accent="accent-green-600"
                    />
                    <ColorSlider
                        label="Mėlyna (B)"
                        labelClass="text-blue-600"
                        value={tempColor.b}
                        onChange={(v) => setTempColor({ ...tempColor, b: v })}
                        track="bg-blue-100"
                        accent="accent-blue-600"
                    />

                    <div>
                        <span className="mb-2 block text-body font-medium text-ink">Peržiūra</span>
                        <div
                            className="flex h-16 w-full items-center justify-center rounded-card border border-line shadow-inner"
                            style={{ backgroundColor: `rgb(${tempColor.r}, ${tempColor.g}, ${tempColor.b})` }}
                        >
                            <span className="rounded bg-surface-card/90 px-2 py-1 font-mono text-caption text-ink-muted shadow-sm">
                                rgb({tempColor.r}, {tempColor.g}, {tempColor.b})
                            </span>
                        </div>
                    </div>
                </div>
            </Modal>

            {/* Block / unblock confirmation (replaces window.confirm — §8) */}
            {blockTarget && (
                <ConfirmDialog
                    open
                    title={blockTarget.isDisabled ? 'Atblokuoti vartotoją?' : 'Blokuoti / ištrinti vartotoją?'}
                    message={`Vartotojas: ${formatDisplayName(blockTarget.displayName) || blockTarget.email}.`}
                    warning={blockTarget.isDisabled ? undefined : 'Vartotojas neteks prieigos prie sistemos.'}
                    confirmLabel={blockTarget.isDisabled ? 'Atblokuoti' : 'Blokuoti'}
                    variant={blockTarget.isDisabled ? 'primary' : 'danger'}
                    loading={blocking}
                    onConfirm={confirmBlock}
                    onCancel={() => setBlockTarget(null)}
                />
            )}
        </Card>
    );
}
