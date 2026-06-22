import { cn } from '../../utils/cn';

/**
 * DeletedBadge — the one "Ištrinta" marker. Deleted is deliberately kept as a separate signal
 * (product decision 2026-06-22) rather than folded into the status pill, so it is rendered the
 * same red badge everywhere and always paired with a struck-through title (color is never the
 * sole signal — §5). Surfaces gate it on `task.isDeleted || task.status === 'deleted'`.
 *
 * @param {Object} props
 * @param {boolean} [props.inline] - true for an inline-after-title badge (align-middle, no underline)
 * @param {string} [props.className]
 */
export default function DeletedBadge({ inline = false, className }) {
    return (
        <span
            className={cn(
                'inline-block px-1.5 py-0.5 text-caption font-bold uppercase rounded',
                'bg-feedback-danger/10 text-feedback-danger border border-feedback-danger/20',
                inline && 'align-middle no-underline',
                className
            )}
        >
            Ištrinta
        </span>
    );
}
