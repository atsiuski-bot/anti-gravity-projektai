import { useUsers } from '../../context/UsersContext';
import { cn } from '../../utils/cn';
import UserChip from '../UserChip';

/**
 * AcceptedByChip — "Priėmė <manager>" on an accepted (status 'confirmed') task, so everyone can see
 * at a glance, without opening the task, WHICH manager accepted the finished work. Acceptance is the
 * COMPLETION gate (priėmimas), not the creation gate (patvirtinimas / approvedBy) — the two must never
 * be mixed, so this reads only `confirmedBy` (+ `confirmedAt` for the hover time).
 *
 * Renders nothing for a task that is not accepted, or whose `confirmedBy` does not resolve to a known
 * user (legacy rows written before the audited confirmTask command) — an empty pill would say less
 * than no pill.
 *
 * @param {Object} props
 * @param {Object} props.task
 * @param {string} [props.className]
 */
export default function AcceptedByChip({ task, className }) {
    const { usersMap } = useUsers();
    const uid = task?.status === 'confirmed' ? task.confirmedBy : null;
    if (!uid || typeof uid !== 'string' || !usersMap?.[uid]) return null;

    const at = task.confirmedAt ? new Date(task.confirmedAt) : null;
    const when = at && !Number.isNaN(at.getTime()) ? at.toLocaleString('lt-LT') : null;

    return (
        <span
            className={cn('inline-flex items-center whitespace-nowrap text-caption text-feedback-success-text font-medium', className)}
            title={when ? `Priimta ${when}` : undefined}
        >
            Priėmė <UserChip userId={uid} className="ml-1" />
        </span>
    );
}
