import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, LogOut, Bell, ChevronRight, Loader2, Download, Sun, Moon, Monitor, BarChart3, Briefcase, Home, Zap, Plus, X } from 'lucide-react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc } from 'firebase/firestore';
import { storage, db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useNavigation } from '../context/NavigationContext';
import { useAchievements } from '../hooks/useAchievements';
import { useWorkerStats } from '../hooks/useWorkerStats';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { compressImage } from '../utils/imageUtils';
import { logError } from '../utils/errorLog';
import { cn } from '../utils/cn';
import { normalizeWorkLocation } from '../utils/workLocation';
import { normalizeUserTemplates, MAX_USER_TEMPLATES, MAX_TEMPLATE_LABEL } from '../utils/quickWorkTemplates';
import { BADGE_ICONS, BADGE_CATALOG, tierKey } from '../utils/badgeCatalog';
import { formatStatValue } from '../utils/workerStats';
import { rangeForPreset } from '../utils/statsPeriods';
import BadgeDetailModal from '../components/BadgeDetailModal';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import IconButton from '../components/ui/IconButton';
import StatusPill from '../components/ui/StatusPill';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Avatar from '../components/ui/Avatar';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import { Spinner } from '../components/ui/Loading';
import InstallInstructions from '../components/InstallInstructions';
import { ROLE_GLYPHS } from '../components/icons/roleInsigniaMap';

// Role presentation — pair color with text so role is never color-only (DESIGN_SYSTEM §5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    seniorManager: { label: 'Vyr. vadovas', tone: 'info' },
    manager: { label: 'Vadovas', tone: 'info' },
    worker: { label: 'Vykdytojas', tone: 'neutral' },
};

// Theme choices (ADR 0008). 'system' follows the OS preference and is the default; each option
// pairs an icon with a label so the active state is never color-only (DESIGN_SYSTEM §5).
const THEME_OPTIONS = [
    { value: 'light', label: 'Šviesi', Icon: Sun },
    { value: 'dark', label: 'Tamsi', Icon: Moon },
    { value: 'system', label: 'Sistemos', Icon: Monitor },
];

// Default work-location for NEW calendar entries (mirrors the stored boolean in workLocation.js).
// Picking one here pre-fills the planner's toggle so the user stops flipping every entry by hand;
// any single entry can still be switched in the planner. Each option pairs an icon with its label
// so the active choice is never color-only (DESIGN_SYSTEM §5).
const WORK_LOCATION_OPTIONS = [
    { value: 'office', label: 'Veikla', Icon: Briefcase },
    { value: 'home', label: 'Veikla namuose', Icon: Home },
];

// A user photo stays small; cap the long edge and re-encode so the upload is light on a
// field worker's mobile connection. Lives at a fixed per-user path so a new photo overwrites
// the old one (no orphaned avatar files accumulate, unlike multi-file task attachments).
const AVATAR_MAX_EDGE = 512;

// Headline self-metrics shown on the owner's profile: three plain, motivating numbers drawn from
// the SAME compute engine the manager panel uses, but scoped to the owner's own data. Deliberately
// a SHORT list — this is self-insight, not the manager's full analytics. `kind` maps to
// formatStatValue; `key` indexes into the computeWorkerStats result. (No peer comparison, no delta.)
const SELF_METRICS = [
    { key: 'onTimePct', label: 'Punktualus startas', kind: 'pct' },
    { key: 'approvalPct', label: 'Patvirtinta vadovo', kind: 'pct' },
    { key: 'onEstimatePct', label: 'Telpa į planą', kind: 'pct' },
];

// The self-metrics card looks back over a rolling window long enough to gather a stable read for a
// field worker who does not work every day. A quarter balances "recent" against "enough samples".
const SELF_METRICS_PERIOD = 'quarter';

