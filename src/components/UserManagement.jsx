import { useState, useEffect } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { UserCog, ShieldAlert, Check, Sliders, Trash2, Clock, Ban, Star, Users, Globe } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pauseTask } from '../utils/taskActions';
import { logError } from '../utils/errorLog';
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
    seniorManager: { label: 'Vyr. vadovas', tone: 'neutral' },
    manager: { label: 'Vadovas', tone: 'neutral' },
    worker: { label: 'Vykdytojas', tone: 'running' },
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
            <option value="worker">Vykdytojas</option>
            <option value="manager">Vadovas</option>
            <option value="seniorManager">Vyr. vadovas</option>
            <option value="admin">Administratorius</option>
        </select>
    );
}

// A worker's managers (visibility scope). The array is teamManagerIds; a legacy doc that only
// has the single defaultManager is treated as a one-member team so it shows correctly until the
// backfill normalises it.
function effectiveTeamIds(user) {
    if (Array.isArray(user.teamManagerIds)) return user.teamManagerIds;
    return user.defaultManager ? [user.defaultManager] : [];
}

// Visibility control. Branches by role:
//  • admin / senior manager — always global; shows a static "Mato visus" label (a senior
//    manager (Vyr. vadovas) sees the whole company by rank and has no scope toggle).
//  • manager — a per-manager scope toggle ("Tik sava komanda" vs "Visa įmonė"). Default
//    (scopedManager absent/false) keeps today's behaviour: the manager sees the whole company.
//    Only when an admin turns it on does the manager become restricted to their assigned people.
//  • worker  — multi-select manager chips (their team), star marks the primary (defaultManager).
// teamManagerIds is the visibility key the security rules read; it always contains the primary.
function ManagerControl({ user, managers, onToggle, onSetPrimary, onToggleScoped }) {
    const name = formatDisplayName(user.displayName) || user.email || '';
    if (user.role === 'admin' || user.role === 'seniorManager') {
        return <span className="text-body italic text-ink-muted">Mato visus</span>;
    }
    if (user.role === 'manager') {
        const scoped = user.scopedManager === true;
        return (
            <button
                type="button"
                aria-pressed={scoped}
                onClick={() => onToggleScoped(user)}
                title={scoped ? 'Mato tik savo komandą' : 'Mato visą įmonę'}
                className={cn(
                    'inline-flex min-h-touch items-center gap-2 rounded-full border px-3 text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                    scoped ? 'border-brand bg-brand/10 text-ink' : 'border-line bg-surface-card text-ink-muted'
                )}
            >
                {scoped
                    ? <Users className="h-4 w-4 text-brand" aria-hidden="true" />
                    : <Globe className="h-4 w-4" aria-hidden="true" />}
                {scoped ? 'Tik sava komanda' : 'Visa įmonė'}
            </button>
        );
    }
    if (managers.length === 0) {
        return <span className="text-body italic text-ink-muted">Nėra vadovų</span>;
    }
    const teamIds = effectiveTeamIds(user);
    return (
        <fieldset>
            <legend className="sr-only">{`${name} vadovai`}</legend>
            <div className="flex flex-wrap gap-2">
                {managers.map((m) => {
                    const selected = teamIds.includes(m.id);
                    const primary = selected && user.defaultManager === m.id;
                    const mName = formatDisplayName(m.displayName) || m.email;
                    return (
                        <span
                            key={m.id}
                            className={cn(
                                'inline-flex items-center overflow-hidden rounded-full border',
                                selected ? 'border-brand bg-brand/10' : 'border-line bg-surface-card'
                            )}
                        >
                            <button
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onToggle(user, m.id)}
                                className="inline-flex min-h-touch items-center gap-1 px-3 text-body text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                            >
                                {selected && <Check className="h-4 w-4 text-brand" aria-hidden="true" />}
                                {mName}
                            </button>
                            {selected && (
                                <button
                                    type="button"
                                    aria-pressed={primary}
                                    aria-label={primary ? `${mName} — pagrindinis vadovas` : `Padaryti ${mName} pagrindiniu vadovu`}
                                    title={primary ? 'Pagrindinis vadovas' : 'Padaryti pagrindiniu'}
                                    onClick={() => onSetPrimary(user, m.id)}
                                    className="inline-flex min-h-touch min-w-touch items-center justify-center border-l border-brand/30 px-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                                >
                                    <Star className={cn('h-4 w-4', primary ? 'fill-current text-brand' : 'text-ink-muted')} aria-hidden="true" />
                                </button>
                            )}
                        </span>
                    );
                })}
            </div>
        </fieldset>
    );
}

