// Pure half of the suggestTimeCorrection callable (functions/index.js): clamp an AI proposal to what
// the caller supplied, so a hallucinated row, task or time can never reach the worker's confirm step.
// Kept out of index.js so it is unit-testable without loading the function runtime.
'use strict';

const CORRECTION_KINDS = ['missed_start', 'missed_stop', 'wrong_time', 'break_was_work', 'other'];
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/;

// Clamp a model proposal to what the caller supplied. Pure; exported for the unit test.
function sanitizeCorrectionSuggestion(parsed, rows, tasks) {
    const p = parsed && typeof parsed === 'object' ? parsed : {};
    let kind = CORRECTION_KINDS.includes(p.kind) ? p.kind : 'other';
    const row = rows.find((r) => r.id === p.rowId) || null;
    const taskId = tasks.some((t) => t.id === p.taskId) ? p.taskId : '';
    const start = HHMM.test(String(p.start)) ? p.start : '';
    const end = HHMM.test(String(p.end)) ? p.end : '';
    const summary = typeof p.summary === 'string' ? p.summary.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    // Each kind needs its own anchor; a proposal without it has nothing to apply.
    if (kind === 'missed_start' && !(start && end)) kind = 'other';
    if ((kind === 'missed_stop' || kind === 'wrong_time') && !(row && row.type === 'work' && end)) kind = 'other';
    if (kind === 'break_was_work' && !(row && row.type === 'break')) kind = 'other';
    if (kind === 'other') return { kind, rowId: '', taskId: '', start: '', end: '', summary };
    return {
        kind,
        rowId: kind === 'missed_start' ? '' : row.id,
        taskId: kind === 'missed_start' || kind === 'break_was_work' ? taskId : '',
        start: start || (row ? row.start : ''),
        end: end || (row ? row.end : ''),
        summary,
    };
}

module.exports = { CORRECTION_KINDS, HHMM, sanitizeCorrectionSuggestion };
