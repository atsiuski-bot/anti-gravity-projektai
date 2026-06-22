import { memo, useMemo, useState, Fragment } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigation } from '../context/NavigationContext';
import { isManagerRole } from '../utils/formatters';
import { getNavSections } from '../config/navTabs';
import { Plus, MoreHorizontal } from 'lucide-react';
import BreakTimer from './BreakTimer';
import CallTimer from './CallTimer';
import QuickWorkTimer from './QuickWorkTimer';
import ActiveSessionReadout from './ActiveSessionReadout';
import Modal from './ui/Modal';
import { cn } from '../utils/cn';

const navItemBase =
    'flex flex-col items-center justify-center rounded-control transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-inset';

const BottomNavigation = () => {
    const { userRole, currentUser } = useAuth();
    const { activeTab, setActiveTab } = useNavigation();
    const [moreOpen, setMoreOpen] = useState(false);

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

    const showCreateButton = (userRole === 'worker') || isManagerRole(userRole);

    const handleTab = (id) => {
        setActiveTab(id);
        setMoreOpen(false);
    };

    if (!currentUser) return null;

    const CreateButton = () => (
        <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-task-modal'))}
            aria-label="Sukurti užduotį"
            className="flex flex-col items-center justify-center min-h-touch min-w-touch rounded-control text-brand transition-colors hover:bg-brand-soft active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
        >
            <div className="mb-1 rounded-control bg-brand-soft p-1.5">
                <Plus className="w-5 h-5" aria-hidden="true" />
            </div>
            <span className="text-caption font-bold uppercase leading-none tracking-wide">Sukurti</span>
        </button>
    );

    return (
        <>
            {/* Work-controls floating pill (visible on all screens). Sits a fixed gap above the
                main bar and clears the safe-area inset so both move together (DESIGN_SYSTEM §9). */}
            <div
                className="fixed left-0 right-0 z-nav flex w-full flex-col items-center gap-2 px-3 pb-2 pointer-events-none"
                style={{ bottom: 'calc(64px + env(safe-area-inset-bottom))' }}
            >
                <ActiveSessionReadout />

                <div className="pointer-events-auto flex w-full max-w-md items-center justify-between gap-2 rounded-card border border-line bg-surface-card/95 px-3 py-1.5 shadow-lg backdrop-blur-sm">
                    {showCreateButton && (
                        <div className="flex flex-shrink-0 items-center gap-2">
                            <CreateButton />
                            <div className="h-8 w-px bg-surface-sunken" />
                        </div>
                    )}

                    <QuickWorkTimer compact={true} />
                    <CallTimer compact={true} />
                    <BreakTimer currentUser={currentUser} compact={true} />
                </div>
            </div>

            {/* Main bottom bar */}
            <div className="fixed bottom-0 left-0 right-0 z-nav border-t border-line bg-surface-card pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.1)]">
                <div className="relative mx-auto flex h-16 max-w-7xl items-center justify-between gap-2 px-2">
                    {/* Tablet (sm..lg): full tab set, centered, a thin separator between groups */}
                    <div className="hidden flex-1 items-center justify-center gap-2 sm:flex">
                        {sections.map((section, si) => (
                            <Fragment key={section.id}>
                                {si > 0 && <div className="mx-3 h-10 w-px bg-surface-sunken" />}
                                {section.items.map((tab) => {
                                    const active = activeTab === tab.id;
                                    return (
                                        <button
                                            key={tab.id}
                                            onClick={() => handleTab(tab.id)}
                                            aria-current={active ? 'page' : undefined}
                                            className={cn(
                                                navItemBase,
                                                'min-w-[90px] px-4 py-2.5 hover:bg-surface-sunken',
                                                active ? 'bg-brand-soft text-brand' : 'text-ink-muted'
                                            )}
                                        >
                                            <tab.icon className="mb-1.5 h-6 w-6" aria-hidden="true" />
                                            <span className="whitespace-nowrap text-caption font-medium leading-tight">
                                                {tab.label}
                                            </span>
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
                                        'min-h-touch flex-1 px-0.5 py-1',
                                        active ? 'text-brand' : 'text-ink-muted'
                                    )}
                                >
                                    <tab.icon className="mb-0.5 h-5 w-5" aria-hidden="true" />
                                    <span className="line-clamp-2 text-center text-caption font-medium leading-tight">
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
                                className={cn(
                                    navItemBase,
                                    'min-h-touch flex-1 px-0.5 py-1',
                                    overflowActive ? 'text-brand' : 'text-ink-muted'
                                )}
                            >
                                <MoreHorizontal className="mb-0.5 h-5 w-5" aria-hidden="true" />
                                <span className="text-center text-caption font-medium leading-tight">Daugiau</span>
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
                            return (
                                <button
                                    key={tab.id}
                                    onClick={() => handleTab(tab.id)}
                                    aria-current={active ? 'page' : undefined}
                                    className={cn(
                                        'flex min-h-touch items-center gap-3 rounded-control px-3 text-body font-medium transition-colors',
                                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand',
                                        active ? 'bg-brand-soft text-brand-hover' : 'text-ink hover:bg-surface-sunken'
                                    )}
                                >
                                    <tab.icon className="h-5 w-5" aria-hidden="true" />
                                    <span>{tab.label}</span>
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
