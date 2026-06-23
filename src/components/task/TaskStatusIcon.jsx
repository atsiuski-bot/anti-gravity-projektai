import { cn } from '../../utils/cn';
import { deriveTaskStatus } from '../../utils/taskStatus';

/**
 * STATUS_ICON_TONE — text color for the standalone leading status glyph, mirroring StatusPill's
 * tone→text-color map. The finished/running/awaiting glyphs are self-colored (green/amber baked
 * in), so the tone here only actually paints the monochrome pending/paused shapes — but keeping
 * the full map means a tone change can never silently fall back to ink.
 */
const STATUS_ICON_TONE = {
    neutral: 'text-ink',
    pending: 'text-feedback-warning-text',
    running: 'text-feedback-success-text',
    done: 'text-ink-muted',
    success: 'text-feedback-success-text',
    info: 'text-feedback-info-text',
    danger: 'text-feedback-danger-text',
};

/**
 * TaskStatusIcon — the standalone leading status glyph shown to the LEFT of a task title (the
 * worker card AND the manager desktop list), so the SHAPE carries the lifecycle/approval state at
 * a glance while scanning titles, exactly like the mobile card. It is the title-row sibling of
 * <TaskStatusPill> — same single source (deriveTaskStatus) — minus the pill chrome and word.
 *
 * Deleted is a SEPARATE axis (DeletedBadge + a struck-through title), so a deleted task renders no
 * lifecycle glyph here: this returns null for deleted (and for any state without a glyph).
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {boolean} [props.isRunning] - live timer truth; overrides stored status to "Vyksta"
 * @param {boolean} [props.animate] - one-shot completion pop (wz-pop)
 * @param {'sm'|'md'} [props.size] - glyph size: sm (16px, dense desktop rows), md (20px, cards)
 * @param {boolean} [props.decorative] - drop the sr-only label when a labelled status is already
 *   announced in the same row (the desktop "Būsena" pill), so a screen reader hears it once.
 * @param {string} [props.className]
 */
export default function TaskStatusIcon({
    task,
    isRunning = false,
    animate = false,
    size = 'md',
    decorative = false,
    className,
}) {
    const { Icon, tone, label } = deriveTaskStatus(task, { isRunning });
    if (task?.isDeleted || !Icon) return null;
    return (
        <span className={cn('inline-flex shrink-0', animate && 'wz-pop', className)} title={label}>
            <Icon
                className={cn(size === 'sm' ? 'h-4 w-4' : 'h-5 w-5', STATUS_ICON_TONE[tone] || STATUS_ICON_TONE.neutral)}
                aria-hidden="true"
            />
            {!decorative && <span className="sr-only">{label}</span>}
        </span>
    );
}
