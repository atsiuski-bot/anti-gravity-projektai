import { memo, useMemo } from 'react';
import { Plus } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { getNavSections } from '../config/navTabs';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';
import Button from './ui/Button';
import QuickWorkTimer from './QuickWorkTimer';
import CallTimer from './CallTimer';
import BreakTimer from './BreakTimer';
import { cn } from '../utils/cn';

const ROLE_NAMES = {
    seniorManager: 'Vyr. vadovas',
    manager: 'Vadovas',
    worker: 'Vykdytojas',
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
    const { currentUser, userRole } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const sections = useMemo(() => getNavSections(userRole), [userRole]);
    const RoleIcon = ROLE_GLYPHS[userRole];

    if (!currentUser) return null;

    return (
        <div className="sticky top-0 z-nav flex h-screen w-56 shrink-0 flex-col border-r border-line bg-surface-card">
            {/* Fixed top: brand + primary create action (never scrolls away). */}
            <div className="shrink-0 px-2.5 pt-3 pb-1.5">
                <div className="flex items-center justify-between px-1 pb-1.5">
                    <span className="text-h3 font-extrabold tracking-tight text-ink-strong">WORKZ</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand-hover">
                        {RoleIcon && <RoleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                        {ROLE_NAMES[userRole] || userRole}
                    </span>
                </div>
                <Button
                    variant="primary"
                    fullWidth
                    icon={Plus}
                    onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                >
                    Sukurti
                </Button>
            </div>

            {/* Scrollable destinations, grouped (Mano / Komanda / Administravimas). Only this
                middle region scrolls — the create action above and the controls/account below
                stay pinned, so the profile is always visible in the footer. */}
            <nav aria-label="Pagrindinė navigacija" className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2.5 py-1">
                {sections.map((section) => (
                    <div key={section.id} className="flex flex-col gap-0.5">
                        {section.label && (
                            <span className="px-3 pb-0.5 pt-2 text-caption font-semibold uppercase tracking-wide text-ink-muted">
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

            {/* Fixed footer: session work-controls, pinned to the bottom. The active-session
                readout and the account/avatar entry both moved to the top bar (AppHeader); the
                "Darbo valdikliai" heading stays dropped — the icons + labels are self-explanatory. */}
            <div className="shrink-0 px-2.5 pb-2.5">
                <div className="flex flex-col gap-1.5 border-t border-line pt-2">
                    <div className="flex items-start justify-around gap-1">
                        <QuickWorkTimer compact />
                        <CallTimer compact />
                        <BreakTimer currentUser={currentUser} compact />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default memo(SideRail);
