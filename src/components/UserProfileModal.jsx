import { lazy, Suspense, useState } from 'react';
import { Trophy, BarChart3, TrendingUp } from 'lucide-react';
import clsx from 'clsx';
import { useUsers } from '../context/UsersContext';
import { useAuth } from '../context/AuthContext';
import { useAchievements } from '../hooks/useAchievements';
import { formatDisplayName } from '../utils/formatters';
import { BADGE_ICONS, tierKey } from '../utils/badgeCatalog';
import { canSeeWholeTeam, isScopedOverseer, isOverseenBy } from '../utils/teamScope';
import Modal from './ui/Modal';
import Avatar from './ui/Avatar';
import StatusPill from './ui/StatusPill';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';
import DatePicker from './ui/DatePicker';
import { PeriodPicker } from './reports/PeriodPicker';
import { PERIOD_PRESETS, resolvePresetRange } from './reports/periodPresets';
import { getLithuanianDateString } from '../utils/timeUtils';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';

// The day-report drill-down is heavy (its own Firestore listeners), so it only mounts when a
// manager actually switches to the "Statistika" tab — never on the achievements view.
const DailyStatistics = lazy(() => import('./DailyStatistics'));

// The aggregated "Suvestinė" surface (its own period queries + compute) is heavier still, so it
// also only mounts when a manager switches to that tab — never on achievements or the day report.
const WorkerStatsPanel = lazy(() => import('./stats/WorkerStatsPanel'));

