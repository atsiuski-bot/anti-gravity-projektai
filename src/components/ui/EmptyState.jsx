import { cn } from '../../utils/cn';

/**
 * EmptyState — icon + one line of what belongs here + one actionable next step
 * (DESIGN_SYSTEM §8). Pass an `action` (e.g. a <Button>) so an empty surface always
 * points the user forward instead of dead-ending.
 */
export default function EmptyState({ icon: Icon, title, description, action, className }) {
    return (
        <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
            {Icon && (
                <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-sunken">
                    <Icon className="h-6 w-6 text-ink-muted" aria-hidden="true" />
                </div>
            )}
            {title && <p className="text-body-lg font-semibold text-ink-strong">{title}</p>}
            {description && <p className="mt-1 text-body text-ink-muted">{description}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}
