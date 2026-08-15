import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Loading — one consistent treatment (DESIGN_SYSTEM §8). Use `Spinner` for a block of
 * content and `SkeletonRows` for tables/lists, instead of duplicating bare
 * "Kraunami duomenys..." strings per screen.
 */
export function Spinner({ className, label = 'Kraunama…' }) {
    return (
        <div className={cn('flex items-center justify-center gap-2 py-8 text-ink-muted', className)} role="status">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            <span className="text-body">{label}</span>
        </div>
    );
}

export function SkeletonRows({ rows = 3, className }) {
    return (
        <div className={cn('space-y-2', className)} aria-hidden="true">
            {Array.from({ length: rows }).map((_, i) => (
                <div key={i} className="h-12 animate-pulse rounded-card bg-surface-sunken" />
            ))}
        </div>
    );
}

export function CardSkeleton({ className, rows = 3 }) {
    return (
        <div className={cn('rounded-card border border-line bg-surface-card p-4 shadow-sm', className)} aria-hidden="true">
            <div className="flex items-center gap-2 mb-3">
                <div className="h-4 w-4 rounded-full bg-surface-sunken animate-pulse" />
                <div className="h-4 w-3/5 rounded bg-surface-sunken animate-pulse" />
            </div>
            <div className="space-y-2 mb-3">
                {Array.from({ length: rows }).map((_, i) => (
                    <div key={i} className="h-3 rounded bg-surface-sunken animate-pulse" style={{ width: `${85 - i * 15}%` }} />
                ))}
            </div>
            <div className="h-6 w-1/3 rounded bg-surface-sunken animate-pulse" />
        </div>
    );
}

export function StatSkeleton({ className }) {
    return (
        <div className={cn('rounded-control bg-surface-sunken p-3 text-center', className)} aria-hidden="true">
            <div className="h-3 w-16 mx-auto rounded bg-line animate-pulse mb-2" />
            <div className="h-6 w-12 mx-auto rounded bg-line animate-pulse" />
        </div>
    );
}

export default Spinner;
