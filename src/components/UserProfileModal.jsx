import { lazy, Suspense, useState } from 'react';
import { Trophy, BarChart3 } from 'lucide-react';
import clsx from 'clsx';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { useAchievements } from '../hooks/useAchievements';
import { formatDisplayName } from '../utils/formatters';
import { BADGE_ICONS, tierKey } from '../utils/badgeCatalog';
import { canSeeWholeTeam, isScopedManager, isOnManagerTeam } from '../utils/teamScope';
import Modal from './ui/Modal';
import Avatar from './ui/Avatar';
import StatusPill from './ui/StatusPill';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';

// The day-report drill-down is heavy (its own Firestore listeners), so it only mounts when a
// manager actually switches to the "Statistika" tab — never on the achievements view.
const DailyStatistics = lazy(() => import('./DailyStatistics'));

// Role presentation — color paired with text (DESIGN_SYSTEM §5).
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    manager: { label: 'Vadovas', tone: 'info' },
    worker: { label: 'Vykdytojas', tone: 'neutral' },
};

/**
 * UserProfileModal — the READ-ONLY peer profile (P2). Opened from any UserChip via the
 * ProfileViewer context. Shows identity (resolved from the live users map, no extra fetch) plus
 * the earned badge shelf. Earned-only: an empty shelf reads as "new here", never a deficit (W4).
 * Self-only controls (photo, settings, logout) live only on the owner's full ProfilePage.
 *
 * A manager who oversees this member also gets a "Statistika" tab — the same embedded day report
 * the team calendar drills into, scoped to this one member. Gated by the team-scope helpers so a
 * scoped manager only sees their own people's hours and the Firestore listeners never request a
 * row the rules would deny; whole-team viewers (admin / senior manager / unscoped manager) see
 * anyone's. Hidden for one's own chip — own stats live on the personal report surfaces.
 */
export default function UserProfileModal({ userId, onClose }) {
    const { usersMap, activeUsers } = useUsers();
    const { currentUser, userData, userRole } = useAuth();
    const { achievements } = useAchievements(userId);
    const [tab, setTab] = useState('achievements');

    const user = usersMap?.[userId];
    const name = formatDisplayName(user?.displayName || user?.email || 'Narys');
    const role = ROLE_META[user?.role] || ROLE_META.worker;
    const memberSince = user?.createdAt
        ? new Date(user.createdAt).toLocaleDateString('lt-LT', { year: 'numeric', month: 'long' })
        : null;

    // May the signed-in viewer see this member's work statistics? Whole-team viewers see anyone;
    // a scoped manager only their own team. Never for one's own chip.
    const isSelf = currentUser?.uid === userId;
    const canViewStats =
        !isSelf &&
        !!user &&
        (canSeeWholeTeam(userData) ||
            (isScopedManager(userData) && isOnManagerTeam(user, currentUser?.uid)));

    const showStats = canViewStats && tab === 'stats';

    return (
        <Modal
            open
            onClose={onClose}
            ariaLabel={`${name} profilis`}
            size="xl"
            // Fill nearly the whole viewport (only a small inset from the scrim's p-4) so the
            // member card reads as a full surface, and widen further when the day report is shown.
            className={clsx('h-[92vh] max-h-[92vh]', showStats && 'max-w-4xl')}
        >
            <div className="text-center">
                <div className="mx-auto mb-3 h-20 w-20">
                    <Avatar src={user?.photoURL || null} name={user?.displayName} email={user?.email} size="lg" />
                </div>
                <p className="text-h3 font-semibold text-ink-strong">{name}</p>
                <div className="mt-2 flex justify-center">
                    <StatusPill tone={role.tone}>{role.label}</StatusPill>
                </div>
                {memberSince && <p className="mt-2 text-caption text-ink-muted">Narys nuo {memberSince}</p>}
            </div>

            {/* Tab switch — only a manager who oversees this member gets the statistics view. */}
            {canViewStats && (
                <div
                    className="mt-5 flex justify-center"
                    role="tablist"
                    aria-label="Profilio rodinys"
                >
                    <div className="flex overflow-hidden rounded-control border border-line bg-surface-sunken">
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'achievements'}
                            onClick={() => setTab('achievements')}
                            className={clsx(
                                'flex items-center gap-1.5 px-4 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'achievements' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            Pasiekimai
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'stats'}
                            onClick={() => setTab('stats')}
                            className={clsx(
                                'flex items-center gap-1.5 px-4 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'stats' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <BarChart3 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            Statistika
                        </button>
                    </div>
                </div>
            )}

            {showStats ? (
                <div className="mt-5">
                    <Suspense
                        fallback={<div className="py-12 text-center text-body text-ink-muted">Kraunama dienos ataskaita…</div>}
                    >
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={activeUsers}
                            forceUserId={userId}
                            embedded
                        />
                    </Suspense>
                </div>
            ) : (
                <div className="mt-5">
                    <h3 className="mb-3 text-caption font-medium text-ink-muted">Pasiekimai</h3>
                    {achievements.length > 0 ? (
                        <div className="grid grid-cols-3 gap-4">
                            {achievements.map((a) => (
                                <Badge key={a.id} tier={tierKey(a.tier)} name={a.name} icon={BADGE_ICONS[a.key]} />
                            ))}
                        </div>
                    ) : (
                        <EmptyState
                            icon={Trophy}
                            title="Dar nėra ženkliukų"
                            description="Šis narys netrukus jų užsidirbs."
                        />
                    )}
                </div>
            )}
        </Modal>
    );
}