// BadgeProgress — the slim "progress to next tier" bar under a badge tile on the OWNER's profile.
// It reads the running count against the next catalog threshold and shows BOTH a bar and a
// "count / target" caption, so the progress is never conveyed by the bar's width alone (a screen
// reader and a colour-blind user both get the number; DESIGN_SYSTEM §5). A maxed-out badge shows a
// calm "Maks." instead of a target it can never exceed. Renders nothing until counters have loaded.
function BadgeProgress({ badge, progress }) {
    if (!progress) return null;
    const { count, nextThreshold, nextTier, atMax } = progress;

    if (atMax) {
        return (
            <p className="mt-1.5 text-center text-caption font-medium text-feedback-success-text">
                Maks.
            </p>
        );
    }

    // Progress WITHIN the current-to-next tier band: how far between the tier just earned and the
    // next threshold. A brand-new badge (count 0) reads as an honest, near-empty bar.
    const span = Math.max(1, nextThreshold - progress.prevThreshold);
    const within = Math.min(span, Math.max(0, count - progress.prevThreshold));
    const pct = Math.round((within / span) * 100);

    return (
        <div className="mt-1.5">
            <div
                role="progressbar"
                aria-label={`${badge.name}: pažanga iki kitos pakopos`}
                aria-valuemin={0}
                aria-valuemax={nextThreshold}
                aria-valuenow={Math.min(count, nextThreshold)}
                className="h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
            >
                <div className="h-full rounded-full bg-brand transition-all duration-base" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-center text-caption tabular-nums text-ink-muted">
                {count} / {nextThreshold}
                <span className="sr-only"> {badge.unit}, {nextTier} pakopa</span>
            </p>
        </div>
    );
}

