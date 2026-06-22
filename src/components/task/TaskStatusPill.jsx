import { CheckCircle2 } from 'lucide-react';
import StatusPill from '../ui/StatusPill';
import { deriveTaskStatus } from '../../utils/taskStatus';

/**
 * TaskStatusPill — the ONLY way any surface renders a task's lifecycle/confirmation status.
 * Wraps the canonical <StatusPill> and drives its tone/label/icon from deriveTaskStatus, so a
 * "Vyksta" / "Pristabdyta" / "Nepatvirtinta" / "Patvirtinta" pill is byte-identical whether it
 * appears on a worker card, a manager table row, or the task form header.
 *
 * Deleted is rendered separately (<DeletedBadge>), not through here.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {boolean} [props.isRunning] - live timer truth; overrides stored status to "Vyksta"
 * @param {boolean} [props.justCompleted] - one-shot completion celebration (green + check)
 * @param {string} [props.className]
 */
export default function TaskStatusPill({ task, isRunning = false, justCompleted = false, className }) {
    const { tone, label, Icon } = deriveTaskStatus(task, { isRunning });
    return (
        <StatusPill
            tone={justCompleted ? 'success' : tone}
            icon={justCompleted ? CheckCircle2 : Icon}
            className={className}
        >
            {label}
        </StatusPill>
    );
}