// A pending account is disabled AND flagged status:'pending' (newly self-signed-in, awaiting
// approval), as opposed to a manually blocked one.
function isPendingUser(user) {
    return user.isDisabled && user.status === 'pending';
}

// Disabled-state pill: distinguishes "awaiting approval" from "blocked" so an admin can tell a
// new sign-up apart from a deliberately disabled account.
function DisabledPill({ user }) {
    if (!user.isDisabled) return null;
    return isPendingUser(user)
        ? <StatusPill tone="pending" icon={Clock}>Laukia patvirtinimo</StatusPill>
        : <StatusPill tone="danger" icon={Trash2}>Užblokuotas</StatusPill>;
}

function BlockButton({ user, isSelf, onRequest, fullWidth }) {
    const pending = isPendingUser(user);
    // The action only ever toggles isDisabled — nothing is deleted — so the enable side reads
    // "Patvirtinti" (pending) / "Atblokuoti" (blocked) and the disable side reads "Blokuoti",
    // not the misleading "Blokuoti / Ištrinti" with a trash icon.
    return (
        <Button
            variant={user.isDisabled ? (pending ? 'primary' : 'secondary') : 'danger'}
            size="md"
            icon={user.isDisabled ? Check : Ban}
            disabled={isSelf}
            fullWidth={fullWidth}
            onClick={() => onRequest(user)}
        >
            {user.isDisabled ? (pending ? 'Patvirtinti' : 'Atblokuoti') : 'Blokuoti'}
        </Button>
    );
}