// Role presentation — color paired with text (DESIGN_SYSTEM §5), with the rank insignia
// (ADR 0010). `seniorManager` must be present: without it a Vyr. vadovas peer profile fell back
// to the worker entry and read "Vykdytojas".
const ROLE_META = {
    admin: { label: 'Administratorius', tone: 'info' },
    seniorManager: { label: 'Vyr. vadovas', tone: 'info' },
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

    // "Statistika" period selector — the same ladder (day → year + custom) the team report uses,
    // sitting in its own row above the day report. 'day' keeps DailyStatistics in its live single-
    // day mode (its own stepper); any other preset resolves a from/to range and switches the embedded
    // report to its aggregated span view. Mirrors Reports.jsx so the two surfaces behave identically.
    const [statsPeriod, setStatsPeriod] = useState('day');
    const [statsPeriodOpen, setStatsPeriodOpen] = useState(false);
    const [statsRange, setStatsRange] = useState(() => {
        const today = getLithuanianDateString();
        return { start: `${today.slice(0, 7)}-01`, end: today };
    });
    const chooseStatsPeriod = (period) => {
        setStatsPeriod(period);
        setStatsPeriodOpen(false);
        if (period !== 'day') {
            const range = resolvePresetRange(period);
            if (range) setStatsRange(range);
        }
    };

    const user = usersMap?.[userId];
    const name = formatDisplayName(user?.displayName || user?.email || 'Narys');
    const role = ROLE_META[user?.role] || ROLE_META.worker;

    // May the signed-in viewer see this member's work statistics? Whole-team viewers see anyone;
    // a scoped overseer (scoped manager or senior manager) only their own subtree. Never for one's
    // own chip.
    const isSelf = currentUser?.uid === userId;
    const canViewStats =
        !isSelf &&
        !!user &&
        (canSeeWholeTeam(userData) ||
            (isScopedOverseer(userData) && isOverseenBy(user, currentUser?.uid)));

    const showStats = canViewStats && tab === 'stats';
    const showSummary = canViewStats && tab === 'summary';

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
            {/* Tab switch — sits ABOVE the identity block. Only a manager who oversees this member
                gets the statistics view. */}
            {canViewStats && (
                <div
                    className="mb-5 flex justify-center"
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
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'achievements' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <Trophy className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Pasiekimai
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'stats'}
                            onClick={() => setTab('stats')}
                            className={clsx(
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'stats' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <BarChart3 className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Statistika
                        </button>
                        <div className="w-px bg-line" aria-hidden="true" />
                        <button
                            type="button"
                            role="tab"
                            aria-selected={tab === 'summary'}
                            onClick={() => setTab('summary')}
                            className={clsx(
                                'flex items-center gap-1.5 px-3 py-2 text-caption font-semibold transition-colors',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                                tab === 'summary' ? 'bg-brand text-white' : 'text-ink hover:bg-surface-card'
                            )}
                        >
                            <TrendingUp className="hidden h-3.5 w-3.5 shrink-0 sm:block" aria-hidden="true" />
                            Suvestinė
                        </button>
                    </div>
                </div>
            )}

            {/* Identity block — full (large centered avatar + role) on the achievements view; a
                compact left-aligned row (small avatar + name only) once a stats/summary tab is open
                so the data surface gets the room. */}
            {tab === 'achievements' ? (
                <div className="text-center">
                    <div className="mx-auto mb-3 h-20 w-20">
                        <Avatar src={user?.photoURL || null} name={user?.displayName} email={user?.email} size="lg" />
                    </div>
                    <p className="text-h3 font-semibold text-ink-strong">{name}</p>
                    <div className="mt-2 flex justify-center">
                        <StatusPill tone={role.tone} icon={ROLE_GLYPHS[user?.role]}>{role.label}</StatusPill>
                    </div>
                </div>
            ) : (
                <div className="flex items-center gap-3">
                    <div className="h-10 w-10 shrink-0">
                        <Avatar src={user?.photoURL || null} name={user?.displayName} email={user?.email} size="md" />
                    </div>
                    <p className="text-h3 font-semibold text-ink-strong">{name}</p>
                </div>
            )}

            {showStats ? (
                <div className="mt-5 space-y-4">
                    {/* Period selector in its own row, separate from the report's hour totals —
                        same chip ladder + custom range as the team "Darbo ataskaita" tab. */}
                    <PeriodPicker
                        presets={PERIOD_PRESETS}
                        activeId={statsPeriod}
                        onChoose={chooseStatsPeriod}
                        open={statsPeriodOpen}
                        onToggle={() => setStatsPeriodOpen((o) => !o)}
                        label="Laikotarpis"
                    >
                        <div className="flex flex-col gap-3 border-t border-line pt-3 sm:flex-row sm:items-end">
                            <div className="flex-1">
                                <label htmlFor="stats-from" className="block text-caption font-semibold text-ink-muted mb-1">Nuo</label>
                                <DatePicker
                                    id="stats-from"
                                    value={statsRange.start}
                                    max={statsRange.end}
                                    onChange={(v) => { setStatsPeriod('custom'); setStatsRange((prev) => ({ ...prev, start: v })); }}
                                />
                            </div>
                            <div className="flex-1">
                                <label htmlFor="stats-to" className="block text-caption font-semibold text-ink-muted mb-1">Iki</label>
                                <DatePicker
                                    id="stats-to"
                                    value={statsRange.end}
                                    min={statsRange.start}
                                    max={getLithuanianDateString()}
                                    onChange={(v) => { setStatsPeriod('custom'); setStatsRange((prev) => ({ ...prev, end: v })); }}
                                />
                            </div>
                        </div>
                    </PeriodPicker>

                    <Suspense
                        fallback={<div className="py-12 text-center text-body text-ink-muted">Kraunama dienos ataskaita…</div>}
                    >
                        <DailyStatistics
                            currentUser={currentUser}
                            userRole={userRole}
                            users={activeUsers}
                            forceUserId={userId}
                            dateRange={statsPeriod === 'day' ? null : statsRange}
                            embedded
                        />
                    </Suspense>
                </div>
            ) : showSummary ? (
                <div className="mt-5">
                    <Suspense
                        fallback={<div className="py-12 text-center text-body text-ink-muted">Kraunama suvestinė…</div>}
                    >
                        <WorkerStatsPanel
                            userId={userId}
                            targetUser={user}
                            viewerData={userData}
                            viewerUid={currentUser?.uid}
                            viewerRole={userRole}
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
