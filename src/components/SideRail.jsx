import { memo, useMemo, useState, useCallback } from 'react';
import { Plus, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { usePendingApprovalsCount } from '../hooks/usePendingApprovalsCount';
import { getNavSections } from '../config/navTabs';
import { ROLE_GLYPHS } from './icons/roleInsigniaMap';
import Button from './ui/Button';
import IconButton from './ui/IconButton';
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

// Persisted collapse preference. Desktop-only (SideRail mounts only at lg+), survives reloads.
const STORAGE_KEY = 'workz:sideRailCollapsed';

function readStoredCollapsed() {
    try {
        return localStorage.getItem(STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

const navItemBase =
    'flex min-h-touch items-center rounded-control text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset';

/**
 * SideRail — the desktop (`lg+`) app shell navigation. Replaces the mobile bottom bar AND the
 * floating work pill with a single docked surface (DESIGN_SYSTEM §9 "prefer merging into one
 * docked surface"), read top→bottom: brand → primary `Sukurti` action → grouped destinations
 * → session work-controls → account.
 *
 * Collapsible: a toggle in the header narrows the rail to an icon-only strip (`w-16`) — nav
 * destinations show their glyph only (label moves to aria-label + native tooltip), section
 * headings become thin dividers, and the footer work-timers stack VERTICALLY without their
 * text labels. The choice persists to localStorage. Color is never the sole signal even when
 * collapsed: every control keeps a distinct icon shape plus an accessible name (WCAG 1.4.1).
 *
 * Mounted exclusively (not CSS-hidden) opposite `BottomNavigation` — see `useMediaQuery` for
 * why the session timers must not be duplicated in the DOM.
 */
function SideRail() {
    const { currentUser, userRole } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const pendingApprovals = usePendingApprovalsCount();
    const sections = useMemo(() => getNavSections(userRole), [userRole]);
    const RoleIcon = ROLE_GLYPHS[userRole];
    const [collapsed, setCollapsed] = useState(readStoredCollapsed);

    const toggleCollapsed = useCallback(() => {
        setCollapsed((prev) => {
            const next = !prev;
            try {
                localStorage.setItem(STORAGE_KEY, next ? '1' : '0');
            } catch {
                /* private mode / storage disabled — the in-memory state still applies */
            }
            return next;
        });
    }, []);

    if (!currentUser) return null;

    return (
        <div
            className={cn(
                'sticky top-0 z-nav flex h-screen shrink-0 flex-col border-r border-line bg-surface-card transition-[width] duration-base',
                collapsed ? 'w-16' : 'w-56'
            )}
        >
            {/* Fixed top: brand + collapse toggle + primary create action (never scrolls away). */}
            <div className={cn('shrink-0 pt-3 pb-1.5', collapsed ? 'px-2' : 'px-2.5')}>
                {collapsed ? (
                    <div className="flex justify-center pb-1.5">
                        <IconButton icon={PanelLeftOpen} label="Išplėsti meniu" onClick={toggleCollapsed} />
                    </div>
                ) : (
                    <>
                        <div className="flex items-center justify-between px-1">
                            <span className="text-h3 font-extrabold tracking-tight text-ink-strong">WORKZ</span>
                            <IconButton icon={PanelLeftClose} label="Sutraukti meniu" onClick={toggleCollapsed} />
                        </div>
                        <div className="px-1 pb-1.5">
                            <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2 py-0.5 text-caption font-medium text-brand-hover">
                                {RoleIcon && <RoleIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                                {ROLE_NAMES[userRole] || userRole}
                            </span>
                        </div>
                    </>
                )}

                {collapsed ? (
                    <IconButton
                        icon={Plus}
                        label="Sukurti"
                        variant="primary"
                        className="w-full"
                        onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                    />
                ) : (
                    <Button
                        variant="primary"
                        fullWidth
                        icon={Plus}
                        onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                    >
                        Sukurti
                    </Button>
                )}
            </div>

            {/* Scrollable destinations, grouped (Mano / Komanda / Administravimas). Only this
                middle region scrolls — the create action above and the controls/account below
                stay pinned, so the profile is always visible in the footer. When collapsed,
                section headings collapse to thin dividers and each item is an icon-only target. */}
            <nav
                aria-label="Pagrindinė navigacija"
                className={cn('flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto py-1', collapsed ? 'px-2' : 'px-2.5')}
            >
                {sections.map((section, index) => (
                    <div key={section.id} className="flex flex-col gap-0.5">
                        {collapsed
                            ? index > 0 && <div className="mx-2 my-1 border-t border-line" aria-hidden="true" />
                            : section.label && (
                                  <span className="px-3 pb-0.5 pt-2 text-caption font-semibold uppercase tracking-wide text-ink-muted">
                                      {section.label}
                                  </span>
                              )}
                        {section.items.map((tab) => {
                            const active = activeTab === tab.id;
                            // New sign-ups awaiting approval surface a persistent count on the
                            // Vartotojai destination (admin-only; 0 hides it). A label suffix keeps
                            // the count out of the accessible name so it is never the sole signal.
                            const badge = tab.id === 'users' ? pendingApprovals : 0;
                            const badgeLabel = badge > 99 ? '99+' : String(badge);
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-current={active ? 'page' : undefined}
                                    aria-label={
                                        collapsed
                                            ? (badge > 0 ? `${tab.label}, ${badge} laukia patvirtinimo` : tab.label)
                                            : (badge > 0 ? `${tab.label}, ${badge} laukia patvirtinimo` : undefined)
                                    }
                                    title={collapsed ? tab.label : undefined}
                                    className={cn(
                                        navItemBase,
                                        'relative',
                                        collapsed ? 'justify-center px-0' : 'gap-3 px-3',
                                        active
                                            ? 'bg-brand-soft text-brand-hover'
                                            : 'text-ink-muted hover:bg-surface-sunken hover:text-ink'
                                    )}
                                >
                                    <tab.icon className="h-5 w-5 shrink-0" aria-hidden="true" />
                                    {!collapsed && <span className="truncate">{tab.label}</span>}
                                    {badge > 0 && (collapsed ? (
                                        <span
                                            aria-hidden="true"
                                            className="absolute right-1 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-caption font-bold leading-none text-white"
                                        >
                                            {badgeLabel}
                                        </span>
                                    ) : (
                                        <span
                                            aria-hidden="true"
                                            className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-caption font-bold leading-none text-white"
                                        >
                                            {badgeLabel}
                                        </span>
                                    ))}
                                </button>
                            );
                        })}
                    </div>
                ))}
            </nav>

            {/* Fixed footer: session work-controls, pinned to the bottom. The active-session
                readout and the account/avatar entry both moved to the top bar (AppHeader); the
                "Darbo valdikliai" heading stays dropped — the icons + labels are self-explanatory.
                Collapsed: the three timers stack vertically as bare icon buttons. */}
            <div className={cn('shrink-0 pb-2.5', collapsed ? 'px-2' : 'px-2.5')}>
                <div className="flex flex-col gap-1.5 border-t border-line pt-2">
                    <div className={cn('flex gap-1', collapsed ? 'flex-col items-center' : 'items-start justify-around')}>
                        <QuickWorkTimer compact hideLabel={collapsed} />
                        <CallTimer compact hideLabel={collapsed} />
                        <BreakTimer currentUser={currentUser} compact hideLabel={collapsed} />
                    </div>
                </div>
            </div>
        </div>
    );
}

export default memo(SideRail);
