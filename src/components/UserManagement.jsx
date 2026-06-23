import { useState, useEffect, useMemo } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { ShieldAlert, Check, Sliders, Trash2, Clock, Ban, Star, Users, Globe, Sparkles, Coins, ChevronDown } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pauseTask } from '../utils/taskActions';
import { logError } from '../utils/errorLog';
import { formatDisplayName } from '../utils/formatters';
import { hasPayRate } from '../utils/payRate';
import { getContrastingTextColor } from '../utils/priority';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { cn } from '../utils/cn';
import UserChip from './UserChip';
import Card from './ui/Card';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import StatusPill from './ui/StatusPill';
import Modal from './ui/Modal';
import Select from './ui/Select';
import ConfirmDialog from './ui/ConfirmDialog';
import PayRateModal from './PayRateModal';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';

// Role display metadata. Tone avoids the reserved session blue (call) — admin reads as the
// brand accent, manager neutral, worker green; the text label always names the role so color
// is never the sole signal (§5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    seniorManager: { label: 'Vyr. vadovas', tone: 'neutral' },
    manager: { label: 'Vadovas', tone: 'neutral' },
    worker: { label: 'Vykdytojas', tone: 'running' },
};

function RoleBadge({ role }) {
    const meta = ROLE_META[role] || ROLE_META.worker;
    return <StatusPill tone={meta.tone} icon={ROLE_GLYPHS[role]}>{meta.label}</StatusPill>;
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
        <Select
            value={user.role}
            onChange={(val) => onChange(user.id, val)}
            options={[
                { value: 'worker', label: 'Vykdytojas' },
                { value: 'manager', label: 'Vadovas' },
                { value: 'seniorManager', label: 'Vyr. vadovas' },
                { value: 'admin', label: 'Administratorius' },
            ]}
            label="Rolė"
            ariaLabel={`${name} rolė`}
            alwaysSheet
        />
    );
}

// A worker's managers (visibility scope). The array is teamManagerIds; a legacy doc that only
// has the single defaultManager is treated as a one-member team so it shows correctly until the
// backfill normalises it.
function effectiveTeamIds(user) {
    if (Array.isArray(user.teamManagerIds)) return user.teamManagerIds;
    return user.defaultManager ? [user.defaultManager] : [];
}

// A manager's senior managers (the Vyr. vadovas they answer to). Plain array, no legacy fallback —
// this membership is new with the four-level hierarchy (ADR 0007).
function effectiveSeniorIds(user) {
    return Array.isArray(user.seniorManagerIds) ? user.seniorManagerIds : [];
}

