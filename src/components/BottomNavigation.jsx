import { memo, useMemo, useState, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { usePendingApprovalsCount } from '../hooks/usePendingApprovalsCount';
import { isManagerRole } from '../utils/formatters';
import { getNavSections } from '../config/navTabs';
import { Plus, MoreHorizontal } from 'lucide-react';
import BreakTimer from './BreakTimer';
import CallTimer from './CallTimer';
import QuickWorkTimer from './QuickWorkTimer';
import Modal from './ui/Modal';
import { cn } from '../utils/cn';

const navItemBase =
    'flex flex-col items-center justify-center rounded-control transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset';

const BottomNavigation = () => {
    const { userRole, currentUser } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const pendingApprovals = usePendingApprovalsCount();
    const [moreOpen, setMoreOpen] = useState(false);

    // Pending-approval count for a tab (admin-only Vartotojai; 0 elsewhere) and its capped label.
    const badgeFor = (tabId) => (tabId === 'users' ? pendingApprovals : 0);
    const badgeLabel = (n) => (n > 99 ? '99+' : String(n));

    // Tabs come from the shared nav config so the bottom bar and the desktop side rail can
    // never drift (DESIGN_SYSTEM §3). Sections carry the personal/team/admin grouping.
    const sections = useMemo(() => getNavSections(userRole), [userRole]);

    // Flatten the sections for the mobile bar, then cap it at five slots: up to four primary
    // tabs + a "Daugiau" overflow sheet — never a 7-tab, 9px, horizontally-scrolling bar
    // (DESIGN_SYSTEM §9).
    const flatTabs = useMemo(() => sections.flatMap((s) => s.items), [sections]);
    const needsOverflow = flatTabs.length > 5;
    const primaryTabs = needsOverflow ? flatTabs.slice(0, 4) : flatTabs;
    const overflowTabs = needsOverflow ? flatTabs.slice(4) : [];
    const overflowActive = overflowTabs.some((t) => t.id === activeTab);
    // When a badged destination (Vartotojai) lives under the "Daugiau" sheet, surface the count on
    // the overflow trigger so a pending approval is never hidden a tap deep on a phone.
    const overflowPending = overflowTabs.reduce((sum, t) => sum + badgeFor(t.id), 0);

    const showCreateButton = (userRole === 'worker') || isManagerRole(userRole);

    const handleTab = (id) => {
        setActiveTab(id);
        setMoreOpen(false);
    };

    if (!currentUser) return null;

    // Same key shape as the timer buttons (icon in a square + caption below), set apart only by
    // its brand fill. Identical structure keeps the dock a uniform tray; the colour alone carries
    // the "this is the primary action" rank (DESIGN_SYSTEM §8 — colour ranks, shape stays calm).
    const CreateButton = () => (
        <div className="flex flex-col items-center">
            <button
                onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
                aria-label="Sukurti užduotį"
                className="inline-flex items-center justify-center min-h-touch min-w-touch rounded-control bg-brand text-white transition-all hover:bg-brand-hover active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
            >
                <Plus className="w-5 h-5" aria-hidden="true" />
            </button>
            <span className="mt-1 text-caption font-medium text-ink-muted leading-none">Sukurti</span>
        </div>
    );

    return (
        <>
            {/* Work-controls floating pill (visible on all screens). Sits a fixed gap above the
                main bar and clears the safe-area inset so both move together (DESIGN_SYSTEM §9).
                The active-session readout moved to the top bar (AppHeader); only the controls
                stay here at thumb reach. */}
            <div
                className="fixed left-0 right-0 z-nav flex w-full flex-col items-center gap-2 px-3 pb-3 pointer-events-none"
                style={{ bottom: 'calc(64px + env(safe-area-inset-bottom))' }}
            >
                <div
                    className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-2 rounded-card border border-line bg-surface-card/95 px-3 py-1.5 ring-1 ring-black/[0.04] backdrop-blur-sm"
                    style={{ boxShadow: '0 12px 28px -8px rgba(15, 23, 42, 0.28), 0 4px 10px -4px rgba(15, 23, 42, 0.16)' }}
                >
                    {showCreateButton && <CreateButton />}
                    <QuickWorkTimer compact={true} />
                    <CallTimer compact={true} />
                    <BreakTimer currentUser={currentUser} compact={true} />
                </div>
            </div>

            {/* Main bottom bar — the quiet substrate. Recedes into the canvas (surface-base, no
                shadow) so only the action dock above reads as "floating": two competing shadows
                were the reason the two strips blended into one (DESIGN_SYSTEM §9). */}
            <div
                className="fixed bottom-0 left-0 right-0 z-nav border-t border-line bg-surface-base pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
                style={{ boxShadow: '0 -10px 24px -14px rgba(15, 23, 42, 0.22)' }}
            >
                <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-2">
                    {/* Tablet (sm..lg): full tab set, centered, a thin separator between groups */}
                    <div className="hidden flex-1 items-center justify-center gap-2 sm:flex">
                        {sections.map((section, si) => (
                            <Fragment key={section.id}>
                                {si > 0 && <div className="mx-3 h-10 w-px bg-surface-sunken" />}
                                {section.items.map((tab) => {
                                    const active = activeTab === tab.id;
                                    const badge = badgeFor(tab.id);
                                    return (
                                        <button
                                            key={tab.id}
                                            onClick={() => handleTab(tab.id)}
                                            aria-current={active ? 'page' : undefined}
                                            aria-label={badge > 0 ? `${tab.label}, ${badge} laukia patvirtinimo` : undefined}
                                            className={cn(
                                                navItemBase,
                                                'relative min-w-[90px] px-4 py-2.5 hover:bg-surface-sunken',
                                                active ? 'bg-brand-soft text-brand' : 'text-ink-muted'
                                            )}
                                        >
                                            <tab.icon className="mb-1.5 h-6 w-6" aria-hidden="true" />
                                            <span className="whitespace-nowrap text-caption font-medium leading-tight">
                                                {tab.label}
                                            </span>
                                            {badge > 0 && (
                                                <span
                                                    aria-hidden="true"
                                                    className="absolute right-2 top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-caption font-bold leading-none text-white"
                                                >
                                                    {badgeLabel(badge)}
                                                </span>
                                            )}
                                        </button>
                                    );
                                })}
                            </Fragment>
                        ))}
                    </div>

                    {/* Mobile: <= 5 equal slots, no horizontal scroll, 12px labels, 44px targets */}
                    <div className="flex flex-1 items-stretch sm:hidden">
                        {primaryTabs.map((tab) => {
                            const active = activeTab === tab.id;
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => handleTab(tab.id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        navItemBase,
                                        'relative min-h-touch flex-1 px-0.5 py-1',
                                        active ? 'text-brand' : 'text-ink-muted'
                                    )}
                                >
                                    {active && (
                                        <span
                                            aria-hidden="true"
                                            className="absolute inset-x-1 top-0 bottom-1.5 rounded-control bg-brand-soft"
                                        />
                                    )}
                                    <tab.icon className="relative mb-0.5 h-5 w-5" aria-hidden="true" />
                                    <span className="relative line-clamp-2 text-center text-caption font-medium leading-tight">
                                        {tab.label}
                                    </span>
                                </button>
                            );
                        })}
                        {needsOverflow && (
                            <button
                                onClick={() => setMoreOpen(true)}
                                aria-haspopup="dialog"
                                aria-expanded={moreOpen}
                                aria-label={overflowPending > 0 ? `Daugiau, ${overflowPending} laukia patvirtinimo` : undefined}
                                className={cn(
                                    navItemBase,
                                    'relative min-h-touch flex-1 px-0.5 py-1',
                                    overflowActive ? 'text-brand' : 'text-ink-muted'
                                )}
                            >
                                {overflowActive && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute inset-x-1 inset-y-1.5 rounded-control bg-brand-soft"
                                    />
                                )}
                                <MoreHorizontal className="relative mb-0.5 h-5 w-5" aria-hidden="true" />
                                <span className="relative text-center text-caption font-medium leading-tight">Daugiau</span>
                                {overflowPending > 0 && (
                                    <span
                                        aria-hidden="true"
                                        className="absolute right-1.5 top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-brand px-1 text-caption font-bold leading-none text-white"
                                    >
                                        {badgeLabel(overflowPending)}
                                    </span>
                                )}
                            </button>
                        )}
                    </div>
                </div>
            </div>

            {/* Overflow sheet for the remaining destinations */}
            {moreOpen && (
                <Modal open onClose={() => setMoreOpen(false)} title="Daugiau" size="sm">
                    <div className="flex flex-col gap-1">
                        {overflowTabs.map((tab) => {
                            const active = activeTab === tab.id;
                            const badge = badgeFor(tab.id);
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => handleTab(tab.id)}
                                    aria-current={active ? 'page' : undefined}
                                    aria-label={badge > 0 ? `${tab.label}, ${badge} laukia patvirtinimo` : undefined}
                                    className={cn(
                                        'flex min-h-touch items-center gap-3 rounded-control px-3 text-body font-medium transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                                        active ? 'bg-brand-soft text-brand-hover' : 'text-ink hover:bg-surface-sunken'
                                    )}
                                >
                                    <tab.icon className="h-5 w-5" aria-hidden="true" />
                                    <span>{tab.label}</span>
                                    {badge > 0 && (
                                        <span
                                            aria-hidden="true"
                                            className="ml-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-caption font-bold leading-none text-white"
                                        >
                                            {badgeLabel(badge)}
                                        </span>
                                    )}
                                </button>
                            );
                        })}
                    </div>
                </Modal>
            )}
        </>
    );
};

const MemoizedBottomNavigation = memo(BottomNavigation);
export default MemoizedBottomNavigation;
