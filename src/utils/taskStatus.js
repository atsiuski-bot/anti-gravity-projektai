/**
 * Task status derivation — the ONE place the app turns a task's raw lifecycle fields into a
 * presentable status (key + StatusPill tone + label + glyph). Every surface (worker card,
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
 * The `Icon` is the custom status glyph for the state (ADR 0007 §"Status circle"), keyed off
 * the canonical status key — so the SHAPE carries the state on every surface, not just the
 * pill color (running = green play, completed = green ring + check, confirmed = green fill +
 * white check, …). Glyphs live in one map (`STATUS_GLYPHS`); this is their only picker.
 *
 * `isDeleted` is intentionally NOT folded in here — deleted stays a separate signal rendered
 * by <DeletedBadge> + a struck-through title (product decision 2026-06-22), so this helper
 * only ever describes the live lifecycle/approval state.
 */
import { STATUS_LABELS } from './taskConstants';
import { STATUS_GLYPHS } from '../components/icons/statusGlyphMap';

/**
 * @param {Object} task - the task record
 * @param {Object} [opts]
 * @param {boolean} [opts.isRunning] - live timer truth (from useIsTaskRunning). When true it
 *   overrides the stored status so a running task always reads "Vyksta".
 * @returns {{ key: string, tone: string, label: string, Icon: (import('react').ComponentType|null) }}
 *   key   — canonical status key for branching (running | paused | pending | completed | confirmed | unapproved | approved)
 *   tone  — a StatusPill tone
 *   label — the Lithuanian pill label
 *   Icon  — the custom status glyph for the state
 */
export function deriveTaskStatus(task, { isRunning = false } = {}) {
    const status = task?.status || 'pending';

    // Finished work: the confirmation axis. Confirmed reads as a positive (green) signal,
    // unconfirmed stays calm/muted so a worker's done card doesn't shout.
    if (status === 'confirmed') {
        return { key: 'confirmed', tone: 'success', label: STATUS_LABELS.confirmed, Icon: STATUS_GLYPHS.confirmed };
    }
    if (status === 'completed') {
        return { key: 'completed', tone: 'done', label: STATUS_LABELS.completed, Icon: STATUS_GLYPHS.completed };
    }

    // Approval gate.
    if (status === 'approved') {
        return { key: 'approved', tone: 'success', label: STATUS_LABELS.approved, Icon: STATUS_GLYPHS.approved };
    }
    if (status === 'unapproved') {
        return { key: 'unapproved', tone: 'pending', label: STATUS_LABELS.unapproved, Icon: STATUS_GLYPHS.unapproved };
    }

    // Live timer overrides the stored status — running beats everything below.
    if (isRunning) {
        return { key: 'running', tone: 'running', label: 'Vyksta', Icon: STATUS_GLYPHS.running };
    }

    // Started but not running -> paused.
    if (status === 'in-progress' || task?.timerStatus === 'paused') {
        return { key: 'paused', tone: 'neutral', label: 'Pristabdyta', Icon: STATUS_GLYPHS.paused };
    }

    // Never started.
    return { key: 'pending', tone: 'neutral', label: 'Nepradėtas', Icon: STATUS_GLYPHS.pending };
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
