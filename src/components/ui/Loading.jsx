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

export default Spinner;
