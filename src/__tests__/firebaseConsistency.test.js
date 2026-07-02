/**
 * Firebase consistency gate — repo-internal invariants between the client, the Cloud Functions,
 * and the security rules.
 *
 * WHY THIS EXISTS
 * Functions and rules are deployed by hand, sometimes from feature branches, last-write-wins, with
 * no version guard (CLAUDE.md → deploy is a blind disk→cloud overwrite of the one shared project).
 * The risk is DRIFT: a callable the client invokes but no function implements; a collection a
 * function writes that the rules forgot to permit; or — the most insidious — one of the several
 * pieces of logic the Cloud Functions HAND-COPY from the client ("MIRROR … keep in lockstep")
 * silently diverging because nothing links the two copies.
 *
 * This test runs in the standard `npm test` gate, so it fails the ship BEFORE any deploy. It is the
 * "before" half of the safety net; the "after" half is `/firebase-status`, which diffs what is
 * actually LIVE against this same repo via the Firebase MCP (live functions + live rules).
 *
 * It deliberately reads the OTHER surfaces (functions/index.js, firestore.rules, TaskModal.jsx) as
 * TEXT rather than importing them — functions/index.js calls initializeApp() and pulls
 * firebase-admin/firebase-functions, which are not installed in the app's node_modules, and the
 * rules are not JS at all. Text + a small amount of extraction is the robust, dependency-free way
 * to compare across the three runtimes.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { PRIORITIES, getPriorityLabel } from '../utils/priority.js';
import { MAX_SESSION_MINUTES, getLithuanianDateString, parseTimeStringToMinutes } from '../utils/timeUtils.js';
import { recurrenceFiresOn } from '../utils/recurrence.js';
import { NOTIFICATIONS, notificationCopy, notificationCategory, notificationLink } from '../notifications/registry.js';
import { ON_TIME_GRACE_MIN } from '../utils/workerStats.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // src/__tests__ -> repo root
const SRC = resolve(ROOT, 'src');

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

const FUNCTIONS_SRC = read('functions/index.js');
const RULES_SRC = read('firestore.rules');
const TASK_MODAL_SRC = read('src/components/TaskModal.jsx');
const SESSION_ACTIONS_SRC = read('src/utils/sessionActions.js');

// --- small extraction helpers ---------------------------------------------------------------

// Every single/double-quoted token inside a chunk of source, in order.
function quotedTokens(chunk) {
  const out = [];
  const re = /['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(chunk)) !== null) out.push(m[1]);
  return out;
}

// The contents of `NAME = [ ... ]` (a literal array assignment) as an ordered list of strings.
function extractArrayLiteral(src, name) {
  const re = new RegExp(`${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`);
  const m = src.match(re);
  if (!m) throw new Error(`Could not find array literal "${name}" — did it move or get renamed?`);
  return quotedTokens(m[1]);
}

// Recursively list every .js/.jsx file under a directory.
function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      files.push(...walk(full));
    } else if (/\.(js|jsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

// =============================================================================================
// 1. CALLABLE PARITY — every client httpsCallable target has a server onCall implementation.
//    A missing one means a button in the app calls a function that does not exist in prod.
// =============================================================================================

describe('callable parity (client httpsCallable ↔ server onCall)', () => {
  // Names the client invokes through the real httpsCallable(functions, '<name>') call sites.
  // Test files are excluded — they are not production call sites (and this very file mentions the
  // pattern in its comments, which would otherwise scan itself).
  const clientCallables = new Set();
  for (const file of walk(SRC)) {
    if (/\.test\.(js|jsx)$/.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const re = /httpsCallable\s*\(\s*[^,]+,\s*['"]([^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(text)) !== null) clientCallables.add(m[1]);
  }

  // Names the Cloud Functions module exports as callables.
  const serverCallables = new Set();
  {
    const re = /exports\.(\w+)\s*=\s*onCall\b/g;
    let m;
    while ((m = re.exec(FUNCTIONS_SRC)) !== null) serverCallables.add(m[1]);
  }

  it('found the known callables on both sides (extraction sanity)', () => {
    // Guards the regexes themselves: if these ever read empty, the parity assertion below would
    // pass vacuously. parseTaskDraft + runRecurringTasksNow are the two the client invokes today.
    expect(clientCallables.size).toBeGreaterThan(0);
    expect(serverCallables.size).toBeGreaterThan(0);
    expect(serverCallables.has('parseTaskDraft')).toBe(true);
    expect(serverCallables.has('runRecurringTasksNow')).toBe(true);
  });

  it('every client-invoked callable is implemented server-side', () => {
    const missing = [...clientCallables].filter((name) => !serverCallables.has(name));
    expect(missing, `Client calls these but no Cloud Function implements them: ${missing.join(', ')}`)
      .toEqual([]);
  });
});

// =============================================================================================
// 2. RULES COVERAGE — every collection a Cloud Function trigger watches has a security-rules
//    match block. Functions use the admin SDK (bypassing rules) so a missing block does not break
//    the function itself, but it almost always means the CLIENT path for that collection is
//    default-denied — the "forgot the rule for a new collection" foot-gun.
// =============================================================================================

describe('rules coverage (function trigger collections ↔ firestore.rules match blocks)', () => {
  const triggerCollections = new Set();
  {
    const re = /onDocument(?:Created|Updated|Deleted|Written)\(\s*['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(FUNCTIONS_SRC)) !== null) {
      triggerCollections.add(m[1].split('/')[0]); // top-level collection of the trigger path
    }
  }

  it('found trigger collections (extraction sanity)', () => {
    expect(triggerCollections.size).toBeGreaterThan(0);
    expect(triggerCollections.has('tasks')).toBe(true);
  });

  it('every trigger collection has a rules match block', () => {
    const uncovered = [...triggerCollections].filter(
      (col) => !RULES_SRC.includes(`match /${col}/{`)
    );
    expect(uncovered, `Function triggers write these collections but firestore.rules has no match block: ${uncovered.join(', ')}`)
      .toEqual([]);
  });
});

// =============================================================================================
// 3. PRIORITY ENUM LOCKSTEP — the canonical priority tokens are defined in THREE places: the
//    client (priority.js PRIORITIES), the Cloud Function (RECURRING_PRIORITIES, used by the
//    recurring generator + AI parser) and the security rules (taskFieldsOk validation). If they
//    diverge, a value one side considers valid is rejected/normalized differently by another —
//    exactly the casing split that already happened once in the live data.
// =============================================================================================

describe('priority enum lockstep (client ↔ functions ↔ rules)', () => {
  const client = Object.keys(PRIORITIES).sort();
  const functions = extractArrayLiteral(FUNCTIONS_SRC, 'RECURRING_PRIORITIES').sort();

  // The rules array lives inside taskFieldsOk: `data.priority in ['URGENT', 'HIGH', ...]`.
  const rulesMatch = RULES_SRC.match(/data\.priority in \[([^\]]*)\]/);
  const rules = rulesMatch ? quotedTokens(rulesMatch[1]).sort() : null;

  it('client PRIORITIES === functions RECURRING_PRIORITIES', () => {
    expect(functions).toEqual(client);
  });

  it('client PRIORITIES === rules taskFieldsOk allow-list', () => {
    expect(rules, 'Could not find the priority allow-list inside firestore.rules taskFieldsOk').not.toBeNull();
    expect(rules).toEqual(client);
  });
});

// =============================================================================================
// 4. ESTIMATE-TIME SCALE LOCKSTEP — the Cloud Function clamps a model's time guess to ESTIMATE_SCALE
//    so it always lands on a real chip; that scale is a hand-copy of ALL_TIMES in the TaskModal. A
//    drift here makes the AI parser emit a time the UI cannot render (or silently drop it).
// =============================================================================================

describe('estimate-time scale lockstep (functions ESTIMATE_SCALE ↔ client ALL_TIMES)', () => {
  const functions = extractArrayLiteral(FUNCTIONS_SRC, 'ESTIMATE_SCALE');
  const client = extractArrayLiteral(TASK_MODAL_SRC, 'ALL_TIMES');

  it('the two arrays are identical (same values, same order)', () => {
    expect(functions).toEqual(client);
  });
});

// =============================================================================================
// 5. TIMER CEILING LOCKSTEP — the integrity scan auto-stops a timer left running past
//    MAX_RUNNING_TIMER_MINUTES, which is the server MIRROR of the client clamp MAX_SESSION_MINUTES.
//    If the client clamp is raised but the server ceiling is not (or vice versa), the auto-stop
//    either clips legitimate long runs or stops catching forgotten timers.
// =============================================================================================

describe('timer ceiling lockstep (functions MAX_RUNNING_TIMER_MINUTES ↔ client MAX_SESSION_MINUTES)', () => {
  it('the server auto-stop ceiling equals the client session clamp', () => {
    const m = FUNCTIONS_SRC.match(/MAX_RUNNING_TIMER_MINUTES\s*=\s*(\d+)\s*\*\s*(\d+)/);
    expect(m, 'Could not find MAX_RUNNING_TIMER_MINUTES in functions/index.js').not.toBeNull();
    const serverCeiling = Number(m[1]) * Number(m[2]);
    expect(serverCeiling).toBe(MAX_SESSION_MINUTES);
  });
});

// =============================================================================================
// 6. RECURRENCE FIRING LOCKSTEP — the scheduled generator decides which days a recurring template
//    fires using recurringFiresOn, a textual MIRROR of the client's recurrenceFiresOn. A divergence
//    means the preview the manager sees and the tasks the server actually generates disagree. We
//    extract the server's three pure helpers, evaluate them in isolation, and assert they produce
//    the SAME answer as the client copy across a battery of cadences and edge dates.
// =============================================================================================

describe('recurrence firing lockstep (functions recurringFiresOn ↔ client recurrenceFiresOn)', () => {
  // Slice out the three self-contained helpers (recurringIsoWeekday, recurringDaysInMonth,
  // recurringFiresOn) and build the server's firing function from them. If the markers move, this
  // throws a clear message — that is intended: it forces the test to be updated alongside the code.
  function buildServerFiresOn() {
    const start = FUNCTIONS_SRC.indexOf('function recurringIsoWeekday');
    const end = FUNCTIONS_SRC.indexOf('async function isUserAbsentOn');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Could not slice the recurring helpers out of functions/index.js — markers moved; update this test.');
    }
    const block = FUNCTIONS_SRC.slice(start, end);
    return new Function(`${block}\n;return recurringFiresOn;`)();
  }

  const serverFiresOn = buildServerFiresOn();

  const recurrences = [
    { active: true, freq: 'daily' },
    { active: false, freq: 'daily' },
    { active: true, freq: 'weekly', byWeekday: [1] },
    { active: true, freq: 'weekly', byWeekday: [6, 7] },
    { active: true, freq: 'weekly', byWeekday: [] },
    { active: true, freq: 'weekly', byWeekday: [1], interval: 2, anchorDate: '2026-02-16' },  // bi-weekly, on-phase
    { active: true, freq: 'weekly', byWeekday: [1], interval: 2, anchorDate: '2026-02-09' },  // bi-weekly, off-phase
    { active: true, freq: 'weekly', byWeekday: [1, 6], interval: 4, anchorDate: '2026-02-16' }, // every 4 weeks
    { active: true, freq: 'weekly', byWeekday: [1], interval: 2 },                            // interval w/o anchor → weekly
    { active: true, freq: 'weekly', byWeekday: [1], interval: 1, anchorDate: '2026-02-16' },  // interval 1 → weekly
    { active: true, freq: 'monthly', byMonthDay: 1 },
    { active: true, freq: 'monthly', byMonthDay: 31 },     // clamps in short months
    { active: true, freq: 'monthly', byMonthDay: 29 },     // Feb leap-year edge
    { active: true, freq: 'daily', skipDates: ['2026-02-16'] },
    { active: true, freq: 'unknown-future-freq' },         // unsupported → both return false
    null,
  ];

  const dates = [
    '2026-02-16', // Monday
    '2026-02-21', // Saturday
    '2026-02-22', // Sunday
    '2026-01-31', // 31st of a 31-day month
    '2026-02-28', // last day of a non-leap February
    '2024-02-29', // leap day
    '2026-03-01',
  ];

  it('server and client agree on every (recurrence × date) combination', () => {
    const disagreements = [];
    for (const rec of recurrences) {
      for (const date of dates) {
        const client = recurrenceFiresOn(rec, date);
        const server = serverFiresOn(rec, date);
        if (client !== server) {
          disagreements.push(`${JSON.stringify(rec)} @ ${date}: client=${client} server=${server}`);
        }
      }
    }
    expect(disagreements, `recurrence copies diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// 7. NOTIFICATION COPY LOCKSTEP — the Cloud Function copyForRequestNotification is a hand-copied
//    MIRROR of the client notification registry (src/notifications/registry.js). The copy strings
//    live on both sides of the deploy boundary with nothing linking them, and they HAD already
//    drifted (task_confirmed said "priimta" in the toast but "patvirtinta" in the push). We slice the
//    server function out, evaluate it in isolation, and assert it returns the SAME { title, body } as
//    the registry for every type across representative payloads — AND that the two cover the same set
//    of types (no type the push knows but the in-app feed doesn't, or vice versa).
// =============================================================================================

describe('notification copy lockstep (functions copyForRequestNotification ↔ client registry)', () => {
  // Slice the self-contained copy function out of functions/index.js and build it. It references only
  // its argument and built-ins, so it evaluates with no dependencies. Moved markers throw clearly.
  function buildServerCopy() {
    const start = FUNCTIONS_SRC.indexOf('function copyForRequestNotification');
    const end = FUNCTIONS_SRC.indexOf('exports.notifyOnRequestNotification');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Could not slice copyForRequestNotification out of functions/index.js — markers moved; update this test.');
    }
    const block = FUNCTIONS_SRC.slice(start, end);
    return new Function(`${block}\n;return copyForRequestNotification;`)();
  }

  const serverCopy = buildServerCopy();

  // The server's switch cases — the set of types the push copy knows how to render.
  const serverTypes = (() => {
    const start = FUNCTIONS_SRC.indexOf('function copyForRequestNotification');
    const end = FUNCTIONS_SRC.indexOf('exports.notifyOnRequestNotification');
    const block = FUNCTIONS_SRC.slice(start, end);
    const out = new Set();
    const re = /case\s+'([^']+)'/g;
    let m;
    while ((m = re.exec(block)) !== null) out.add(m[1]);
    return out;
  })();

  // Representative payload(s) per type — branchy types (calendar_decision, the comment-bearing ones)
  // get several so both branches are compared. EVERY registry type must have an entry here, so a new
  // type can't be added without giving it copy coverage.
  const SAMPLES = {
    task_approval: [{ taskTitle: 'Sutvarkyti sandėlį' }],
    task_needs_manager: [{ taskTitle: 'Sutvarkyti sandėlį' }, {}],
    task_waiting: [{ taskTitle: 'Sutvarkyti sandėlį' }, {}],
    task_completion: [{ taskTitle: 'Sutvarkyti sandėlį' }],
    time_extension_request: [{ taskTitle: 'Sutvarkyti sandėlį' }],
    session_correction_request: [{ day: '2026-06-20', commentText: '  klaida   trukmėje ' }, { day: '2026-06-20' }, {}],
    new_comment: [{ taskTitle: 'Užduotis', commentText: '  ilgas\n komentaras ' }, { taskTitle: 'Užduotis' }, {}],
    new_photo: [{ taskTitle: 'Užduotis' }, {}],
    task_assigned: [{ taskTitle: 'Užduotis' }],
    // Both the plain approval and the approve+edit (edited:true) branch.
    task_approved: [{ taskTitle: 'Užduotis' }, { taskTitle: 'Užduotis', edited: true }],
    task_edited: [{ taskTitle: 'Užduotis' }, {}],
    task_unassigned: [{ taskTitle: 'Užduotis' }, {}],
    task_deleted: [{ taskTitle: 'Užduotis' }, {}],
    task_confirmed: [{ taskTitle: 'Užduotis' }],
    task_reverted: [{ taskTitle: 'Užduotis' }, { taskTitle: 'Užduotis', edited: true }],
    extension_granted: [{ taskTitle: 'Užduotis' }],
    extension_denied: [{ taskTitle: 'Užduotis' }],
    calendar_decision: [{ decision: 'approved' }, { decision: 'declined' }],
    session_edited: [{ day: '2026-06-20' }, {}],
    session_deleted: [{ day: '2026-06-20' }, {}],
    session_auto_closed: [{ day: '2026-06-20' }, {}],
    // Name + day, day-only (name absent), and the empty fallback — covers both copy branches and the
    // whitespace-clamp on userName (the only free-form field) on both client and server mirrors.
    backdated_time_logged: [{ userName: '  Jonas   Jonaitis ', day: '2026-06-20' }, { day: '2026-06-20' }, {}],
    account_approval: [{ targetUserName: 'Jonas Jonaitis' }, { targetUserEmail: 'j@x.lt' }, {}],
    recurring_reassign: [{ taskTitle: 'Užduotis' }],
    // Both label-present branches (Skubus/Aukštas) and the missing-field fallbacks.
    task_priority_escalated: [{ taskTitle: 'Užduotis', priorityLabel: 'Skubus' }, { taskTitle: 'Užduotis', priorityLabel: 'Aukštas' }, { taskTitle: 'Užduotis' }, {}],
    // Badge name + tier, name-only (no tier), and the empty fallback.
    achievement: [{ badgeName: 'Ištvermė', tierName: 'Sidabras' }, { badgeName: 'Ištvermė' }, {}],
    task_overdue: [{ taskTitle: 'Užduotis' }, {}],
  };

  it('the registry and the server switch cover the same set of types', () => {
    const registryTypes = new Set(Object.keys(NOTIFICATIONS));
    const onlyRegistry = [...registryTypes].filter((t) => !serverTypes.has(t));
    const onlyServer = [...serverTypes].filter((t) => !registryTypes.has(t));
    expect(onlyRegistry, `In the registry but the server push has no case: ${onlyRegistry.join(', ')}`).toEqual([]);
    expect(onlyServer, `In the server push but the registry has no entry: ${onlyServer.join(', ')}`).toEqual([]);
  });

  it('every registry type has copy-test coverage here', () => {
    const missing = Object.keys(NOTIFICATIONS).filter((t) => !SAMPLES[t]);
    expect(missing, `Add a SAMPLES payload for: ${missing.join(', ')}`).toEqual([]);
  });

  it('server push copy === registry copy for every type and payload', () => {
    const disagreements = [];
    for (const type of Object.keys(NOTIFICATIONS)) {
      for (const payload of SAMPLES[type] || []) {
        const n = { type, ...payload };
        const server = serverCopy(n);
        const client = notificationCopy(n);
        if (server.title !== client.title || server.body !== client.body) {
          disagreements.push(
            `${type} @ ${JSON.stringify(payload)}: server=${JSON.stringify(server)} client=${JSON.stringify(client)}`,
          );
        }
      }
    }
    expect(disagreements, `notification copy diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// 7b. NOTIFICATION CATEGORY LOCKSTEP — the service worker can't import the client registry, so each
//     background push carries its category ('action' | 'info') in the data payload, built server-side
//     from a hand-copied CATEGORY_BY_TYPE map. That map MIRRORS notificationCategory() in the registry
//     and is exactly the kind of cross-boundary copy that silently drifts. Slice the object literal out
//     of functions/index.js, parse it, and assert per-type equality + identical type coverage.
// =============================================================================================

describe('notification category lockstep (functions CATEGORY_BY_TYPE ↔ client registry)', () => {
  // Slice the CATEGORY_BY_TYPE object literal out of functions/index.js and evaluate it. It is a flat
  // map of string→string (no nested braces), so the first '};' after the marker closes it. A moved
  // marker throws clearly.
  const serverCategory = (() => {
    const marker = 'const CATEGORY_BY_TYPE = {';
    const start = FUNCTIONS_SRC.indexOf(marker);
    if (start === -1) {
      throw new Error('Could not find CATEGORY_BY_TYPE in functions/index.js — marker moved; update this test.');
    }
    const end = FUNCTIONS_SRC.indexOf('};', start);
    if (end === -1) {
      throw new Error('Could not find the end of CATEGORY_BY_TYPE in functions/index.js — update this test.');
    }
    const block = FUNCTIONS_SRC.slice(start, end + 2);
    return new Function(`${block}\n;return CATEGORY_BY_TYPE;`)();
  })();

  it('the registry and the server category map cover the same set of types', () => {
    const registryTypes = new Set(Object.keys(NOTIFICATIONS));
    const serverKeys = new Set(Object.keys(serverCategory));
    const onlyRegistry = [...registryTypes].filter((t) => !serverKeys.has(t));
    const onlyServer = [...serverKeys].filter((t) => !registryTypes.has(t));
    expect(onlyRegistry, `In the registry but missing from server CATEGORY_BY_TYPE: ${onlyRegistry.join(', ')}`).toEqual([]);
    expect(onlyServer, `In server CATEGORY_BY_TYPE but not the registry: ${onlyServer.join(', ')}`).toEqual([]);
  });

  it('server category === registry category for every type', () => {
    const disagreements = [];
    for (const type of Object.keys(NOTIFICATIONS)) {
      const server = serverCategory[type];
      const client = notificationCategory(type);
      if (server !== client) {
        disagreements.push(`${type}: server=${server} client=${client}`);
      }
    }
    expect(disagreements, `notification category diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// 8. SECONDARY-SESSION RECORD-ID LOCKSTEP — a finished break/call/quick-work is logged with a
//    DETERMINISTIC doc id (sess_<kind>_<uid>_<startMs>) by BOTH the client (sessionActions.js
//    handleLegacyLogging) and the server net (functions/index.js writeSecondaryCloseRecords). That
//    shared id is what dedups the two independent closers so an abandoned session is never credited
//    twice. If one side renames a prefix, the dedup silently breaks and the double-credit race
//    returns — exactly the kind of hand-copied drift this gate exists to catch.
// =============================================================================================

describe('secondary-session record-id lockstep (client sessionActions ↔ functions net)', () => {
  const ID_PREFIXES = ['sess_break_', 'sess_call_task_', 'sess_call_ws_', 'sess_qw_task_', 'sess_qw_ws_'];

  it('both the client logger and the server net use the identical deterministic id prefixes', () => {
    const missingClient = ID_PREFIXES.filter((p) => !SESSION_ACTIONS_SRC.includes(p));
    const missingServer = ID_PREFIXES.filter((p) => !FUNCTIONS_SRC.includes(p));
    expect(missingClient, `sessionActions.js is missing record-id prefixes (dedup would break): ${missingClient.join(', ')}`)
      .toEqual([]);
    expect(missingServer, `functions/index.js is missing record-id prefixes (dedup would break): ${missingServer.join(', ')}`)
      .toEqual([]);
  });
});

// =============================================================================================
// DEEP-LINK MAPPING LOCKSTEP — notifyOnRequestNotification builds the push's `link` field with a
// hand-copied ternary MIRROR of notificationLink() in the registry (calendar_decision → calendar
// tab, achievement → profile tab, everything else → tasks tab). A drift here means tapping a push
// notification lands the user on the wrong tab. We slice the ternary itself out of
// functions/index.js and evaluate it as a function of `n.type`, so this test breaks the moment the
// server's routing rule changes without updating the registry (or vice versa).
// =============================================================================================

describe('deep-link mapping lockstep (functions notifyOnRequestNotification link ↔ client notificationLink)', () => {
  function buildServerLink() {
    const marker = 'const link = n.type ===';
    const start = FUNCTIONS_SRC.indexOf(marker);
    if (start === -1) {
      throw new Error('Could not find the `const link = ...` ternary in functions/index.js — moved; update this test.');
    }
    const end = FUNCTIONS_SRC.indexOf(';', start);
    if (end === -1) {
      throw new Error('Could not find the end of the `const link = ...` ternary in functions/index.js — update this test.');
    }
    const expr = FUNCTIONS_SRC.slice(start, end + 1);
    return new Function('n', `${expr}\n;return link;`);
  }

  const serverLink = buildServerLink();

  it('the server link ternary and notificationLink() agree for every registry type', () => {
    const disagreements = [];
    for (const type of Object.keys(NOTIFICATIONS)) {
      const server = serverLink({ type });
      const client = notificationLink(type);
      if (server !== client) {
        disagreements.push(`${type}: server=${server} client=${client}`);
      }
    }
    expect(disagreements, `deep-link routing diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// ESCALATION LABEL LOCKSTEP — the deadline-escalation Cloud Function precomputes the Lithuanian
// priority label onto the notification doc (ESCALATION_LABELS), a hand-copied MIRROR of the
// client's PRIORITY_CONFIG labels (via getPriorityLabel). If they diverge, the push body shows a
// different word than the priority chip does for the SAME priority.
// =============================================================================================

describe('escalation label lockstep (functions ESCALATION_LABELS ↔ client getPriorityLabel)', () => {
  const m = FUNCTIONS_SRC.match(/ESCALATION_LABELS\s*=\s*\{([^}]*)\}/);

  it('found ESCALATION_LABELS in functions/index.js (extraction sanity)', () => {
    expect(m, 'Could not find ESCALATION_LABELS in functions/index.js — moved; update this test.').not.toBeNull();
  });

  it('every ESCALATION_LABELS entry equals the client priority label', () => {
    const pairRe = /(\w+)\s*:\s*'([^']+)'/g;
    const pairs = [];
    let pm;
    while ((pm = pairRe.exec(m[1])) !== null) pairs.push([pm[1], pm[2]]);
    expect(pairs.length).toBeGreaterThan(0);

    const disagreements = [];
    for (const [priority, serverLabel] of pairs) {
      const clientLabel = getPriorityLabel(priority);
      if (serverLabel !== clientLabel) {
        disagreements.push(`${priority}: server=${serverLabel} client=${clientLabel}`);
      }
    }
    expect(disagreements, `escalation labels diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// ON-TIME GRACE WINDOW LOCKSTEP — the punctual-start badge is computed server-side (R6, using
// GRACE_MINUTES) but the worker-stats UI shows the same "started within N minutes" window
// (ON_TIME_GRACE_MIN) so the badge criteria and the displayed hint never disagree.
// =============================================================================================

describe('on-time grace window lockstep (functions GRACE_MINUTES ↔ client ON_TIME_GRACE_MIN)', () => {
  it('the server grace window equals the client grace window', () => {
    const m = FUNCTIONS_SRC.match(/GRACE_MINUTES\s*=\s*(\d+)/);
    expect(m, 'Could not find GRACE_MINUTES in functions/index.js').not.toBeNull();
    expect(Number(m[1])).toBe(ON_TIME_GRACE_MIN);
  });
});

// =============================================================================================
// LITHUANIAN CALENDAR-DAY LOCKSTEP — the punctual-start scan buckets sessions into a Vilnius
// calendar day via lithuanianDay(), a hand-copied MIRROR of the client's getLithuanianDateString.
// A drift near a DST boundary or midnight would bucket a session into the wrong day on one side,
// desyncing the "same day" comparison the badge logic relies on. We slice the server's
// self-contained function out and compare it against the client copy across a battery of
// instants, including both 2026 DST transitions and the UTC-vs-Vilnius day rollover.
// =============================================================================================

describe('Lithuanian calendar-day lockstep (functions lithuanianDay ↔ client getLithuanianDateString)', () => {
  function buildServerLithuanianDay() {
    const start = FUNCTIONS_SRC.indexOf('function lithuanianDay');
    const end = FUNCTIONS_SRC.indexOf('// R6', start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Could not slice lithuanianDay out of functions/index.js — markers moved; update this test.');
    }
    const block = FUNCTIONS_SRC.slice(start, end);
    return new Function(`${block}\n;return lithuanianDay;`)();
  }

  const serverLithuanianDay = buildServerLithuanianDay();

  const instants = [
    '2026-01-01T00:00:00.000Z',   // plain UTC midnight
    '2026-03-29T00:30:00.000Z',   // shortly before the 2026 spring-forward (EET→EEST)
    '2026-03-29T02:30:00.000Z',   // shortly after the 2026 spring-forward
    '2026-10-25T00:30:00.000Z',   // shortly before the 2026 fall-back (EEST→EET)
    '2026-10-25T02:30:00.000Z',   // shortly after the 2026 fall-back
    '2026-06-15T21:30:00.000Z',   // summer (EEST, UTC+3): still the same Vilnius day
    '2026-06-15T22:00:00.000Z',   // summer: rolled into the next Vilnius day
    '2026-01-15T21:30:00.000Z',   // winter (EET, UTC+2): still the same Vilnius day
    '2026-01-15T22:00:00.000Z',   // winter: rolled into the next Vilnius day
    '2026-12-31T23:59:00.000Z',   // year boundary
  ];

  it('server and client agree on the Vilnius calendar day for every instant', () => {
    const disagreements = [];
    for (const iso of instants) {
      const date = new Date(iso);
      const server = serverLithuanianDay(date);
      const client = getLithuanianDateString(date);
      if (server !== client) {
        disagreements.push(`${iso}: server=${server} client=${client}`);
      }
    }
    expect(disagreements, `Lithuanian calendar-day copies diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});

// =============================================================================================
// ESTIMATE-STRING PARSER LOCKSTEP — the AI task-draft parser clamps a free-text estimate to
// minutes via parseEstimateMinutes, a hand-copied MIRROR of the client's parseTimeStringToMinutes
// (same comma-decimal + "val" suffix handling). A drift means the AI-suggested estimate and a
// hand-typed one of the same text resolve to different minute counts. We slice the server's
// self-contained function out and compare it against the client copy across a battery of inputs.
// =============================================================================================

describe('estimate-string parser lockstep (functions parseEstimateMinutes ↔ client parseTimeStringToMinutes)', () => {
  function buildServerParseEstimateMinutes() {
    const start = FUNCTIONS_SRC.indexOf('function parseEstimateMinutes');
    const end = FUNCTIONS_SRC.indexOf('function recurringIsoWeekday', start);
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Could not slice parseEstimateMinutes out of functions/index.js — markers moved; update this test.');
    }
    const block = FUNCTIONS_SRC.slice(start, end);
    return new Function(`${block}\n;return parseEstimateMinutes;`)();
  }

  const serverParseEstimateMinutes = buildServerParseEstimateMinutes();

  const inputs = [
    '5min', '45min', '1h', '1,5h', '1.5h', '12,5h', '200h',
    '30m', '90 min', '2 val', '1,5 val',
    'invalid', 'abc', '-30m', '2h 2h', '10m20m',
    '', null, undefined,
  ];

  it('server and client agree on every estimate string', () => {
    const disagreements = [];
    for (const input of inputs) {
      const server = serverParseEstimateMinutes(input);
      const client = parseTimeStringToMinutes(input);
      if (server !== client) {
        disagreements.push(`${JSON.stringify(input)}: server=${server} client=${client}`);
      }
    }
    expect(disagreements, `estimate-string parsing diverged:\n${disagreements.join('\n')}`).toEqual([]);
  });
});