// Permanent delete. Admin-only and kept visually subordinate to Block (the everyday action):
// a quiet danger-toned ghost button so the reversible toggle stays dominant over the
// irreversible one (§8). Self-deletion is disabled.
function DeleteButton({ user, isSelf, onRequest, fullWidth }) {
    return (
        <Button
            variant="ghost"
            size="md"
            icon={Trash2}
            disabled={isSelf}
            fullWidth={fullWidth}
            className="text-feedback-danger"
            onClick={() => onRequest(user)}
        >
            Ištrinti
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

// True when the user is mid-session (any live timer). A disabled user is force-logged-out
// and can no longer stop their own timer, so we must settle this before flipping isDisabled.
function hasOpenSession(user) {
    return !!(
        user.activeSession ||
        user.workStatus?.status === 'running' ||
        user.breakState?.isTakingBreak ||
        user.callState?.isCalling ||
        user.quickWorkState?.isQuickWorking
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

    // Delete confirmation. Permanent removal of the user's Firestore record — admin-only and
    // separate from the reversible block toggle, so it never sits on the same button (§8).
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const isAdmin = userRole === 'admin';

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
        (u) => (u.role === 'manager' || u.role === 'admin' || u.role === 'seniorManager') && !u.isDisabled
    );

    const countAdmins = () => {
        return users.filter(u => u.role === 'admin' && !u.isDisabled).length;
    };

    const handleRoleChange = async (userId, newRole) => {
        setError('');
        try {
            // Never strip the last remaining admin: demoting the only active admin would lock
            // the whole team out of every admin-only surface, and the in-app "become admin"
            // bootstrap is denied by the security rules — so recovery would need direct DB edits.
            const target = users.find(u => u.id === userId);
            if (target?.role === 'admin' && !target?.isDisabled && newRole !== 'admin' && countAdmins() <= 1) {
                setError('Negalima pašalinti paskutinio administratoriaus. Pirma suteikite administratoriaus teises kitam vartotojui.');
                return;
            }

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

    // Toggle a manager in/out of a worker's team. The primary (defaultManager) must always stay
    // a member: when the current primary is removed (or the first manager is added and none is
    // primary yet) it falls back to the first remaining manager. Both fields are written together
    // so the invariant "teamManagerIds ⊇ {defaultManager}" can never break.
    const handleToggleManager = async (user, managerId) => {
        setError('');
        const current = effectiveTeamIds(user);
        const next = current.includes(managerId)
            ? current.filter((id) => id !== managerId)
            : [...current, managerId];
        let primary = user.defaultManager || '';
        if (!next.includes(primary)) primary = next[0] || '';
        try {
            await updateDoc(doc(db, 'users', user.id), {
                teamManagerIds: next,
                defaultManager: primary,
            });
        } catch (err) {
            console.error("Error updating managers:", err);
            setError('Nepavyko atnaujinti vadovų. Bandykite dar kartą.');
        }
    };

    // Mark a manager as primary (approval/notification routing). Adds them to the team first if
    // somehow not already a member, preserving the invariant.
    const handleSetPrimary = async (user, managerId) => {
        setError('');
        const current = effectiveTeamIds(user);
        const next = current.includes(managerId) ? current : [...current, managerId];
        try {
            await updateDoc(doc(db, 'users', user.id), {
                teamManagerIds: next,
                defaultManager: managerId,
            });
        } catch (err) {
            console.error("Error setting primary manager:", err);
            setError('Nepavyko nustatyti pagrindinio vadovo. Bandykite dar kartą.');
        }
    };

    // Toggle whether a manager is restricted to their assigned people. Default off = sees the
    // whole company (today's behaviour); on = scoped to their team (ADR 0005).
    const handleToggleScoped = async (user) => {
        setError('');
        try {
            await updateDoc(doc(db, 'users', user.id), {
                scopedManager: !(user.scopedManager === true),
            });
        } catch (err) {
            console.error("Error updating manager scope:", err);
            setError('Nepavyko atnaujinti vadovo prieigos. Bandykite dar kartą.');
        }
    };

    const requestBlock = (user) => {
        if (user.id === currentUser?.uid) {
            setError('Negalite užblokuoti savęs.');
            return;
        }
        // Same floor as role demotion: never disable the last active admin (re-enabling is fine).
        if (!user.isDisabled && user.role === 'admin' && countAdmins() <= 1) {
            setError('Negalima užblokuoti paskutinio administratoriaus. Pirma suteikite administratoriaus teises kitam vartotojui.');
            return;
        }
        setError('');
        setBlockTarget(user);
    };

    // Settle a mid-session worker before disabling them. A disabled user is force-logged-out
    // and cannot stop their own timer, so otherwise the running segment is never logged and
    // they show "working" forever. We pause a running TASK (its work_sessions log is allowed
    // for managers/admins) and clear every live-session flag on the user doc. Non-task break/
    // call/quick-work tails cannot be logged by an admin (those collections are owner-only),
    // but clearing the flags at least removes the ghost session. Failure here must not block
    // the disable itself, so it is logged and swallowed.
    const closeActiveSessionForUser = async (user) => {
        try {
            const activeTaskId = user.activeSession?.taskId || user.workStatus?.activeTaskId;
            if (activeTaskId) {
                const taskSnap = await getDoc(doc(db, 'tasks', activeTaskId));
                if (taskSnap.exists()) {
                    const t = { id: taskSnap.id, ...taskSnap.data() };
                    if (t.timerStatus === 'running') {
                        await pauseTask(t); // logs the segment + clears the user's activeSession/workStatus
                    }
                }
            }
            await updateDoc(doc(db, 'users', user.id), {
                activeSession: null,
                'workStatus.isWorking': false,
                'workStatus.status': 'idle',
                'workStatus.activeTaskId': null,
                'breakState.isTakingBreak': false,
                'callState.isCalling': false,
                'quickWorkState.isQuickWorking': false
            });
        } catch (e) {
            logError(e, { source: 'closeActiveSessionForUser', userId: user.id });
        }
    };

    const confirmBlock = async () => {
        if (!blockTarget) return;
        const user = blockTarget;
        // Backstop the last-admin floor in case the admin count changed while the dialog was open.
        if (!user.isDisabled && user.role === 'admin' && countAdmins() <= 1) {
            setError('Negalima užblokuoti paskutinio administratoriaus. Pirma suteikite administratoriaus teises kitam vartotojui.');
            setBlockTarget(null);
            return;
        }
        setBlocking(true);
        try {
            // Only on DISABLE (not on re-enable): close any open session first.
            if (!user.isDisabled && hasOpenSession(user)) {
                await closeActiveSessionForUser(user);
            }
            const userRef = doc(db, 'users', user.id);
            const updates = { isDisabled: !user.isDisabled };
            // Approving/unblocking clears the pending flag so the account is fully active.
            if (user.isDisabled) updates.status = 'active';
            await updateDoc(userRef, updates);
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

    const requestDelete = (user) => {
        if (user.id === currentUser?.uid) {
            setError('Negalite ištrinti savęs.');
            return;
        }
        // Same floor as block/demotion: never remove the last active admin.
        if (user.role === 'admin' && !user.isDisabled && countAdmins() <= 1) {
            setError('Negalima ištrinti paskutinio administratoriaus. Pirma suteikite administratoriaus teises kitam vartotojui.');
            return;
        }
        setError('');
        setDeleteTarget(user);
    };

    const confirmDelete = async () => {
        if (!deleteTarget) return;
        const user = deleteTarget;
        // Backstop the last-admin floor in case the count changed while the dialog was open.
        if (user.role === 'admin' && !user.isDisabled && countAdmins() <= 1) {
            setError('Negalima ištrinti paskutinio administratoriaus. Pirma suteikite administratoriaus teises kitam vartotojui.');
            setDeleteTarget(null);
            return;
        }
        setDeleting(true);
        try {
            // Settle any open session first so no work segment is lost and no ghost "working"
            // flag is left on a now-deleted record (same reasoning as block).
            if (hasOpenSession(user)) {
                await closeActiveSessionForUser(user);
            }
            await deleteDoc(doc(db, 'users', user.id));
            setDeleteTarget(null);
        } catch (err) {
            console.error("Error deleting user:", err);
            if (err.code === 'permission-denied') {
                setError(`Neturite teisių. Jūsų rolė: ${userRole}.`);
            } else {
                setError('Nepavyko ištrinti vartotojo. Bandykite dar kartą.');
            }
            setDeleteTarget(null);
        } finally {
            setDeleting(false);
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

            {/* Mobile / touch: one distinct card per user — laid on a sunken backdrop with gaps,
                border, shadow and a left accent in the user's own color so each user reads as a
                separate card, not a divider-separated row (never a horizontal table — §9). */}
            <ul className="space-y-3 bg-surface-sunken/40 p-3 md:hidden">
                {users.map((user) => (
                    <li
                        key={user.id}
                        className={cn(
                            'rounded-card border border-line bg-surface-card p-4 shadow-sm',
                            user.isDisabled && 'bg-surface-sunken/60 opacity-90'
                        )}
                        style={{ borderLeft: `4px solid ${user.color || WORKER_FALLBACK_COLOR}` }}
                    >
                        <div className="flex items-start gap-3">
                            <UserAvatar user={user} />
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <p className="truncate text-body font-semibold text-ink-strong">
                                        {formatDisplayName(user.displayName) || 'Be vardo'}
                                    </p>
                                    <DisabledPill user={user} />
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
                            <div>
                                <span className="mb-1 block text-caption font-medium text-ink-muted">
                                    Matomumas
                                </span>
                                <ManagerControl
                                    user={user}
                                    managers={managers}
                                    onToggle={handleToggleManager}
                                    onSetPrimary={handleSetPrimary}
                                    onToggleScoped={handleToggleScoped}
                                />
                            </div>
                            <BlockButton
                                user={user}
                                isSelf={user.id === currentUser?.uid}
                                onRequest={requestBlock}
                                fullWidth
                            />
                            {isAdmin && (
                                <DeleteButton
                                    user={user}
                                    isSelf={user.id === currentUser?.uid}
                                    onRequest={requestDelete}
                                    fullWidth
                                />
                            )}
                        </div>
                    </li>
                ))}
            </ul>

            {/* Desktop / wide: denser table is allowed (§9) */}
            <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full divide-y divide-line">
                    <thead className="bg-surface-sunken">
                        <tr>
                            {['Vartotojas', 'Rolė', 'Spalva', 'Matomumas', 'Veiksmai'].map((h) => (
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
                                                <DisabledPill user={user} />
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
                                    <ManagerControl
                                        user={user}
                                        managers={managers}
                                        onToggle={handleToggleManager}
                                        onSetPrimary={handleSetPrimary}
                                        onToggleScoped={handleToggleScoped}
                                    />
                                </td>
                                <td className="px-6 py-4">
                                    <div className="flex flex-col gap-2">
                                        <RoleSelect user={user} onChange={handleRoleChange} />
                                        <BlockButton
                                            user={user}
                                            isSelf={user.id === currentUser?.uid}
                                            onRequest={requestBlock}
                                        />
                                        {isAdmin && (
                                            <DeleteButton
                                                user={user}
                                                isSelf={user.id === currentUser?.uid}
                                                onRequest={requestDelete}
                                            />
                                        )}
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
                    title={
                        blockTarget.isDisabled
                            ? (isPendingUser(blockTarget) ? 'Patvirtinti vartotoją?' : 'Atblokuoti vartotoją?')
                            : 'Blokuoti vartotoją?'
                    }
                    message={`Vartotojas: ${formatDisplayName(blockTarget.displayName) || blockTarget.email}.`}
                    warning={
                        blockTarget.isDisabled
                            ? undefined
                            : hasOpenSession(blockTarget)
                                ? 'Vartotojas neteks prieigos prie sistemos. Jis šiuo metu turi aktyvią sesiją — ji bus automatiškai užbaigta.'
                                : 'Vartotojas neteks prieigos prie sistemos.'
                    }
                    confirmLabel={blockTarget.isDisabled ? (isPendingUser(blockTarget) ? 'Patvirtinti' : 'Atblokuoti') : 'Blokuoti'}
                    variant={blockTarget.isDisabled ? 'primary' : 'danger'}
                    loading={blocking}
                    onConfirm={confirmBlock}
                    onCancel={() => setBlockTarget(null)}
                />
            )}

            {/* Permanent delete confirmation (irreversible — admin-only) */}
            {deleteTarget && (
                <ConfirmDialog
                    open
                    title="Ištrinti vartotoją?"
                    message={`Vartotojas: ${formatDisplayName(deleteTarget.displayName) || deleteTarget.email}.`}
                    warning="Vartotojo įrašas bus visam laikui pašalintas. Šio veiksmo atšaukti negalima."
                    confirmLabel="Ištrinti"
                    variant="danger"
                    loading={deleting}
                    onConfirm={confirmDelete}
                    onCancel={() => setDeleteTarget(null)}
                />
            )}
        </Card>
    );
}
