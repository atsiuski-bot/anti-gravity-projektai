/**
 * Task status derivation — the ONE place the app turns a task's raw lifecycle fields into a
 * presentable status (key + StatusPill tone + label + icon). Every surface (worker card,
 * manager table row, reports, daily statistics, the task form) renders status through this so
 * a task can never look different from one screen to the next.
 *
 * Two axes are deliberately kept separate:
 *  - lifecycle: pending -> in-progress (running / paused) -> completed -> confirmed
 *  - approval gate: unapproved -> approved (a task that must be approved before work starts)
 *
 * The manager-confirmation axis is what the founder asked to surface everywhere:
 *  - completed  -> "Nepatvirtinta" (work finished, manager has not confirmed)
 *  - confirmed  -> "Patvirtinta"   (manager confirmed the finished work)
 *
 * `isDeleted` is intentionally NOT folded in here — deleted stays a separate signal rendered
 * by <DeletedBadge> + a struck-through title (product decision 2026-06-22), so this helper
 * only ever describes the live lifecycle/approval state.
 */
import { Pause } from 'lucide-react';
import { STATUS_LABELS } from './taskConstants';

/**
 * @param {Object} task - the task record
 * @param {Object} [opts]
 * @param {boolean} [opts.isRunning] - live timer truth (from useIsTaskRunning). When true it
 *   overrides the stored status so a running task always reads "Vyksta".
 * @returns {{ key: string, tone: string, label: string, Icon: (import('react').ComponentType|null) }}
 *   key   — canonical status key for branching (running | paused | pending | completed | confirmed | unapproved | approved)
 *   tone  — a StatusPill tone
 *   label — the Lithuanian pill label
 *   Icon  — an optional lucide icon component (or null)
 */
export function deriveTaskStatus(task, { isRunning = false } = {}) {
    const status = task?.status || 'pending';

    // Finished work: the confirmation axis. Confirmed reads as a positive (green) signal,
    // unconfirmed stays calm/muted so a worker's done card doesn't shout.
    if (status === 'confirmed') {
        return { key: 'confirmed', tone: 'success', label: STATUS_LABELS.confirmed, Icon: null };
    }
    if (status === 'completed') {
        return { key: 'completed', tone: 'done', label: STATUS_LABELS.completed, Icon: null };
    }

    // Approval gate.
    if (status === 'approved') {
        return { key: 'approved', tone: 'success', label: STATUS_LABELS.approved, Icon: null };
    }
    if (status === 'unapproved') {
        return { key: 'unapproved', tone: 'pending', label: STATUS_LABELS.unapproved, Icon: null };
    }

    // Live timer overrides the stored status — running beats everything below.
    if (isRunning) {
        return { key: 'running', tone: 'running', label: 'Vyksta', Icon: null };
    }

    // Started but not running -> paused.
    if (status === 'in-progress' || task?.timerStatus === 'paused') {
        return { key: 'paused', tone: 'neutral', label: 'Pristabdyta', Icon: Pause };
    }

    // Never started.
    return { key: 'pending', tone: 'neutral', label: 'Nepradėtas', Icon: null };
}

/**
 * Confirmation-only descriptor for finished-work surfaces (daily statistics, reports) that
 * track the manager-confirmation toggle rather than the full lifecycle. Mirrors the
 * completed/confirmed labels above so on-screen copy and exports never disagree.
 *
 * @param {Object} task
 * @returns {{ confirmed: boolean, tone: string, label: string }}
 */
export function deriveConfirmation(task) {
    const confirmed = task?.status === 'confirmed';
    return {
        confirmed,
        tone: confirmed ? 'success' : 'pending',
        label: confirmed ? STATUS_LABELS.confirmed : STATUS_LABELS.completed,
    };
}
