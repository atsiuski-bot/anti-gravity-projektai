import StatusPill from '../ui/StatusPill';
import { deriveTaskStatus } from '../../utils/taskStatus';
import { StatusConfirmedGlyph } from '../icons/statusGlyphs';

/**
 * TaskStatusPill — the ONLY way any surface renders a task's lifecycle/confirmation status.
 * Wraps the canonical <StatusPill> and drives its tone/label/glyph from deriveTaskStatus, so a
 * "Vyksta" / "Pristabdyta" / "Nepatvirtinta" / "Patvirtinta" pill is byte-identical whether it
 * appears on a worker card, a manager table row, or the task form header.
 *
 * The status glyph (ADR 0010) is always present now — the shape carries the state on every
 * surface (no per-surface opt-in), which is the whole point of the custom set. Deleted is
 * rendered separately (<DeletedBadge>), not through here.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {boolean} [props.isRunning] - live timer truth; overrides stored status to "Vyksta"
 * @param {boolean} [props.justCompleted] - one-shot completion celebration (green fill + check)
 * @param {string} [props.className]
 */
export default function TaskStatusPill({ task, isRunning = false, justCompleted = false, className }) {
    const { tone, label, Icon } = deriveTaskStatus(task, { isRunning });
    return (
        <StatusPill
            tone={justCompleted ? 'success' : tone}
            icon={justCompleted ? StatusConfirmedGlyph : Icon}
            className={className}
        >
            {label}
        </StatusPill>
    );
}
