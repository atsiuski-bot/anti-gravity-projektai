import { useId } from 'react';
import { ChevronDown } from 'lucide-react';
import clsx from 'clsx';

/**
 * Collapsible statistics group ("harmonika"). Collapsed by default; the PARENT owns `open` so it
 * can keep several open at once and lazily mount the (heavier) rows only after first expand.
 * Accessible disclosure: a button[aria-expanded] toggles a region[aria-labelledby].
 */
export default function StatGroup({ title, open, onToggle, children }) {
    const panelId = useId();
    const btnId = useId();
    return (
        <div className="overflow-hidden rounded-control border border-line bg-surface-card">
            <button
                id={btnId}
                type="button"
                onClick={onToggle}
                aria-expanded={open}
                aria-controls={panelId}
                className={clsx(
                    'flex w-full items-center justify-between gap-3 px-4 py-3 text-left min-h-touch',
                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand',
                    open ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'
                )}
            >
                <span className="text-body font-semibold text-ink-strong">{title}</span>
                <ChevronDown
                    className={clsx(
                        'h-4 w-4 shrink-0 text-ink-muted transition-transform duration-fast',
                        open && 'rotate-180'
                    )}
                    aria-hidden="true"
                />
            </button>
            {open && (
                <div id={panelId} role="region" aria-labelledby={btnId} className="divide-y divide-line border-t border-line px-4">
                    {children}
                </div>
            )}
        </div>
    );
}
