import { Trophy } from 'lucide-react';
import { useUsers } from '../context/UsersContext';
import { useAchievements } from '../hooks/useAchievements';
import { formatDisplayName } from '../utils/formatters';
import { BADGE_ICONS, tierKey } from '../utils/badgeCatalog';
import Modal from './ui/Modal';
import Avatar from './ui/Avatar';
import StatusPill from './ui/StatusPill';
import Badge from './ui/Badge';
import EmptyState from './ui/EmptyState';

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
 */
export default function UserProfileModal({ userId, onClose }) {
    const { usersMap } = useUsers();
    const { achievements } = useAchievements(userId);

    const user = usersMap?.[userId];
    const name = formatDisplayName(user?.displayName || user?.email || 'Narys');
    const role = ROLE_META[user?.role] || ROLE_META.worker;
    const memberSince = user?.createdAt
        ? new Date(user.createdAt).toLocaleDateString('lt-LT', { year: 'numeric', month: 'long' })
        : null;

    return (
        <Modal open onClose={onClose} ariaLabel={`${name} profilis`} size="sm">
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
        </Modal>
    );
}
