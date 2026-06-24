import { doc, collection, setDoc } from 'firebase/firestore';
import { db } from '../../firebase';
import { logError } from '../../utils/errorLog';
import { defineCommand, MODES } from '../command';
import { isAgent } from '../actor';
import { parseTimeStringToMinutes } from '../../utils/timeUtils';
import { normalizePriority } from '../../utils/priority';

/**
 * createTask — the single, audited path for bringing a task into existence (ADR 0015, increment 3).
 *
 * Task creation was previously scattered across two drifting write sites — `createManagerTask`
 * (the manager-convenience / template / recurring path) and an inline `addDoc` in `TaskModal` —
 * which is the concrete duplication the AI-native analysis flagged. This command consolidates both:
 * the caller assembles the task fields (it still owns role-derived `status`/`taskAuditor` and any
 * attachment URLs), and `createTask` canonicalizes, writes the document, and records ONE decision —
 * so every task creation is attributable and an agent can "delegate work" through the same contract.
 *
 * The new document id is minted CLIENT-SIDE in `plan` (a local, write-free operation), so the audit
 * entry can carry the real `targetId` and the caller can read it back from `result.effect.taskId`.
 * `assignedUserName` is intentionally NOT persisted (read-derived everywhere else — see assignTask).
 *
 * Input:  { fields: <assembled task fields, incl. title/estimatedTime/assignedUserId/status/...> }
 * Effect: a new `tasks/{id}` document; one decision_log entry (before: null, after: {assignee,title,status}).
 */

const buildPlan = (input, actor) => {
  const fields = (input && input.fields) || {};
  // Mint a fresh, valid Firestore id locally — no network, no write — so the audit can name it.
  const id = doc(collection(db, 'tasks')).id;
  const nowIso = new Date().toISOString();
  const estimatedTime = fields.estimatedTime || '';

  const payload = {
    ...fields,
    title: (fields.title || '').trim() || 'Veikla',
    priority: normalizePriority(fields.priority),
    estimatedTime,
    estimatedTimeMinutes: parseTimeStringToMinutes(estimatedTime),
    assignedUserId: fields.assignedUserId || '',
    comments: Array.isArray(fields.comments) ? fields.comments : [],
    links: Array.isArray(fields.links) ? fields.links : [],
    checklist: Array.isArray(fields.checklist) ? fields.checklist : [],
    status: fields.status || 'pending',
    completed: fields.completed != null ? fields.completed : false,
    createdAt: fields.createdAt || nowIso,
    // The actor IS the creator — derive provenance from it, not from a caller-supplied field.
    createdBy: actor.id,
    creatorName: actor.name,
    assignedAt: fields.assignedAt || nowIso,
    updatedAt: nowIso,
  };
  // Never persist the read-derived display name (consistent with assignTask / the list loaders).
  delete payload.assignedUserName;

  return {
    targetId: id,
    summary: `Create task "${payload.title}"` +
             (payload.assignedUserId ? ` assigned to ${payload.assignedUserId}` : ' (unassigned)'),
    before: null,
    after: { assignedUserId: payload.assignedUserId, title: payload.title, status: payload.status },
    effect: { taskId: id },
    payload,
  };
};

export const createTask = defineCommand({
  name: 'createTask',
  targetType: 'task',
  authorize: (input, { actor, mode }) => {
    // Human-only boundary in code (mirrors assignTask): an AI agent may PROPOSE a task to create
    // but may not COMMIT one yet — agent-driven creation ships behind a propose→approve gate later.
    if (isAgent(actor) && mode === MODES.COMMIT) {
      return 'agent-commit-not-permitted: an AI agent may propose a task but not create it yet';
    }
    return true;
  },
  plan: (input, ctx) => buildPlan(input, ctx.actor),
  apply: async (planned) => {
    try {
      await setDoc(doc(db, 'tasks', planned.targetId), planned.payload);
    } catch (err) {
      logError(err, { source: 'commands.createTask' });
      throw err;
    }
  },
});

// Exposed for focused unit testing of the pure planning step.
export const __buildCreatePlan = buildPlan;
