/**
 * Task status derivation — the ONE place the app turns a task's raw lifecycle fields into a
 * presentable status (key + StatusPill tone + label + glyph). Every surface (worker card,
 * manager table row, reports, daily statistics, the task form) renders status through this so
 * a task can never look different from one screen to the next.
 *
 * Two axes are deliberately kept separate, and so is their VOCABULARY (the overlap was the
 * confusion the founder flagged):
 *  - creation/approval gate: unapproved -> approved (a task that must be approved before work
 *    starts) — the "patvirtinimas" family ("Nepatvirtintas" / "Patvirtintas")
 *  - completion/acceptance axis: pending -> in-progress (running / paused) -> completed ->
 *    confirmed — the "priėmimas" family for the manager's sign-off:
 *      - completed  -> "Laukia priėmimo" (work finished, manager has not accepted it yet)
 *      - confirmed  -> "Priimtas"        (manager accepted the finished work)
 *
 * The `Icon` is the custom status glyph for the state (ADR 0010 §"Status circle"), keyed off
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
 * The lifecycle status a NEWLY CREATED task should carry, decided purely by WHO creates it and
 * FOR WHOM. Kept pure and separate from the create form so every create path agrees and the rule is
 * unit-locked:
 *  - a non-manager's task is 'unapproved' — it must clear the creation/approval gate before work
 *    starts (an auditor is notified by the caller);
 *  - a manager creating for someone else gets 'pending' — ready to start, the approval gate is moot;
 *  - a manager self-assigning gets 'approved' — a manager's OWN task is self-evidently approved, so
 *    it reads "Patvirtintas" at once and never asks the manager to approve their own work
 *    (founder, 2026-06-24). The caller additionally stamps isApproved/approvedBy/approvedAt so the
 *    stored shape matches what approveTask would have written.
 *
 * @param {{ isManagerOrAdmin: boolean, isSelfAssigned: boolean }} ctx
 * @returns {'unapproved'|'pending'|'approved'}
 */
export function resolveInitialTaskStatus({ isManagerOrAdmin, isSelfAssigned } = {}) {
    if (!isManagerOrAdmin) return 'unapproved';
    if (isSelfAssigned) return 'approved';
    return 'pending';
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