export default function ProfilePage() {
    const { currentUser, userData, userRole, logout } = useAuth();
    const { preference: themePreference, setPreference: setThemePreference } = useTheme();
    const { goToPreviousTab } = useNavigation();
    const { achievements, progress } = useAchievements(currentUser?.uid);
    const { canPromptNative, isIOS, isStandalone, promptInstall } = useInstallPrompt();

    // Self-insight metrics: the same compute engine the manager panel uses, but the viewer IS the
    // target (strictly own data — owner-scoped reads, no peer comparison). `useWorkerStats` keys its
    // queries off the viewer's team scope and then filters to `userId`; with viewer == owner that
    // collapses to the owner's own sessions/tasks. A fixed rolling window (no picker) keeps this a
    // calm headline, not the manager's full period-over-period surface.
    const selfPeriod = rangeForPreset(SELF_METRICS_PERIOD);
    const { loading: statsLoading, error: statsError, current: selfStats } = useWorkerStats({
        userId: currentUser?.uid,
        viewerData: userData,
        viewerUid: currentUser?.uid,
        viewerRole: userRole,
        expectedWeeklyHours: Number(userData?.weeklyExpectedHours) || 0,
        period: selfPeriod ? { key: SELF_METRICS_PERIOD, ...selfPeriod } : null,
        enabled: !!currentUser?.uid,
    });

    // Enough data to be worth showing? Each headline metric is null until the worker has the
    // underlying samples (a planned start to compare, a manager sign-off, an estimate to land
    // within). If every one is still null, show a calm "keep working" note instead of three dashes.
    const hasSelfMetrics = !!selfStats && SELF_METRICS.some((m) => selfStats[m.key] != null);

    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [photoError, setPhotoError] = useState('');
    const [savingNotif, setSavingNotif] = useState(false);
    const [notifError, setNotifError] = useState('');
    const [savingTheme, setSavingTheme] = useState(false);
    const [themeError, setThemeError] = useState('');
    const [savingWorkLoc, setSavingWorkLoc] = useState(false);
    const [workLocError, setWorkLocError] = useState('');
    const [confirmLogout, setConfirmLogout] = useState(false);
    const [showInstall, setShowInstall] = useState(false);
    const [selectedBadge, setSelectedBadge] = useState(null);

    // Personal quick-work templates (users/{uid}.quickWorkTemplates) — the worker's own one-tap
    // categories appended to the built-ins in the finish modal. Mirrored locally for instant
    // add/remove; the real-time user-doc listener re-seeds it (incl. cross-device edits).
    const [quickTemplates, setQuickTemplates] = useState(() => normalizeUserTemplates(userData?.quickWorkTemplates));
    const [newTemplate, setNewTemplate] = useState('');
    const [savingTemplates, setSavingTemplates] = useState(false);
    const [templatesError, setTemplatesError] = useState('');

    // The owner's profile shows the FULL ladder: every catalog badge merged with the tier the
    // user has actually earned (0 = not yet). Sorted earned-first, highest tier down, then the
    // not-yet-earned ones last — so the shelf reads brightest at the top. Unlike a peer's
    // profile, an empty/partial ladder here is a motivating map of what is still ahead, not a
    // deficit (guardrail W4 is relaxed for the owner only).
    const earnedByKey = new Map(achievements.map((a) => [a.key, a]));
    const badgeLadder = BADGE_CATALOG
        .map((def) => {
            const earned = earnedByKey.get(def.key);
            return { ...def, tier: earned?.tier || 0, earnedAt: earned?.earnedAt || '' };
        })
        .sort((a, b) => (b.tier - a.tier) || String(b.earnedAt).localeCompare(String(a.earnedAt)));

    // The upload/save writes SHOULD complete even if the user navigates away mid-flight (the
    // photo still saves); we only guard the local UI state so we never setState post-unmount.
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

    const photoURL = userData?.photoURL || currentUser?.photoURL || null;
    const fullName = userData?.displayName || currentUser?.displayName || '';
    const email = currentUser?.email || userData?.email || '';
    const role = ROLE_META[userRole] || ROLE_META.worker;
    // Default ON: a missing field means notifications were never turned off.
    const notificationsEnabled = userData?.notificationsEnabled !== false;

    const memberSince = userData?.createdAt
        ? new Date(userData.createdAt).toLocaleDateString('lt-LT', { year: 'numeric', month: 'long' })
        : null;

    const handlePickPhoto = () => {
        setPhotoError('');
        fileInputRef.current?.click();
    };

    const handlePhotoSelected = async (e) => {
        const file = e.target.files?.[0];
        // Reset so re-selecting the SAME file still fires onChange.
        e.target.value = '';
        if (!file) return;
        if (!file.type.match(/image.*/)) {
            setPhotoError('Pasirinkite paveikslėlį.');
            return;
        }

        setPhotoError('');
        setUploading(true);
        try {
            const compressed = await compressImage(file, AVATAR_MAX_EDGE, AVATAR_MAX_EDGE, 0.85);
            const storageRef = ref(storage, `avatars/${currentUser.uid}/avatar.jpg`);
            await uploadBytes(storageRef, compressed, { contentType: 'image/jpeg' });
            const url = await getDownloadURL(storageRef);
            // Write to the user doc — the real-time listener propagates the new photo to the
            // header avatar and every team view that reads this user's photoURL.
            await updateDoc(doc(db, 'users', currentUser.uid), { photoURL: url });
        } catch (err) {
            logError(err, { source: 'profile:photoUpload' });
            if (mountedRef.current) setPhotoError('Nepavyko įkelti nuotraukos. Bandykite dar kartą.');
        } finally {
            if (mountedRef.current) setUploading(false);
        }
    };

    // Apply the theme instantly (local + DOM via ThemeContext), then persist for cross-device
    // sync. The local apply is optimistic and independent of the write, so the UI flips even
    // when offline or signed out; a failed write only surfaces a calm note — the theme still
    // holds locally. Mirrors the notifications-toggle write pattern.
    const handleThemeChange = async (next) => {
        if (next === themePreference) return;
        setThemeError('');
        setThemePreference(next);
        if (!currentUser) return; // logged-out preview: localStorage already holds the choice
        setSavingTheme(true);
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), { themePreference: next });
        } catch (err) {
            logError(err, { source: 'profile:themeToggle' });
            if (mountedRef.current) setThemeError('Nepavyko išsaugoti nustatymo.');
        } finally {
            if (mountedRef.current) setSavingTheme(false);
        }
    };

    const currentWorkLocation = normalizeWorkLocation(userData?.defaultWorkLocation);

    // Persist the default work-location for new calendar entries. Optimism isn't needed here
    // (there's no instant local effect like the theme), so we just write and surface a calm
    // note on failure — the saved value drives the planner the next time an entry is created.
    const handleWorkLocationChange = async (next) => {
        if (!currentUser || savingWorkLoc) return;
        if (next === currentWorkLocation) return;
        setWorkLocError('');
        setSavingWorkLoc(true);
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), { defaultWorkLocation: next });
        } catch (err) {
            logError(err, { source: 'profile:workLocationToggle' });
            if (mountedRef.current) setWorkLocError('Nepavyko išsaugoti nustatymo.');
        } finally {
            if (mountedRef.current) setSavingWorkLoc(false);
        }
    };

    // Re-seed the local template list whenever the stored value changes (our own confirmed write,
    // or an edit made on another device). Compared by value so a no-op snapshot doesn't churn state.
    const storedTemplatesKey = JSON.stringify(normalizeUserTemplates(userData?.quickWorkTemplates));
    useEffect(() => {
        setQuickTemplates(JSON.parse(storedTemplatesKey));
    }, [storedTemplatesKey]);

    // Persist a new template list to the user doc. Optimistic: update the visible list first, then
    // write; on failure revert and show a calm note. Stays within MAX_USER_TEMPLATES (the input is
    // also disabled at the cap), and de-dupes/sanitises through the shared normaliser.
    const persistTemplates = async (next) => {
        const prev = quickTemplates;
        setTemplatesError('');
        setQuickTemplates(next);
        setSavingTemplates(true);
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), { quickWorkTemplates: next });
        } catch (err) {
            logError(err, { source: 'profile:quickWorkTemplates' });
            if (mountedRef.current) {
                setQuickTemplates(prev);
                setTemplatesError('Nepavyko išsaugoti šablono. Bandykite dar kartą.');
            }
        } finally {
            if (mountedRef.current) setSavingTemplates(false);
        }
    };

    const handleAddTemplate = () => {
        const next = normalizeUserTemplates([...quickTemplates, newTemplate]);
        // Nothing new (blank, duplicate, or at the cap) — just clear the field.
        if (next.length === quickTemplates.length) {
            setNewTemplate('');
            return;
        }
        setNewTemplate('');
        persistTemplates(next);
    };

    const handleRemoveTemplate = (label) => {
        persistTemplates(quickTemplates.filter((t) => t !== label));
    };

    const toggleNotifications = async () => {
        if (savingNotif) return;
        setNotifError('');
        setSavingNotif(true);
        try {
            await updateDoc(doc(db, 'users', currentUser.uid), {
                notificationsEnabled: !notificationsEnabled,
            });
        } catch (err) {
            logError(err, { source: 'profile:notificationsToggle' });
            if (mountedRef.current) setNotifError('Nepavyko išsaugoti nustatymo.');
        } finally {
            if (mountedRef.current) setSavingNotif(false);
        }
    };

    // Install entry: prefer the native OS dialog when Chrome has offered one; otherwise (iOS, or a
    // prompt already consumed) fall back to the manual add-to-home-screen steps. Unlike the banner,
    // this entry never snoozes — it is a deliberate user action, so it stays findable.
    const handleInstall = async () => {
        if (canPromptNative) {
            const outcome = await promptInstall();
            if (outcome === 'unavailable') setShowInstall(true);
        } else {
            setShowInstall(true);
        }
    };

    return (
        <div className="mx-auto max-w-md">
            {/* Page header: back returns to the tab the user came from. */}
            <div className="flex items-center gap-2 py-2">
                <IconButton icon={ArrowLeft} label="Atgal" onClick={goToPreviousTab} />
                <h1 className="text-h2 font-bold text-ink-strong">Profilis</h1>
            </div>

            {/* Identity */}
            <Card className="mb-4 p-6 text-center">
                {/* The whole 80px avatar is the tap target (>= 44px, WCAG §7); the camera badge
                    is a decorative hint. A labelled "Keisti nuotrauką" row below repeats the action. */}
                <button
                    type="button"
                    onClick={handlePickPhoto}
                    disabled={uploading}
                    aria-label="Keisti nuotrauką"
                    className="relative mx-auto mb-3 block h-20 w-20 rounded-full transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-60"
                >
                    <Avatar src={photoURL} name={fullName} email={email} size="lg" />
                    <span
                        aria-hidden="true"
                        className="absolute -bottom-1 -right-1 inline-flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface-card text-ink-muted shadow-sm"
                    >
                        {uploading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                            <Camera className="h-4 w-4" />
                        )}
                    </span>
                </button>

                {fullName && <p className="text-h3 font-semibold text-ink-strong">{fullName}</p>}
                <div className="mt-3 flex justify-center">
                    <StatusPill tone={role.tone} icon={ROLE_GLYPHS[userRole]}>{role.label}</StatusPill>
                </div>
                {memberSince && (
                    <p className="mt-3 text-caption text-ink-muted">Narys nuo {memberSince}</p>
                )}

                {photoError && (
                    <p role="alert" className="mt-3 text-caption font-medium text-feedback-danger">
                        {photoError}
                    </p>
                )}

                <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handlePhotoSelected}
                    className="hidden"
                />
            </Card>

            {/* Achievements — the full ladder. The owner sees every badge, earned ones in their
                metal color first, then the still-locked ones; tapping any tile opens what earns
                it. (Peer profiles stay earned-only — guardrail W4.) */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Pasiekimai</h2>
            <Card className="mb-4 p-4">
                <p className="mb-3 text-caption text-ink-muted">
                    Bakstelėkite ženkliuką ir pamatysite, už ką jis skiriamas.
                </p>
                <div className="grid grid-cols-3 gap-4">
                    {badgeLadder.map((b) => (
                        <button
                            key={b.key}
                            type="button"
                            onClick={() => setSelectedBadge(b)}
                            aria-label={`${b.name} — peržiūrėti, už ką skiriamas`}
                            className="flex min-h-touch flex-col items-stretch rounded-control p-1 transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        >
                            <Badge
                                className="w-full"
                                tier={tierKey(b.tier)}
                                name={b.name}
                                icon={BADGE_ICONS[b.key]}
                                locked={b.tier === 0}
                            />
                            <BadgeProgress badge={b} progress={progress[b.key]} />
                        </button>
                    ))}
                </div>
            </Card>

            {/* Self-insight — a few plain headline numbers from the owner's OWN data (the same
                compute engine the manager panel uses, scoped to the worker). No comparison to
                anyone else; a calm note stands in until there is enough data to read. */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Mano rodikliai</h2>
            <Card className="mb-4 p-4">
                {statsError ? (
                    <EmptyState
                        icon={BarChart3}
                        title="Nepavyko įkelti rodiklių"
                        description="Bandykite vėliau."
                    />
                ) : statsLoading ? (
                    <Spinner label="Skaičiuojama…" />
                ) : hasSelfMetrics ? (
                    <>
                        <p className="mb-3 text-caption text-ink-muted">Per paskutinius 3 mėnesius.</p>
                        <dl className="grid grid-cols-3 gap-3 text-center">
                            {SELF_METRICS.map((m) => (
                                <div key={m.key} className="rounded-control bg-surface-sunken p-3">
                                    <dt className="text-caption text-ink-muted">{m.label}</dt>
                                    <dd className="mt-1 text-h3 font-bold tabular-nums text-ink-strong">
                                        {formatStatValue(selfStats?.[m.key], m.kind)}
                                    </dd>
                                </div>
                            ))}
                        </dl>
                    </>
                ) : (
                    <EmptyState
                        icon={BarChart3}
                        title="Rodikliai dar renkasi"
                        description="Padirbėkite kelias suplanuotas pamainas — netrukus čia matysite savo punktualumą ir kokybę."
                    />
                )}
            </Card>

            {/* Personal quick-work templates — the worker's own one-tap categories that appear in
                the "Greitos veiklos pabaiga" modal, on top of the built-in ones (Tvarkos,
                Administracija, Auto darbai, Pagalba). Picking one there becomes the session title. */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Greitos veiklos šablonai</h2>
            <Card className="mb-4 p-4">
                <p className="mb-3 flex items-start gap-2 text-caption text-ink-muted">
                    <Zap className="mt-0.5 h-4 w-4 shrink-0 text-session-quickWork-accent" aria-hidden="true" />
                    Pridėkite savo dažniausius greitus darbus — jie atsiras pasirinkimui užbaigiant greitą veiklą.
                </p>

                {quickTemplates.length > 0 ? (
                    <ul className="mb-3 flex flex-wrap gap-2">
                        {quickTemplates.map((label) => (
                            <li key={label}>
                                <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-sunken py-1 pl-3 pr-1 text-body text-ink">
                                    {label}
                                    <button
                                        type="button"
                                        onClick={() => handleRemoveTemplate(label)}
                                        disabled={savingTemplates}
                                        aria-label={`Pašalinti šabloną „${label}“`}
                                        className="inline-flex h-7 w-7 items-center justify-center rounded-full text-ink-muted transition-colors hover:bg-feedback-danger-soft hover:text-feedback-danger-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50"
                                    >
                                        <X className="h-4 w-4" aria-hidden="true" />
                                    </button>
                                </span>
                            </li>
                        ))}
                    </ul>
                ) : (
                    <p className="mb-3 text-caption text-ink-muted">Dar nėra savų šablonų.</p>
                )}

                {quickTemplates.length < MAX_USER_TEMPLATES ? (
                    <form
                        onSubmit={(e) => { e.preventDefault(); handleAddTemplate(); }}
                        className="flex items-center gap-2"
                    >
                        <input
                            type="text"
                            value={newTemplate}
                            onChange={(e) => setNewTemplate(e.target.value)}
                            maxLength={MAX_TEMPLATE_LABEL}
                            placeholder="pvz. Sandėlio tvarkymas"
                            aria-label="Naujas greito darbo šablonas"
                            className="min-h-touch flex-1 rounded-control border-2 border-line bg-surface-card px-3 text-body text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                            style={{ fontSize: '16px' }}
                        />
                        <Button type="submit" variant="secondary" icon={Plus} disabled={!newTemplate.trim() || savingTemplates}>
                            Pridėti
                        </Button>
                    </form>
                ) : (
                    <p className="text-caption text-ink-muted">Pasiektas didžiausias šablonų skaičius ({MAX_USER_TEMPLATES}).</p>
                )}

                {templatesError && (
                    <p role="alert" className="mt-3 text-caption font-medium text-feedback-danger">
                        {templatesError}
                    </p>
                )}
            </Card>

            {/* Actions — everything the user can do here, as one flat list with no section
                headers: pick a theme, toggle notifications, install the app, log out. (Changing
                the photo lives on the avatar tap target in the identity card above.) */}
            <Card className="mb-4 overflow-hidden">
                {/* Appearance — light / dark / system theme (ADR 0008). A 3-way segmented control;
                    each option pairs an icon with a label so the active choice is never color-only. */}
                <div className="border-b border-line p-4">
                    <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                            <p className="text-body font-medium text-ink-strong">Tema</p>
                            <p className="text-caption text-ink-muted">
                                „Sistemos“ seka jūsų įrenginio nustatymą
                            </p>
                        </div>
                    </div>
                    <div
                        role="radiogroup"
                        aria-label="Programėlės tema"
                        className="mt-3 grid grid-cols-3 gap-2"
                    >
                        {THEME_OPTIONS.map((opt) => {
                            const selected = themePreference === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => handleThemeChange(opt.value)}
                                    disabled={savingTheme}
                                    className={cn(
                                        'flex min-h-touch flex-col items-center justify-center gap-1 rounded-control border px-2 py-2.5 text-caption font-medium transition-colors duration-base',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                        'disabled:opacity-50',
                                        selected
                                            ? 'border-brand bg-brand-soft text-brand'
                                            : 'border-line bg-surface-card text-ink-muted hover:bg-surface-sunken'
                                    )}
                                >
                                    <opt.Icon className="h-5 w-5" aria-hidden="true" />
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                    {themeError && (
                        <p role="alert" className="mt-3 text-caption font-medium text-feedback-danger">
                            {themeError}
                        </p>
                    )}
                </div>

                {/* Default work-location — pre-fills the planner toggle for new entries so the user
                    stops switching every entry by hand. A 2-way segmented control mirroring the theme
                    picker; each option pairs an icon with a label (never color-only, §5). */}
                <div className="border-b border-line p-4">
                    <div className="min-w-0 flex-1">
                        <p className="text-body font-medium text-ink-strong">Numatytoji veiklos vieta</p>
                        <p className="text-caption text-ink-muted">
                            Taikoma naujiems kalendoriaus įrašams. Kiekvieną įrašą galima keisti atskirai.
                        </p>
                    </div>
                    <div
                        role="radiogroup"
                        aria-label="Numatytoji veiklos vieta"
                        className="mt-3 grid grid-cols-2 gap-2"
                    >
                        {WORK_LOCATION_OPTIONS.map((opt) => {
                            const selected = currentWorkLocation === opt.value;
                            return (
                                <button
                                    key={opt.value}
                                    type="button"
                                    role="radio"
                                    aria-checked={selected}
                                    onClick={() => handleWorkLocationChange(opt.value)}
                                    disabled={savingWorkLoc}
                                    className={cn(
                                        'flex min-h-touch flex-col items-center justify-center gap-1 rounded-control border px-2 py-2.5 text-caption font-medium transition-colors duration-base',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2',
                                        'disabled:opacity-50',
                                        selected
                                            ? 'border-brand bg-brand-soft text-brand'
                                            : 'border-line bg-surface-card text-ink-muted hover:bg-surface-sunken'
                                    )}
                                >
                                    <opt.Icon className="h-5 w-5" aria-hidden="true" />
                                    {opt.label}
                                </button>
                            );
                        })}
                    </div>
                    {workLocError && (
                        <p role="alert" className="mt-3 text-caption font-medium text-feedback-danger">
                            {workLocError}
                        </p>
                    )}
                </div>

                <div className="flex items-center gap-3 border-b border-line p-4">
                    <Bell className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-body font-medium text-ink-strong">Pranešimai</p>
                        <p className="text-caption text-ink-muted">
                            Apie aktyvias veiklos sesijas telefono ekrane
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={notificationsEnabled}
                        aria-label="Pranešimai"
                        onClick={toggleNotifications}
                        disabled={savingNotif}
                        className="inline-flex min-h-touch min-w-touch items-center justify-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 disabled:opacity-50"
                    >
                        <span
                            className={cn(
                                'relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-base',
                                notificationsEnabled ? 'bg-brand' : 'bg-surface-sunken'
                            )}
                        >
                            <span
                                className={cn(
                                    'inline-block h-5 w-5 transform rounded-full bg-surface-card shadow transition-transform duration-base',
                                    notificationsEnabled ? 'translate-x-6' : 'translate-x-1'
                                )}
                            />
                        </span>
                    </button>
                </div>
                {notifError && (
                    <p role="alert" className="border-b border-line px-4 pb-3 pt-1 text-caption font-medium text-feedback-danger">
                        {notifError}
                    </p>
                )}

                {/* Install — a persistent, always-findable entry point (the banner above the
                    workspace is snoozable and race-prone; this is the reliable fallback). Hidden
                    once the app is already running standalone, since there is nothing to install. */}
                {!isStandalone && (
                    <button
                        type="button"
                        onClick={handleInstall}
                        className="flex w-full items-center gap-3 border-b border-line p-4 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                    >
                        <Download className="h-5 w-5 shrink-0 text-brand" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <p className="text-body font-medium text-ink-strong">Įdiegti programėlę</p>
                            <p className="text-caption text-ink-muted">
                                Spartesnė prieiga ir pranešimai telefono ekrane
                            </p>
                        </div>
                        <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    </button>
                )}

                <button
                    type="button"
                    onClick={() => setConfirmLogout(true)}
                    className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-feedback-danger-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                >
                    <LogOut className="h-5 w-5 shrink-0 text-feedback-danger-text" aria-hidden="true" />
                    <span className="flex-1 text-body font-medium text-feedback-danger-text">Atsijungti</span>
                </button>
            </Card>

            {confirmLogout && (
                <ConfirmDialog
                    title="Atsijungti?"
                    message="Ar tikrai norite atsijungti iš programėlės?"
                    confirmLabel="Atsijungti"
                    cancelLabel="Atšaukti"
                    variant="danger"
                    onConfirm={() => logout()}
                    onCancel={() => setConfirmLogout(false)}
                />
            )}

            {showInstall && (
                <InstallInstructions isIOS={isIOS} onClose={() => setShowInstall(false)} />
            )}

            {selectedBadge && (
                <BadgeDetailModal badge={selectedBadge} onClose={() => setSelectedBadge(null)} />
            )}
        </div>
    );
}
