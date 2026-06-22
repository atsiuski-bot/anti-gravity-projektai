import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Camera, LogOut, Bell, ChevronRight, Loader2, Trophy, Download } from 'lucide-react';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { doc, updateDoc } from 'firebase/firestore';
import { storage, db } from '../firebase';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { useAchievements } from '../hooks/useAchievements';
import { useInstallPrompt } from '../hooks/useInstallPrompt';
import { compressImage } from '../utils/imageUtils';
import { logError } from '../utils/errorLog';
import { cn } from '../utils/cn';
import { BADGE_ICONS, tierKey } from '../utils/badgeCatalog';
import Card from '../components/ui/Card';
import IconButton from '../components/ui/IconButton';
import StatusPill from '../components/ui/StatusPill';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import Avatar from '../components/ui/Avatar';
import Badge from '../components/ui/Badge';
import EmptyState from '../components/ui/EmptyState';
import InstallInstructions from '../components/InstallInstructions';

// Role presentation — pair color with text so role is never color-only (DESIGN_SYSTEM §5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    manager: { label: 'Vadovas', tone: 'info' },
    worker: { label: 'Vykdytojas', tone: 'neutral' },
};

// A user photo stays small; cap the long edge and re-encode so the upload is light on a
// field worker's mobile connection. Lives at a fixed per-user path so a new photo overwrites
// the old one (no orphaned avatar files accumulate, unlike multi-file task attachments).
const AVATAR_MAX_EDGE = 512;

export default function ProfilePage() {
    const { currentUser, userData, userRole, logout } = useAuth();
    const { goToPreviousTab } = useNavigation();
    const { achievements } = useAchievements(currentUser?.uid);
    const { canPromptNative, isIOS, isStandalone, promptInstall } = useInstallPrompt();

    const fileInputRef = useRef(null);
    const [uploading, setUploading] = useState(false);
    const [photoError, setPhotoError] = useState('');
    const [savingNotif, setSavingNotif] = useState(false);
    const [notifError, setNotifError] = useState('');
    const [confirmLogout, setConfirmLogout] = useState(false);
    const [showInstall, setShowInstall] = useState(false);

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
                {email && <p className="mt-0.5 text-body text-ink-muted">{email}</p>}
                <div className="mt-3 flex justify-center">
                    <StatusPill tone={role.tone}>{role.label}</StatusPill>
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

            {/* Achievements — the trophy shelf. Earned tiers only; an empty shelf reads as
                "new here", never a deficit (guardrail W4). */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Pasiekimai</h2>
            <Card className="mb-4 p-4">
                {achievements.length > 0 ? (
                    <div className="grid grid-cols-3 gap-4">
                        {achievements.map((a) => (
                            <Badge
                                key={a.id}
                                tier={tierKey(a.tier)}
                                name={a.name}
                                icon={BADGE_ICONS[a.key]}
                            />
                        ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={Trophy}
                        title="Pirmieji ženkliukai dar laukia"
                        description="Užbaik darbus ir dirbk nuosekliai — pasiekimai atsiras čia."
                    />
                )}
            </Card>

            {/* Settings */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Nustatymai</h2>
            <Card className="mb-4 overflow-hidden">
                <div className="flex items-center gap-3 p-4">
                    <Bell className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                        <p className="text-body font-medium text-ink-strong">Pranešimai</p>
                        <p className="text-caption text-ink-muted">
                            Apie aktyvias darbo sesijas telefono ekrane
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
                    <p role="alert" className="px-4 pb-3 text-caption font-medium text-feedback-danger">
                        {notifError}
                    </p>
                )}
            </Card>

            {/* App install — a persistent, always-findable entry point (the banner above the
                workspace is snoozable and race-prone; this is the reliable fallback). Hidden once
                the app is already running standalone, since there is nothing left to install. */}
            {!isStandalone && (
                <>
                    <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Programėlė</h2>
                    <Card className="mb-4 overflow-hidden">
                        <button
                            type="button"
                            onClick={handleInstall}
                            className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
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
                    </Card>
                </>
            )}

            {/* Account */}
            <h2 className="mb-2 px-1 text-caption font-medium text-ink-muted">Paskyra</h2>
            <Card className="overflow-hidden">
                <button
                    type="button"
                    onClick={handlePickPhoto}
                    disabled={uploading}
                    className="flex w-full items-center gap-3 border-b border-line p-4 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:opacity-50"
                >
                    <Camera className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                    <span className="flex-1 text-body font-medium text-ink-strong">Keisti nuotrauką</span>
                    <ChevronRight className="h-5 w-5 shrink-0 text-ink-muted" aria-hidden="true" />
                </button>
                <button
                    type="button"
                    onClick={() => setConfirmLogout(true)}
                    className="flex w-full items-center gap-3 p-4 text-left transition-colors hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand"
                >
                    <LogOut className="h-5 w-5 shrink-0 text-red-700" aria-hidden="true" />
                    <span className="flex-1 text-body font-medium text-red-700">Atsijungti</span>
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
        </div>
    );
}
