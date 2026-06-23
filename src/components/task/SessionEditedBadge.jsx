import { Pencil } from 'lucide-react';
import { cn } from '../../utils/cn';
import { formatMinutesToTimeString } from '../../utils/timeUtils';
import { formatTime, formatDisplayName } from '../../utils/formatters';

/**
 * SessionEditedBadge — the inline disclosure shown on a timeline row whose start/end an admin
 * corrected (the session-grain sibling of TimeChangedWarning, which discloses task-total edits).
 * Renders the original interval → the current one plus the (mandatory) reason and who made it, so
 * a payable-time edit is never silent. Reads the snapshot fields editWorkSession() stamps:
 * `edited`, `originalStartTime`, `originalEndTime`, `originalDurationMinutes`, `editReason`,
 * `editedByName`.
 *
 * Renders nothing when the row was never edited.
 *
 * @param {Object} props
 * @param {Object} props.item - a timeline item carrying the edit-snapshot fields.
 * @param {string} [props.className]
 */
export default function SessionEditedBadge({ item, className }) {
    if (!item?.edited) return null;
    const hasOriginal = !!item.originalStartTime && !!item.originalEndTime;
    return (
        <div className={cn('mt-0.5', className)}>
            <span className="inline-flex items-center gap-1 text-brand-hover font-bold text-caption uppercase tracking-wide">
                <Pencil className="w-3 h-3" aria-hidden="true" /> Redaguota
            </span>
            {hasOriginal && (
                <div className="text-caption text-ink-muted font-sans normal-case font-normal">
                    {formatTime(item.originalStartTime)}–{formatTime(item.originalEndTime)}
                    {Number.isFinite(item.originalDurationMinutes) && (
                        <> ({formatMinutesToTimeString(item.originalDurationMinutes)})</>
                    )}
                    {' → '}
                    {formatTime(item.startTime)}–{formatTime(item.endTime)}
                </div>
            )}
            {item.editReason && (
                <div className="text-caption text-ink-muted font-sans normal-case font-normal italic break-words">
                    „{item.editReason}“{item.editedByName ? ` — ${formatDisplayName(item.editedByName)}` : ''}
                </div>
            )}
        </div>
    );
}
