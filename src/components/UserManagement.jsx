import { useState, useEffect, useMemo, Fragment } from 'react';
import { db } from '../firebase';
import { collection, onSnapshot, doc, updateDoc, getDoc, deleteDoc } from 'firebase/firestore';
import { ShieldAlert, Check, Sliders, Trash2, Clock, Ban, Star, Users, Globe, Sparkles, Coins, ChevronDown, Search, X, SearchX } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { pauseTask } from '../utils/taskActions';
import { logError } from '../utils/errorLog';
import { formatDisplayName } from '../utils/formatters';
import { hasPayRate } from '../utils/payRate';
import { getContrastingTextColor } from '../utils/priority';
import { WORKER_FALLBACK_COLOR } from '../utils/colors';
import { cn } from '../utils/cn';
import { MAX_BACKDATE_DAYS } from '../utils/timeUtils';
import { scoreFields, tokenizeQuery } from '../utils/taskSearch';
import UserChip from './UserChip';
import Card from './ui/Card';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import StatusPill from './ui/StatusPill';
import Modal from './ui/Modal';
import Select from './ui/Select';
import ConfirmDialog from './ui/ConfirmDialog';
import EmptyState from './ui/EmptyState';
import PayRateModal from './PayRateModal';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';

// Role display metadata. Tone avoids the reserved session blue (call) — admin reads as the
// brand accent, manager neutral, worker green; the text label always names the role so color
// is never the sole signal (§5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    seniorManager: { label: 'Vyr. koordinatorius', tone: 'neutral' },
    manager: { label: 'Koordinatorius', tone: 'neutral' },
    worker: { label: 'Meistras', tone: 'running' },
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
                { value: 'worker', label: 'Meistras' },
                { value: 'manager', label: 'Koordinatorius' },
                { value: 'seniorManager', label: 'Vyr. koordinatorius' },
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
                                className="inline-flex min-h-touch items-center gap-1.5 py-1 pl-2 pr-2.5 text-body text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                            >
                                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-brand" aria-hidden="true" />}
                                {/* Standard person rendering: avatar + name (UserChip), rendered `bare`
                                    (no own pill) + non-interactive (linkToProfile=false) so it nests
                                    cleanly inside this toggle, which is itself the pill + tap target. */}
                                <UserChip userId={c.id} name={cName} bare linkToProfile={false} />
                            </button>
                            {onSetPrimary && selected && (
                                <button
                                    type="button"
                                    aria-pressed={primary}
                                    aria-label={primary ? `${cName} — pagrindinis koordinatorius` : `Padaryti ${cName} pagrindiniu koordinatoriumi`}
                                    title={primary ? 'Pagrindinis koordinatorius' : 'Padaryti pagrindiniu'}
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
                <span className="block text-body italic text-ink-muted">Mato priskirtų koordinatorių komandas</span>
                <ChipMultiSelect
                    legend={`${name} pavaldūs koordinatoriai`}
                    candidates={managerCandidates}
                    selectedIds={myManagerIds}
                    onToggle={(mid) => {
                        const m = managerCandidates.find((c) => c.id === mid);
                        if (m) onToggleSenior(m, user.id);
                    }}
                    emptyLabel="Nėra koordinatorių"
                />
            </div>
        );
    }
    if (user.role === 'manager') {
        const scoped = user.scopedManager === true;
        return (
            <div className="space-y-3">
                <div>
                    <span className="mb-1 block text-caption font-medium text-ink-muted">Šis koordinatorius mato</span>
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
                    <span className="mb-1 block text-caption font-medium text-ink-muted">Vyr. koordinatoriai</span>
                    <ChipMultiSelect
                        legend={`${name} vyr. koordinatoriai`}
                        candidates={seniorCandidates}
                        selectedIds={effectiveSeniorIds(user)}
                        onToggle={(sid) => onToggleSenior(user, sid)}
                        emptyLabel="Nėra vyr. koordinatorių"
                    />
                </div>
            </div>
        );
    }
    // worker
    return (
        <ChipMultiSelect
            legend={`${name} koordinatoriai`}
            candidates={overseerCandidates}
            selectedIds={effectiveTeamIds(user)}
            onToggle={(mid) => onToggleManager(user, mid)}
            primaryId={user.defaultManager}
            onSetPrimary={(mid) => onSetPrimary(user, mid)}
            emptyLabel="Nėra galimų koordinatorių"
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
    if (user.role === 'seniorManager') return <p className={base}>Mato priskirtų koordinatorių komandas</p>;
    if (user.role === 'manager') {
        const scoped = user.scopedManager === true;
        const seniors = effectiveSeniorIds(user).map((id) => overseerName(usersById, id)).filter(Boolean);
        return (
            <p className={base}>
                {scoped ? 'Mato tik savo komandą' : 'Mato visą įmonę'}
                {seniors.length > 0 && `  ·  Vyr. koordinatoriai: ${seniors.join(', ')}`}
            </p>
        );
    }
    // worker — list assigned overseers, primary (starred) first; color is never the only signal (§5).
    const ids = effectiveTeamIds(user);
    if (ids.length === 0) return <p className={cn(base, 'italic')}>Nepriskirtas koordinatorius</p>;
    const primaryId = user.defaultManager;
    const names = [...ids]
        .sort((a, b) => (a === primaryId ? -1 : b === primaryId ? 1 : 0))
        .map((id) => ({ id, name: overseerName(usersById, id) }))
        .filter((x) => x.name);
    return (
        <p className={cn(base, 'flex flex-wrap items-center gap-x-1.5 gap-y-1')}>
            <span className="font-medium text-ink">Koordinatoriai:</span>
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
// only, never disabled/test); the two cannot both show — a brand-new worker isn't stale yet. The
// recency test itself lives in `isNewUser` so the badge and the default roster sort agree on it.
function NewUserBadge({ user }) {
    return isNewUser(user) ? <StatusPill tone="info" icon={Sparkles}>Naujas</StatusPill> : null;
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
            aria-label={`${name} savaitės tikslas valandomis`}
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
            <span className="mb-1 block text-caption font-medium text-ink-muted">Savaitės tikslas (val.)</span>
            {input}
        </label>
    );
}

// Per-user switch granting approval-free backdated time-logging. A switch-role button (the whole
// row is the ≥44px target; the knob position AND the text both convey state, so colour is never
// the sole signal) — admin-only to flip, enforced by firestore.rules. Available for ANY role: the
// founder's model is a special mark layered on top of the role, not a worker-only setting.
function BackdateToggle({ user, onToggle }) {
    const on = user.canBackdateTime === true;
    return (
        <button
            type="button"
            role="switch"
            aria-checked={on}
            onClick={() => onToggle(user)}
            className={cn(
                'flex w-full items-center justify-between gap-3 rounded-control border p-3 text-left min-h-touch',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1',
                on ? 'border-brand bg-brand/5' : 'border-line bg-surface-card hover:bg-surface-sunken/60'
            )}
        >
            <span>
                <span className="block text-body font-medium text-ink-strong">Atbulinis laiko įrašymas</span>
                <span className="mt-0.5 block text-caption text-ink-muted">
                    Pats įrašo praleistą veiklos laiką iki {MAX_BACKDATE_DAYS} d. atgal — be patvirtinimo;
                    administratoriai gauna pranešimą.
                </span>
            </span>
            <span
                className={cn(
                    'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
                    on ? 'bg-brand' : 'bg-line'
                )}
                aria-hidden="true"
            >
                <span
                    className={cn(
                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform',
                        on ? 'translate-x-6' : 'translate-x-1'
                    )}
                />
            </span>
        </button>
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

// ── Roster triage: search · filter · sort ───────────────────────────────────────────────────
// Pure, client-side over the already-loaded users array — no new query, no rules change. A long
// roster was a bare document-order map; triage now floats what needs attention (pending approvals,
// brand-new joiners) to the top, with a fuzzy name/email search and role/state quick filters.

// Quick-filter chips. `match` is a pure predicate over a user row, so the chip set is the single
// source of truth for both the buttons and the filtering. 'all' is the no-op default.
const ROSTER_FILTERS = [
    { id: 'all', label: 'Visi', match: () => true },
    { id: 'workers', label: 'Meistrai', match: (u) => u.role === 'worker' },
    { id: 'managers', label: 'Koordinatoriai', match: (u) => u.role === 'manager' || u.role === 'seniorManager' || u.role === 'admin' },
    { id: 'pending', label: 'Laukia', match: (u) => isPendingUser(u) },
    { id: 'blocked', label: 'Užblokuoti', match: (u) => u.isDisabled && !isPendingUser(u) },
];

// Default-sort priority band (lower sorts first). Pending approvals are the manager's most urgent
// triage, then brand-new joiners (same window the "Naujas" badge uses); everyone else keeps the
// roster's incoming (document) order via a stable sort. Disabled-but-not-pending sinks to the
// bottom so blocked accounts don't clutter the live roster.
function rosterSortRank(user) {
    if (isPendingUser(user)) return 0;
    if (isNewUser(user)) return 1;
    if (user.isDisabled) return 3; // blocked (non-pending) — least relevant day-to-day
    return 2;
}

// Whether a worker still reads as a recent joiner — shared by the "Naujas" badge and the default
// sort so the two agree on what "new" means (createdAt within NEW_FOR_DAYS, active workers only).
function isNewUser(user) {
    if (user.role !== 'worker' || user.isDisabled || user.isTest) return false;
    const ts = user.createdAt;
    if (!ts) return false;
    const created = new Date(ts).getTime();
    if (!Number.isFinite(created)) return false;
    return Math.floor((Date.now() - created) / (1000 * 60 * 60 * 24)) <= NEW_FOR_DAYS;
}

// Searchable identity of a roster row — the two things an admin actually types: display name and
// email. Weighted so a name hit outranks an email hit (people search by who, not by address).
function getUserMatchFields(user) {
    return [
        { text: user.displayName, weight: 1.0 },
        { text: user.email, weight: 0.8 },
    ];
}

/**
 * filterSortUsers — the pure triage pipeline behind the roster (exported for unit tests).
 * 1) keep only rows matching the active quick filter, 2) keep only rows the search query ranks
 * (diacritic-folding, typo-tolerant — reuses the shared task-search core over name + email),
 * 3) sort: with a query, by descending search relevance; without one, by the triage band
 * (pending → new → rest → blocked), stable within a band so document order is the tie-break.
 *
 * @param {object[]} users
 * @param {string} query - raw search input.
 * @param {string} filterId - one of ROSTER_FILTERS ids.
 * @returns {object[]}
 */
// eslint-disable-next-line react-refresh/only-export-components -- pure helper exported for unit tests; co-located with the roster it serves.
export function filterSortUsers(users, query, filterId) {
    const filter = ROSTER_FILTERS.find((f) => f.id === filterId) || ROSTER_FILTERS[0];
    const tokens = tokenizeQuery(query);
    const searching = tokens.length > 0;

    const rows = [];
    for (let i = 0; i < users.length; i += 1) {
        const user = users[i];
        if (!filter.match(user)) continue;
        const score = searching ? scoreFields(getUserMatchFields(user), tokens) : 0;
        if (searching && score <= 0) continue; // AND search — a non-matching row drops out
        rows.push({ user, score, i });
    }

    rows.sort((a, b) => {
        if (searching) return (b.score - a.score) || (a.i - b.i); // relevance, stable on ties
        const rank = rosterSortRank(a.user) - rosterSortRank(b.user);
        return rank || (a.i - b.i); // triage band, stable within a band
    });
    return rows.map((r) => r.user);
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

    // Roster triage state — a fuzzy name/email search and a role/state quick filter, both purely
    // client-side over the loaded users array. The displayed list runs through `filterSortUsers`.
    const [search, setSearch] = useState('');
    const [roleFilter, setRoleFilter] = useState('all');

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

    // The triaged roster actually rendered: quick-filtered, search-ranked, default-sorted. Recomputes
    // only when the roster, the query, or the active filter changes (cheap — tens-to-low-hundreds of
    // rows). Both the mobile cards and the desktop table map over this single derived list.
    const visibleUsers = useMemo(
        () => filterSortUsers(users, search, roleFilter),
        [users, search, roleFilter]
    );
    // Per-chip counts so a filter shows how many rows it holds before you commit to it. Computed off
    // the unfiltered roster (counts are absolute, independent of the active chip or the search).
    const filterCounts = useMemo(() => {
        const counts = {};
        for (const f of ROSTER_FILTERS) counts[f.id] = 0;
        for (const u of users) {
            for (const f of ROSTER_FILTERS) if (f.match(u)) counts[f.id] += 1;
        }
        return counts;
    }, [users]);

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
            setError('Nepavyko atnaujinti koordinatorių. Bandykite dar kartą.');
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
            setError('Nepavyko nustatyti pagrindinio koordinatoriaus. Bandykite dar kartą.');
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
            setError('Nepavyko atnaujinti koordinatoriaus prieigos. Bandykite dar kartą.');
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
            setError('Nepavyko atnaujinti vyr. koordinatorių. Bandykite dar kartą.');
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
            setError('Nepavyko išsaugoti savaitės tikslo. Bandykite dar kartą.');
        }
    };

    // Grant/revoke approval-free backdated time-logging for one user. Admin-only — enforced by
    // firestore.rules (the canBackdateTime pin); the toggle is also behind the admin-gated roster.
    const handleToggleBackdate = async (user) => {
        setError('');
        try {
            await updateDoc(doc(db, 'users', user.id), {
                canBackdateTime: !(user.canBackdateTime === true),
            });
        } catch (err) {
            console.error("Error updating backdate permission:", err);
            setError('Nepavyko atnaujinti atbulinio laiko teisės. Bandykite dar kartą.');
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

            {/* Roster triage toolbar — sticky so search + filters stay reachable while a long roster
                scrolls. Search ranks name + email (diacritic-folding, typo-tolerant); the chips quick-
                filter by role/state. Both are purely client-side over the loaded list. */}
            <div className="sticky top-0 z-10 space-y-3 border-b border-line bg-surface-card/95 p-3 backdrop-blur supports-[backdrop-filter]:bg-surface-card/80">
                <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
                    <input
                        type="search"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Ieškoti pagal vardą ar el. paštą…"
                        aria-label="Ieškoti vartotojų"
                        className="min-h-touch w-full rounded-input border border-line bg-surface-card py-2.5 pl-9 pr-10 text-body-lg text-ink placeholder:text-ink-muted focus:border-brand focus:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                    />
                    {search && (
                        <button
                            type="button"
                            onClick={() => setSearch('')}
                            aria-label="Išvalyti paiešką"
                            className="absolute right-1.5 top-1/2 inline-flex min-h-touch min-w-touch -translate-y-1/2 items-center justify-center rounded-full text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filtruoti vartotojus">
                    {ROSTER_FILTERS.map((f) => {
                        const active = roleFilter === f.id;
                        return (
                            <button
                                key={f.id}
                                type="button"
                                aria-pressed={active}
                                onClick={() => setRoleFilter(f.id)}
                                className={cn(
                                    'inline-flex min-h-touch items-center gap-1.5 rounded-full border px-3 text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                    active ? 'border-brand bg-brand text-white' : 'border-line bg-surface-card text-ink hover:bg-surface-sunken/60'
                                )}
                            >
                                {f.label}
                                <span className={cn('text-caption tabular-nums', active ? 'text-white/80' : 'text-ink-muted')}>
                                    {filterCounts[f.id]}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            {/* Empty triage result — search/filter matched nothing. Shown once for both layouts so a
                blank roster always explains itself and offers the way back. */}
            {users.length > 0 && visibleUsers.length === 0 && (
                <EmptyState
                    icon={SearchX}
                    title="Nieko nerasta"
                    description="Pagal pasirinktą filtrą ar paiešką vartotojų nėra."
                    action={
                        <Button
                            variant="secondary"
                            onClick={() => { setSearch(''); setRoleFilter('all'); }}
                        >
                            Išvalyti filtrus
                        </Button>
                    }
                />
            )}

            {/* Mobile / touch: one distinct card per user — laid on a sunken backdrop with gaps,
                border, shadow and a left accent in the user's own color so each user reads as a
                separate card, not a divider-separated row (never a horizontal table — §9). */}
            <ul className={cn('space-y-3 bg-surface-sunken/40 p-3 md:hidden', visibleUsers.length === 0 && 'hidden')}>
                {visibleUsers.map((user) => {
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
                                        className="min-w-0"
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
                                    <span className="mb-1 block text-caption font-medium text-ink-muted">Koordinatoriai</span>
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
                                {isAdmin && (
                                    <BackdateToggle user={user} onToggle={handleToggleBackdate} />
                                )}
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

            {/* Desktop / wide: compact single-line rows with progressive disclosure — Vadovai editing
                lives behind a per-row chevron so the default roster is scannable at a glance. */}
            <div className={cn('hidden overflow-x-auto md:block', visibleUsers.length === 0 && 'md:hidden')}>
                <table className="min-w-full divide-y divide-line">
                    <thead className="bg-surface-sunken">
                        <tr>
                            {['Vartotojas', 'Rolė', 'Spalva', 'Koordinatoriai', 'Tikslas', 'Veiksmai'].map((h) => (
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
                        {visibleUsers.map((user) => {
                            const expanded = expandedIds.has(user.id);
                            return (
                                <Fragment key={user.id}>
                                    <tr
                                        className={cn(
                                            'transition-colors',
                                            user.isDisabled ? 'bg-surface-sunken/60' : '',
                                            expanded && 'border-b-0'
                                        )}
                                        style={{ borderLeft: `3px solid ${user.color || WORKER_FALLBACK_COLOR}` }}
                                    >
                                        {/* Vartotojas */}
                                        <td className="whitespace-nowrap px-4 py-2.5 align-middle">
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
                                        {/* Rolė */}
                                        <td className="px-4 py-2.5 align-middle">
                                            <div className="w-40">
                                                <RoleSelect user={user} onChange={handleRoleChange} />
                                            </div>
                                        </td>
                                        {/* Spalva */}
                                        <td className="whitespace-nowrap px-4 py-2.5 align-middle">
                                            <ColorSwatch user={user} onEdit={startEditingColor} />
                                        </td>
                                        {/* Vadovai — read-only summary collapsed, full editor expanded */}
                                        <td className="px-4 py-2.5 align-middle">
                                            {expanded ? (
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
                                            ) : (
                                                <OverseerSummary user={user} usersById={usersById} />
                                            )}
                                        </td>
                                        {/* Norma */}
                                        <td className="whitespace-nowrap px-4 py-2.5 align-middle">
                                            <ExpectedHoursInput user={user} onCommit={handleSetExpectedHours} hideLabel />
                                        </td>
                                        {/* Veiksmai + expand toggle */}
                                        <td className="whitespace-nowrap px-4 py-2.5 align-middle">
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
                                                <button
                                                    type="button"
                                                    onClick={() => toggleExpanded(user.id)}
                                                    aria-expanded={expanded}
                                                    aria-label={expanded ? 'Suskleisti' : 'Tvarkyti koordinatorius'}
                                                    className="inline-flex h-11 w-11 items-center justify-center rounded-control border border-line text-ink-muted transition-colors hover:bg-surface-sunken/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                                                >
                                                    <ChevronDown className={cn('h-4 w-4 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                    {/* Expanded: advanced per-user flags behind the chevron (keeps the
                                        default row scannable). Admin-only — the flag is admin-pinned. */}
                                    {expanded && isAdmin && (
                                        <tr className="bg-surface-sunken/30">
                                            <td colSpan={6} className="px-4 pb-3 pt-1">
                                                <div className="max-w-xl">
                                                    <BackdateToggle user={user} onToggle={handleToggleBackdate} />
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                </Fragment>
                            );
                        })}
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
