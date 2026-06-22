import { memo, useMemo } from 'react';
import { Plus, LogOut, User } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { formatDisplayName } from '../utils/formatters';
import { getNavSections } from '../config/navTabs';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
import QuickWorkTimer from './QuickWorkTimer';
import CallTimer from './CallTimer';
import BreakTimer from './BreakTimer';
import ActiveSessionReadout from './ActiveSessionReadout';
import { cn } from '../utils/cn';

const ROLE_NAMES = {
    manager: 'Vadovas',
    worker: 'Darbuotojas',
    admin: 'Administratorius',
};

const navItemBase =
    'flex min-h-touch items-center gap-3 rounded-control px-3 text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset';

/**
 * SideRail — the desktop (`lg+`) app shell navigation. Replaces the mobile bottom bar AND the
 * floating work pill with a single docked surface (DESIGN_SYSTEM §9 "prefer merging into one
 * docked surface"), read top→bottom: brand → primary `Sukurti` action → grouped destinations
 * → session work-controls → account.
 *
 * Mounted exclusively (not CSS-hidden) opposite `BottomNavigation` — see `useMediaQuery` for
 * why the session timers must not be duplicated in the DOM.
 */
function SideRail() {
    const { currentUser, userRole, logout } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const sections = useMemo(() => getNavSections(userRole), [userRole]);

    if (!currentUser) return null;

    return (
        <div className="sticky top-0 z-nav flex h-screen w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line bg-surface-card px-3 py-4">
            {/* Brand + role */}
            <div className="flex items-center justify-between px-1 pb-2">
                <span className="text-h2 font-extrabold tracking-tight text-ink-strong">WORKZ</span>
                <span className="rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand-hover">
                    {ROLE_NAMES[userRole] || userRole}
                </span>
            </div>

            {/* Primary create action — its natural desktop home is the top of the rail. */}
            <Button
                variant="primary"
                fullWidth
                icon={Plus}
                onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                className="mb-2"
            >
                Sukurti
            </Button>

            {/* Destinations, grouped (Mano / Komanda / Administravimas). */}
            <nav aria-label="Pagrindinė navigacija" className="flex flex-col gap-1">
                {sections.map((section) => (
                    <div key={section.id} className="flex flex-col gap-0.5">
                        {section.label && (
                            <span className="px-3 pb-1 pt-3 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                                {section.label}
                            </span>
                        )}
                        {section.items.map((tab) => {
                            const active = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        navItemBase,
                                        active
                                            ? 'bg-brand-soft text-brand-hover'
                                            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                                    )}
                                >
                                    <tab.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                    <span className="truncate">{tab.label}</span>
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>

            {/* Spacer pushes the work-controls + account block to the foot. */}
            <div className="flex-1" />

            {/* Work controls — the session timers live here on desktop (replacing the floating
                pill). ActiveSessionReadout surfaces the live elapsed time + which session, so
                the compact buttons themselves stay short — exactly the mobile bar's pattern,
                reused so a running session is always visible, never hidden behind a gesture. */}
            <div className="flex flex-col gap-2 border-t border-line pt-3">
                <span className="px-1 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                    Darbo valdikliai
                </span>
                <div className="flex justify-center">
                    <ActiveSessionReadout />
                </div>
                <div className="flex items-start justify-around gap-1">
                    <QuickWorkTimer compact />
                    <CallTimer compact />
                    <BreakTimer currentUser={currentUser} compact />
                </div>
            </div>

            {/* Account */}
            <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                {currentUser?.photoURL ? (
                    <img src={currentUser.photoURL} alt="" className="h-8 w-8 rounded-full" />
                ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-sunken">
                        <User className="h-5 w-5 text-ink-muted" aria-hidden="true" />
                    </div>
                )}
                <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
                    {formatDisplayName(currentUser?.displayName)}
                </span>
                <IconButton icon={LogOut} label="Atsijungti" onClick={() => logout()} />
            </div>
        </div>
    );
}

export default memo(SideRail);