// One reusable multi-select chip row: a candidate is toggled in/out of `selectedIds`, and (when
// `onSetPrimary` is given) a selected chip can be starred as the primary. Used for BOTH a worker's
// managers (with a primary star) and a manager's seniors (no primary).
function ChipMultiSelect({ legend, candidates, selectedIds, onToggle, primaryId, onSetPrimary, emptyLabel }) {
    if (candidates.length === 0) {
        return <span className="text-body italic text-ink-muted">{emptyLabel}</span>;
    }
    return (
        <fieldset>
            <legend className="sr-only">{legend}</legend>
            <div className="flex flex-wrap gap-2">
                {candidates.map((c) => {
                    const selected = selectedIds.includes(c.id);
                    const primary = !!onSetPrimary && selected && primaryId === c.id;
                    const cName = formatDisplayName(c.displayName) || c.email;
                    return (
                        <span
                            key={c.id}
                            className={cn(
                                'inline-flex items-center overflow-hidden rounded-full border',
                                selected ? 'border-brand bg-brand/10' : 'border-line bg-surface-card'
                            )}
                        >
                            <button
                                type="button"
                                aria-pressed={selected}
                                onClick={() => onToggle(c.id)}
                                className="inline-flex min-h-touch items-center gap-1 py-1 pl-1.5 pr-2.5 text-caption text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                            >
                                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />}
                                {/* Standard person rendering: avatar + name (UserChip), at the small
                                    size — non-interactive (linkToProfile=false) so it nests cleanly
                                    inside this toggle button. */}
                                <UserChip userId={c.id} name={cName} size="sm" linkToProfile={false} />
                            </button>
                            {onSetPrimary && selected && (
                                <button
                                    type="button"
                                    aria-pressed={primary}
                                    aria-label={primary ? `${cName} — pagrindinis vadovas` : `Padaryti ${cName} pagrindiniu vadovu`}
                                    title={primary ? 'Pagrindinis vadovas' : 'Padaryti pagrindiniu'}
                                    onClick={() => onSetPrimary(c.id)}
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

// Visibility / hierarchy control. Branches by role (four-level hierarchy, ADR 0007):
//  • admin        — global; static "Mato visus".
//  • seniorManager— scoped to their subtree (assigned managers + those managers' workers); the
//    assignment is done on each MANAGER's row (adding this senior there), so here we show a static
//    explainer rather than an editable control. No whole-company toggle — a senior is never global.
//  • manager      — TWO controls: a scope toggle ("Tik sava komanda" vs "Visa įmonė" — what THIS
//    manager sees) AND senior-manager chips (which Vyr. vadovas oversee this manager's team).
//  • worker       — multi-select overseer chips (their team). The candidate pool is BROAD —
//    any active superior (manager, senior manager, or admin), not managers-only — so an existing
//    assignment to an admin/senior stays visible and editable instead of silently vanishing from
//    the picker. Star marks the primary (defaultManager, the approval/notification route);
//    teamManagerIds is the visibility key the rules read.
function ManagerControl({ user, overseerCandidates, managerCandidates, seniorCandidates, onToggleManager, onSetPrimary, onToggleScoped, onToggleSenior }) {
    const name = formatDisplayName(user.displayName) || user.email || '';
    if (user.role === 'admin') {
        return <span className="text-body italic text-ink-muted">Mato visus</span>;
    }
    if (user.role === 'seniorManager') {
        // Inverse view: assign managers to THIS senior right here. The membership lives on each
        // manager's doc (seniorManagerIds), so a toggle writes the MANAGER's doc, not the senior's
        // — the same write the manager's own row would make, from the other side.
        const myManagerIds = managerCandidates
            .filter((m) => effectiveSeniorIds(m).includes(user.id))
            .map((m) => m.id);
        return (
            <div className="space-y-2">
                <span className="block text-body italic text-ink-muted">Mato priskirtų vadovų komandas</span>
                <ChipMultiSelect
                    legend={`${name} pavaldūs vadovai`}
                    candidates={managerCandidates}
                    selectedIds={myManagerIds}
                    onToggle={(mid) => {
                        const m = managerCandidates.find((c) => c.id === mid);
                        if (m) onToggleSenior(m, user.id);
                    }}
                    emptyLabel="Nėra vadovų"
                />
            </div>
        );
    }
    if (user.role === 'manager') {
        const scoped = user.scopedManager === true;
        return (
            <div className="space-y-3">
                <div>
                    <span className="mb-1 block text-caption font-medium text-ink-muted">Šis vadovas mato</span>
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
                </div>
                <div>
                    <span className="mb-1 block text-caption font-medium text-ink-muted">Vyr. vadovai</span>
                    <ChipMultiSelect
                        legend={`${name} vyr. vadovai`}
                        candidates={seniorCandidates}
                        selectedIds={effectiveSeniorIds(user)}
                        onToggle={(sid) => onToggleSenior(user, sid)}
                        emptyLabel="Nėra vyr. vadovų"
                    />
                </div>
            </div>
        );
    }
    // worker
    return (
        <ChipMultiSelect
            legend={`${name} vadovai`}
            candidates={overseerCandidates}
            selectedIds={effectiveTeamIds(user)}
            onToggle={(mid) => onToggleManager(user, mid)}
            primaryId={user.defaultManager}
            onSetPrimary={(mid) => onSetPrimary(user, mid)}
            emptyLabel="Nėra galimų vadovų"
        />
    );
}

// Resolve an overseer's id to a display name via the prebuilt lookup. Returns null for an id that
// no longer matches any user (e.g. a deleted account) so the caller can drop it from the summary.
function overseerName(usersById, id) {
    const u = usersById[id];
    if (!u) return null;
    return formatDisplayName(u.displayName) || u.email || '—';
}

// Read-only one-line mirror of ManagerControl, shown on the COLLAPSED mobile card so a roster stays
// scannable without expanding every row. Editing still happens in the expanded section; this never
// writes. Branches by role exactly like ManagerControl so the summary always matches the editor.
function OverseerSummary({ user, usersById }) {
    const base = 'text-caption text-ink-muted';
    if (user.role === 'admin') return <p className={base}>Mato visus</p>;
    if (user.role === 'seniorManager') return <p className={base}>Mato priskirtų vadovų komandas</p>;
    if (user.role === 'manager') {
        const scoped = user.scopedManager === true;
        const seniors = effectiveSeniorIds(user).map((id) => overseerName(usersById, id)).filter(Boolean);
        return (
            <p className={base}>
                {scoped ? 'Mato tik savo komandą' : 'Mato visą įmonę'}
                {seniors.length > 0 && `  ·  Vyr. vadovai: ${seniors.join(', ')}`}
            </p>
        );
    }
    // worker — list assigned overseers, primary (starred) first; color is never the only signal (§5).
    const ids = effectiveTeamIds(user);
    if (ids.length === 0) return <p className={cn(base, 'italic')}>Nepriskirtas vadovas</p>;
    const primaryId = user.defaultManager;
    const names = [...ids]
        .sort((a, b) => (a === primaryId ? -1 : b === primaryId ? 1 : 0))
        .map((id) => ({ id, name: overseerName(usersById, id) }))
        .filter((x) => x.name);
    return (
        <p className={cn(base, 'flex flex-wrap items-center gap-x-1.5 gap-y-1')}>
            <span className="font-medium text-ink">Vadovai:</span>
            {names.map((n) => (
                <span key={n.id} className="inline-flex items-center gap-0.5">
                    {n.id === primaryId && <Star className="h-3 w-3 shrink-0 fill-current text-brand" aria-hidden="true" />}
                    {/* Standard small person chip (avatar + name) instead of a bare name. */}
                    <UserChip userId={n.id} name={n.name} size="sm" linkToProfile={false} />
                </span>
            ))}
        </p>
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

// Days a worker may go silent before the roster flags them — lets a manager tell a churned
// account from an active one. workStatus.lastUpdated is the worker's last timer action (set by
// startSession / updateUserWorkStatus), so the signal needs no extra query.
const STALE_AFTER_DAYS = 14;

// Staleness badge for an active worker who has not changed work status recently. Managers/admins,
// disabled, and test accounts are never flagged — they are not active field workers.
function LastActiveBadge({ user }) {
    if (user.role !== 'worker' || user.isDisabled || user.isTest) return null;
    const ts = user.workStatus?.lastUpdated;
    if (!ts) return null;
    const last = new Date(ts).getTime();
    if (!Number.isFinite(last)) return null;
    const days = Math.floor((Date.now() - last) / (1000 * 60 * 60 * 24));
    if (days < STALE_AFTER_DAYS) return null;
    return <StatusPill tone="pending" icon={Clock}>{`Neaktyvus ${days} d.`}</StatusPill>;
}

// How long a freshly-created worker reads as "new" on the roster — so a near-empty history is read
// as recency, not low engagement. Keyed on the user doc's createdAt (set at first login).
const NEW_FOR_DAYS = 14;

// "Naujas" badge for a recently-joined active worker. Same gating as the staleness badge (workers
// only, never disabled/test); the two cannot both show — a brand-new worker isn't stale yet.
function NewUserBadge({ user }) {
    if (user.role !== 'worker' || user.isDisabled || user.isTest) return null;
    const ts = user.createdAt;
    if (!ts) return null;
    const created = new Date(ts).getTime();
    if (!Number.isFinite(created)) return null;
    const days = Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24));
    if (days > NEW_FOR_DAYS) return null;
    return <StatusPill tone="info" icon={Sparkles}>Naujas</StatusPill>;
}

// Per-worker weekly hours baseline. Feeds the report's Planuota fallback so Skirtumas has a real
// denominator even when the worker never hand-drew a calendar plan (the root cause of the fake
// "+164h surplus"). Workers only — managers/admins have no quota. Committed on blur, clamped to a
// sane 0–168 h/week; an empty field clears the baseline (null).
function ExpectedHoursInput({ user, onCommit, hideLabel = false }) {
    const [val, setVal] = useState(
        user.weeklyExpectedHours === undefined || user.weeklyExpectedHours === null ? '' : String(user.weeklyExpectedHours)
    );
    useEffect(() => {
        setVal(user.weeklyExpectedHours === undefined || user.weeklyExpectedHours === null ? '' : String(user.weeklyExpectedHours));
    }, [user.weeklyExpectedHours]);
    if (user.role !== 'worker') return null;
    const name = formatDisplayName(user.displayName) || user.email || '';
    const commit = () => {
        const trimmed = val.trim();
        if (trimmed === '') {
            if (user.weeklyExpectedHours !== undefined && user.weeklyExpectedHours !== null) onCommit(user, null);
            return;
        }
        const n = Number(trimmed);
        if (!Number.isFinite(n)) { setVal(user.weeklyExpectedHours == null ? '' : String(user.weeklyExpectedHours)); return; }
        const clamped = Math.max(0, Math.min(168, Math.round(n)));
        setVal(String(clamped));
        if (clamped !== user.weeklyExpectedHours) onCommit(user, clamped);
    };
    const input = (
        <input
            type="number"
            min="0"
            max="168"
            step="1"
            inputMode="numeric"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onBlur={commit}
            placeholder="—"
            aria-label={`${name} savaitės norma valandomis`}
            className={cn(
                'min-h-touch rounded-input border border-line bg-surface-card px-3 py-2.5 text-body-lg text-ink focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                hideLabel ? 'w-20 text-center' : 'block w-full'
            )}
        />
    );
    // Compact (desktop "Norma" column): the column header is the label, so render the bare input.
    if (hideLabel) return input;
    return (
        <label className="block">
            <span className="mb-1 block text-caption font-medium text-ink-muted">Savaitės norma (val.)</span>
            {input}
        </label>
    );
}

function BlockButton({ user, isSelf, onRequest, fullWidth, iconOnly }) {
    const pending = isPendingUser(user);
    // The action only ever toggles isDisabled — nothing is deleted — so the enable side reads
    // "Patvirtinti" (pending) / "Atblokuoti" (blocked) and the disable side reads "Blokuoti",
    // not the misleading "Blokuoti / Ištrinti" with a trash icon.
    const label = user.isDisabled ? (pending ? 'Patvirtinti' : 'Atblokuoti') : 'Blokuoti';
    // Compact (desktop toolbar) form: a single 44px icon button. The glyph flips Ban <-> Check
    // with the state, so the state never rides on color alone (§5). The destructive "block"
    // side is filled red (dominant); the positive sides are filled brand / neutral.
    if (iconOnly) {
        return (
            <IconButton
                variant={user.isDisabled ? (pending ? 'primary' : 'default') : 'danger-solid'}
                icon={user.isDisabled ? Check : Ban}
                disabled={isSelf}
                label={label}
                onClick={() => onRequest(user)}
            />
        );
    }
    return (
        <Button
            variant={user.isDisabled ? (pending ? 'primary' : 'secondary') : 'danger'}
            size="md"
            icon={user.isDisabled ? Check : Ban}
            disabled={isSelf}
            fullWidth={fullWidth}
            onClick={() => onRequest(user)}
        >
            {label}
        </Button>
    );
}

// Permanent delete. Admin-only and kept visually subordinate to Block (the everyday action):
// a quiet danger-toned ghost button so the reversible toggle stays dominant over the
// irreversible one (§8). Self-deletion is disabled.
function DeleteButton({ user, isSelf, onRequest, fullWidth, iconOnly }) {
    // Compact (desktop toolbar) form: outline-red icon button. Kept visually subordinate to the
    // filled-red Block beside it, so the reversible toggle stays dominant over the irreversible
    // delete (§8).
    if (iconOnly) {
        return (
            <IconButton
                variant="danger"
                icon={Trash2}
                disabled={isSelf}
                label="Ištrinti"
                onClick={() => onRequest(user)}
            />
        );
    }
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

// Per-worker pay-rate entry point. Admin-only (firestore.rules gates the write — ADR 0012) and
// shown only for workers (the Vykdytojas, who finish tasks and see the earnings popup). The "on"
// state (a rate is set) is signalled by a check badge over the coins glyph, not by color alone (§5).
function PayRateButton({ user, onEdit, fullWidth, iconOnly }) {
    const has = hasPayRate(user.payRate);
    if (iconOnly) {
        return (
            <IconButton
                variant={has ? 'primary' : 'default'}
                aria-pressed={has}
                label={has ? 'Keisti įkainį' : 'Nustatyti įkainį'}
                onClick={() => onEdit(user)}
            >
                <span className="relative inline-flex">
                    <Coins className="h-5 w-5" aria-hidden="true" />
                    {has && (
                        <span className="absolute -right-1 -top-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-white">
                            <Check className="h-2.5 w-2.5 text-brand" strokeWidth={3} aria-hidden="true" />
                        </span>
                    )}
                </span>
            </IconButton>
        );
    }
    return (
        <Button
            variant={has ? 'primary' : 'secondary'}
            size="md"
            icon={Coins}
            fullWidth={fullWidth}
            onClick={() => onEdit(user)}
        >
            {has ? 'Įkainis ✓' : 'Nustatyti įkainį'}
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
                    // `wz-range` supplies the thumb: `appearance-none` strips the native handle in
                    // every engine, and `accent-color` is inert once it's gone — so without an
                    // explicit ::-webkit-slider-thumb / ::-moz-range-thumb (see index.css) the
                    // handle is invisible in Chrome, Safari AND Firefox.
                    'wz-range h-2 w-full cursor-pointer appearance-none rounded-full',
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
    const [tempColor, setTempColor] = useState({ r: 79, g: 70, b: 229 }); // Default brand indigo (#4F46E5)

    // Block/unblock confirmation (replaces window.confirm — §8)
    const [blockTarget, setBlockTarget] = useState(null);
    const [blocking, setBlocking] = useState(false);

    // Delete confirmation. Permanent removal of the user's Firestore record — admin-only and
    // separate from the reversible block toggle, so it never sits on the same button (§8).
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    // Pay-rate editor target (admin-only). Holds the user whose tiered rate is being edited.
    const [payRateUser, setPayRateUser] = useState(null);
    // Which mobile cards are expanded into their editing form. At rest a card is collapsed to a
    // scannable summary (identity + role + overseers); editing controls live behind a per-card
    // toggle so a long roster no longer scrolls forever (progressive disclosure). Desktop is a
    // dense table and stays fully inline (DESIGN_SYSTEM §9 dual density).
    const [expandedIds, setExpandedIds] = useState(() => new Set());
    const toggleExpanded = (id) =>
        setExpandedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
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

    // Assignment candidate pools. A WORKER may report to any active superior — manager, senior
    // manager, or admin (broad pool, restored after ADR 0006 narrowed it to managers-only and
    // silently hid every legacy admin/senior assignment). A SENIOR's inverse list, by contrast,
    // stays managers-only (only a manager reports up to a senior). Disabled accounts oversee nobody.
    const overseerCandidates = users.filter(
        (u) => (u.role === 'manager' || u.role === 'seniorManager' || u.role === 'admin') && !u.isDisabled
    );
    const managerCandidates = users.filter((u) => u.role === 'manager' && !u.isDisabled);
    const seniorCandidates = users.filter((u) => u.role === 'seniorManager' && !u.isDisabled);
    // Id → user lookup for the read-only overseer summary on collapsed mobile cards.
    const usersById = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);

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
        } : { r: 79, g: 70, b: 229 };
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

    // Toggle a senior manager (Vyr. vadovas) in/out of a MANAGER's overseer set. Writes the
    // manager's own doc (seniorManagerIds) — the security rules gate this field to admins, and the
    // Cloud Function folds it into the subtree's overseer closure so the senior sees the manager's
    // team (ADR 0007). Triggerable from either the manager's row or the senior's row (same write).
    const handleToggleSenior = async (managerUser, seniorId) => {
        setError('');
        const current = Array.isArray(managerUser.seniorManagerIds) ? managerUser.seniorManagerIds : [];
        const next = current.includes(seniorId)
            ? current.filter((id) => id !== seniorId)
            : [...current, seniorId];
        try {
            await updateDoc(doc(db, 'users', managerUser.id), {
                seniorManagerIds: next,
            });
        } catch (err) {
            console.error("Error updating senior managers:", err);
            setError('Nepavyko atnaujinti vyr. vadovų. Bandykite dar kartą.');
        }
    };

    // Persist a worker's tiered pay rate (or clear it with null). Returns the write promise so the
    // PayRateModal can await it and surface its own error/saving state. Admin-only — enforced by
    // firestore.rules (ADR 0012); the editor button is also admin-gated in the UI.
    const handleSavePayRate = (userId, payRate) =>
        updateDoc(doc(db, 'users', userId), { payRate });

    // Persist a worker's weekly hours baseline (or clear it with null). The report falls back to
    // this when the worker has no calendar plan for the span, so Skirtumas stops being garbage.
    const handleSetExpectedHours = async (user, hours) => {
        setError('');
        try {
            await updateDoc(doc(db, 'users', user.id), { weeklyExpectedHours: hours });
        } catch (err) {
            console.error("Error updating expected hours:", err);
            setError('Nepavyko išsaugoti savaitės normos. Bandykite dar kartą.');
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
                setError('Neturite teisių atlikti šį veiksmą.');
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
                setError('Neturite teisių atlikti šį veiksmą.');
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
                {users.map((user) => {
                    const expanded = expandedIds.has(user.id);
                    return (
                    <li
                        key={user.id}
                        className={cn(
                            'rounded-card border border-line bg-surface-card p-4 shadow-sm',
                            user.isDisabled && 'bg-surface-sunken/60 opacity-90'
                        )}
                        style={{ borderLeft: `4px solid ${user.color || WORKER_FALLBACK_COLOR}` }}
                    >
                        <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <UserChip
                                        userId={user.id}
                                        name={user.displayName || 'Be vardo'}
                                        size="md"
                                        block
                                        className="min-w-0 text-body font-semibold text-ink-strong"
                                    />
                                    <DisabledPill user={user} />
                                    <NewUserBadge user={user} />
                                    <LastActiveBadge user={user} />
                                </div>
                                <p className="truncate text-body text-ink-muted">{user.email}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <RoleBadge role={user.role} />
                                </div>
                                {/* Read-only overseer line so the roster stays scannable while collapsed. */}
                                <div className="mt-1.5">
                                    <OverseerSummary user={user} usersById={usersById} />
                                </div>
                            </div>
                            <ColorSwatch user={user} onEdit={startEditingColor} />
                        </div>

                        {/* Progressive disclosure: rare editing controls live behind this toggle so a
                            collapsed card is ~1/4 the old height (DESIGN_SYSTEM §9). */}
                        <button
                            type="button"
                            onClick={() => toggleExpanded(user.id)}
                            aria-expanded={expanded}
                            aria-controls={`user-edit-${user.id}`}
                            className="mt-3 inline-flex min-h-touch w-full items-center justify-center gap-2 rounded-control border border-line bg-surface-card px-3 text-body font-medium text-ink transition-colors hover:bg-surface-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                        >
                            <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                            {expanded ? 'Suskleisti' : 'Tvarkyti'}
                        </button>

                        {expanded && (
                            <div id={`user-edit-${user.id}`} className="mt-4 grid gap-3 border-t border-line pt-4">
                                <label className="block">
                                    <span className="mb-1 block text-caption font-medium text-ink-muted">Rolė</span>
                                    <RoleSelect user={user} onChange={handleRoleChange} />
                                </label>
                                <div>
                                    <span className="mb-1 block text-caption font-medium text-ink-muted">Vadovai</span>
                                    <ManagerControl
                                        user={user}
                                        overseerCandidates={overseerCandidates}
                                        managerCandidates={managerCandidates}
                                        seniorCandidates={seniorCandidates}
                                        onToggleManager={handleToggleManager}
                                        onSetPrimary={handleSetPrimary}
                                        onToggleScoped={handleToggleScoped}
                                        onToggleSenior={handleToggleSenior}
                                    />
                                </div>
                                <ExpectedHoursInput user={user} onCommit={handleSetExpectedHours} />
                                {isAdmin && user.role === 'worker' && (
                                    <PayRateButton user={user} onEdit={setPayRateUser} fullWidth />
                                )}
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
                        )}
                    </li>
                    );
                })}
            </ul>

            {/* Desktop / wide: denser table is allowed (§9). Each control owns ONE column, so a row
                is a single line tall instead of a vertical stack: the role SELECT lives in the Rolė
                column (no separate read-only badge to duplicate it), the weekly quota gets a compact
                Norma column, and Veiksmai holds only the 44px icon toolbar. */}
            <div className="hidden overflow-x-auto md:block">
                <table className="min-w-full divide-y divide-line">
                    <thead className="bg-surface-sunken">
                        <tr>
                            {['Vartotojas', 'Rolė', 'Spalva', 'Vadovai', 'Norma', 'Veiksmai'].map((h) => (
                                <th
                                    key={h}
                                    className="px-4 py-3 text-left text-caption font-medium uppercase tracking-wider text-ink-muted"
                                >
                                    {h}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-line bg-surface-card">
                        {users.map((user) => (
                            <tr key={user.id} className={user.isDisabled ? 'bg-surface-sunken/60' : ''}>
                                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                                    <div className="flex flex-wrap items-center gap-2 text-body font-medium text-ink-strong">
                                        <UserChip
                                            userId={user.id}
                                            name={user.displayName || 'Be vardo'}
                                            size="md"
                                            block
                                        />
                                        <DisabledPill user={user} />
                                        <NewUserBadge user={user} />
                                        <LastActiveBadge user={user} />
                                    </div>
                                    <div className="text-body text-ink-muted">{user.email}</div>
                                </td>
                                <td className="px-4 py-2.5 align-top">
                                    <div className="w-40">
                                        <RoleSelect user={user} onChange={handleRoleChange} />
                                    </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                                    <ColorSwatch user={user} onEdit={startEditingColor} />
                                </td>
                                <td className="px-4 py-2.5 align-top">
                                    <ManagerControl
                                        user={user}
                                        overseerCandidates={overseerCandidates}
                                        managerCandidates={managerCandidates}
                                        seniorCandidates={seniorCandidates}
                                        onToggleManager={handleToggleManager}
                                        onSetPrimary={handleSetPrimary}
                                        onToggleScoped={handleToggleScoped}
                                        onToggleSenior={handleToggleSenior}
                                    />
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                                    <ExpectedHoursInput user={user} onCommit={handleSetExpectedHours} hideLabel />
                                </td>
                                <td className="whitespace-nowrap px-4 py-2.5 align-top">
                                    <div className="flex items-center gap-1.5">
                                        <BlockButton
                                            user={user}
                                            isSelf={user.id === currentUser?.uid}
                                            onRequest={requestBlock}
                                            iconOnly
                                        />
                                        {isAdmin && user.role === 'worker' && (
                                            <PayRateButton user={user} onEdit={setPayRateUser} iconOnly />
                                        )}
                                        {isAdmin && (
                                            <DeleteButton
                                                user={user}
                                                isSelf={user.id === currentUser?.uid}
                                                onRequest={requestDelete}
                                                iconOnly
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

            {/* Pay-rate editor (admin-only) — tiered NET hourly rates + derived gross (ADR 0012) */}
            <PayRateModal
                open={!!payRateUser}
                user={payRateUser}
                onClose={() => setPayRateUser(null)}
                onSave={(payRate) => handleSavePayRate(payRateUser.id, payRate)}
            />

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
