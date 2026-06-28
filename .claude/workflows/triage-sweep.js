export const meta = {
  name: 'triage-sweep',
  description: 'Fan out read-only finders across WORKZ codebase dimensions, dedup, then adversarially verify each finding (N skeptics, majority rules) so only real issues survive — cuts the false-positive burden of a flat sequential sweep.',
  phases: [
    { title: 'Find', detail: 'one read-only Explore finder per dimension' },
    { title: 'Verify', detail: 'N skeptics per finding try to refute; majority decides' },
  ],
}

// Dimensions worth agent REASONING. Deterministic checks (lint, build, deps
// audit, vitest, firestore/storage rules diff, firestore.indexes.json diff,
// functions lint) stay sequential in the /full-debug-sweep deterministic track
// — no LLM value there. WORKZ has NO TypeScript (no tsc) and NO RTDB, so the
// type and RTDB dimensions are intentionally absent; the firestore.indexes.json
// ↔ live-index drift is a coupling risk the firebase-coupling dimension hunts.
// /full-debug-sweep delegates its REASONING phases to this workflow (all
// dimensions); ad-hoc callers scope via args.dimensions + findOnly to cap cost.
const ALL_DIMENSIONS = [
  { key: 'discipline', prompt: 'Project-convention violations: bespoke modals/buttons/cards instead of the canonical set in src/components/ui/ (Button, IconButton, Card, Modal, ConfirmDialog, StatusPill, EmptyState, Loading); any live window.confirm/window.alert in a UI flow instead of ConfirmDialog; Firestore/Auth/Storage instances obtained anywhere but the src/firebase.js wrapper (importing the db/auth/storage instances directly from firebase/* — importing stateless SDK helpers like collection/doc/onSnapshot from firebase/firestore is fine); a session palette duplicated instead of read from the single SESSION_COLORS map in src/utils/sessionColors.js (e.g. bg-sky-* used for the call state); raw hex / arbitrary text-[Npx] / unmanaged z-[NNNN] literals in components instead of design tokens; raw err.message embedded in user-facing strings instead of mapped Lithuanian copy.' },
  { key: 'timetracking', prompt: 'Time-math correctness — the heart of WORKZ. Hunt in src/utils/timeUtils.js, sessionActions.js, taskActions.js, automationUtils.js, calendarNotifications.js and the timer hooks: wall-clock deltas (now - timerStartedAt / now - session.startTime) that go negative or silently discard elapsed on device-clock skew; double-counting across manualMinutes / timerMinutes / the parseTimeStringToMinutes(actualTime) fallback in calculateCurrentTotalMinutes; durationMinutes computed once at write time and never sanity-capped (clock skew is permanent in the log); Europe/Vilnius vs UTC vs local-browser timezone mismatches (the 03:00 archive cutoff, week-boundary in calendarNotifications, deadline promotion in automationUtils, report date filters); report aggregation in Reports.jsx double-counting interrupted quick-work/call partial segments against the full-duration log doc.' },
  { key: 'crashsafety', prompt: 'Crash-safety and session durability. errorLog.js is the durable crash log (localStorage ring buffer workz_error_log capped at 30 + fire-and-forget Firestore error_logs). Hunt: a running task/session left orphaned after reload or crash (timerStatus:"running" + a stale timerStartedAt) with NO automatic recovery, so the next pauseTask credits hours of "ghost time"; fire-and-forget Firestore writes whose failures are swallowed (.catch that only logs) causing silent data loss; throw paths in startSession/startTask/resumeTask that never reach logError or the global unhandledrejection handler; the single-level pausedSession nesting being overwritten when a session is interrupted twice.' },
  { key: 'session-color', prompt: 'The signature whole-screen session color (DESIGN_SYSTEM §2 Principle 1, §4 Rules A-D). Hunt: a colored session shell shown WITHOUT a persistent text label + icon (Rule A — color is never the sole signal, WCAG 1.4.1); a session color that does NOT come from the single SESSION_COLORS map in src/utils/sessionColors.js (Rule B drift); full-saturation red reused for anything but the quick-work state, especially an offline banner rendered red instead of the neutral feedback.offline slate (Rule C); body text/controls placed directly on the saturated shell instead of on a white surface card (Rule D contrast); the no-session state not using IDLE_SHELL.' },
  { key: 'security', prompt: 'Security. firestore.rules: collections with allow read, write: if isUserActive() and NO per-document ownership scope (any active worker can mutate any other user’s tasks/sessions/work_hours/calendar entries); the users collection read gated only by isAuthenticated() (not isUserActive()), so a disabled user still reads all records; any recursive =** wildcard or "if true". storage.rules: over-broad paths. Client input reaching a Firestore/Storage write unvalidated; worker-vs-manager authorization enforced only client-side with no matching rule. Hardcoded secrets committed to git (the src/firebase.js fallback config / API key).' },
  { key: 'firebase-coupling', prompt: 'Firebase coupling drift. (1) A collection the client reads/writes that has NO matching rule in firestore.rules → Firestore default-deny rejects it at runtime (known live example: the "sessions" collection written in sessionActions.js with no rule, error swallowed = silent loss) — find every such gap. (2) A rule for a collection the client never touches (orphan rule, e.g. shift_logs, daily_stats). (3) There is NO firestore.indexes.json in the repo, so EVERY compound query (where + orderBy on different fields, multiple where, or where(...,"in",...)) is a FAILED_PRECONDITION risk at runtime — enumerate them with file:line. (4) A Storage ref(...) path with no matching storage.rules entry.' },
  { key: 'ux-a11y', prompt: 'Accessibility gaps visible in code, against DESIGN_SYSTEM §7 (WCAG 2.1 AA) and §9 (dual density). Hunt: clickable non-semantic <div>/<span> with onClick but no role + keyboard handler; icon-only buttons/IconButton usages with no aria-label (title= alone does not work on touch); interactive controls under 44px (p-1.5 ~28px, p-0.5 ~20px instead of min-h-touch/min-w-touch); readable text below 12px (text-[8px]..text-[11px]); interactive elements with no focus-visible ring; no prefers-reduced-motion handling for animate-pulse/animate-in; text-on-colored-shell contrast below 4.5:1; and on phones, a dense horizontally-scrolling table shown to a worker instead of cards (UserManagement, multi-user Reports, TaskHistory, MonthlyHours, calendar-history must each have a mobile card fallback).' },
  { key: 'i18n-brand', prompt: 'Copy voice and brand. User-facing strings (buttons, toasts, error banners, aria-labels, modal titles, empty/loading/skeleton states, placeholders) that are English or informal instead of Lithuanian formal "Jūs" — English leakage in UI copy is the violation here (this is the INVERSE of an English-only repo). Raw err.message rendered to a user instead of mapped friendly Lithuanian copy. The retired brand name "Viduramžiai" / "Viduramžiai.LT" appearing anywhere in user-facing src/ or index.html (it is allowed ONLY as documentary prose in docs/, CLAUDE.md, AGENTS.md — WORKZ is the only product name).' },
  { key: 'perf', prompt: 'Performance smells. WORKZ is onSnapshot-heavy: every onSnapshot subscription in a useEffect MUST return its unsubscribe() in the cleanup — a missing cleanup is a listener + memory + Firestore-read-cost leak (flag high). Also: expensive work in render without memo/useMemo/useCallback; dynamic lists keyed by array index or unkeyed; N+1 Firestore reads issued inside a loop/map; unbounded collection queries with no limit()/pagination; heavy synchronous work or stacked setInterval timers blocking the main thread.' },
  { key: 'docsdrift', prompt: 'Docs drift: claims in docs/ (decisions-log.md, design/DESIGN_SYSTEM.md, design/tokens.md, adr/*), README.md, AGENTS.md, CLAUDE.md, DEPLOY_FIRESTORE_RULES.md that no longer match current source — file:line refs, default values, component/util names, flow descriptions, and stale status/"pending deploy" notes (known example: tokens.md says the token config is "Proposed (config not yet wired)" while tailwind.config.js is in fact fully wired).' },
  { key: 'deadcode', prompt: 'Dead code: exported symbols with no importers; orphaned files; large commented-out blocks; legacy fields/flags with no live consumers (e.g. the legacy workStatus / breakState / callState / quickWorkState paths superseded by activeSession, if truly unused); unreachable branches; and orphan firestore.rules entries for collections the client never uses.' },
]

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: 'short issue title' },
          file: { type: 'string', description: 'repo-relative path' },
          line: { type: 'string', description: 'line or range, e.g. "42" or "42-50"' },
          severity: { type: 'string', enum: ['low', 'medium', 'high'] },
          detail: { type: 'string', description: 'what is wrong and why' },
        },
        required: ['title', 'file', 'severity', 'detail'],
      },
    },
  },
  required: ['dimension', 'findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    real: { type: 'boolean', description: 'true only if the issue is clearly real after reading source' },
    reason: { type: 'string' },
  },
  required: ['real', 'reason'],
}

// --- args (all optional) -----------------------------------------------------
//   dimensions : string[]  subset of dimension keys (default: all)
//   maxFindings: number    cap findings sent to verify (default: 40)
//   skeptics   : number    skeptics per finding (default: 3)
//   findOnly   : boolean   skip verification, return raw findings (cheap preview)
// NOTE: args may arrive as a JSON STRING depending on how the workflow is
// invoked. Parse defensively so an object-only filter cannot silently fall
// through to running ALL dimensions (a real cost-blowup mode).
let opts = {}
try {
  opts = typeof args === 'string' ? JSON.parse(args) : (args && typeof args === 'object' ? args : {})
} catch {
  opts = {}
}
const dims = Array.isArray(opts.dimensions) && opts.dimensions.length
  ? ALL_DIMENSIONS.filter((d) => opts.dimensions.includes(d.key))
  : ALL_DIMENSIONS
const MAX_FINDINGS = typeof opts.maxFindings === 'number' ? opts.maxFindings : 40
const LENSES = ['correctness', 'hidden-purpose', 'reproducibility']
const SKEPTICS = typeof opts.skeptics === 'number' ? opts.skeptics : 3

// --- token visibility (the "measure, don't tune blind" layer) ----------------
// budget.spent() is cumulative across the whole turn (main loop + every running
// workflow), so attribute THIS sweep's cost by diffing against a baseline taken
// at entry. budget.total is null unless the user set a "+Nk" target; when it IS
// set we reuse the MEASURED find-phase cost to cap the verify fan-out, so a
// scope blow-up cannot silently burn the budget. Guarded so an older runtime
// without `budget` degrades to inert (0 / Infinity).
const bgt = (typeof budget !== 'undefined' && budget && typeof budget.spent === 'function')
  ? budget
  : { total: null, spent: () => 0, remaining: () => Infinity }
const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n)))
const spendStart = bgt.spent()

log(`Scope: ${dims.length} dimension(s) [${dims.map((d) => d.key).join(', ')}] · maxFindings=${MAX_FINDINGS} · skeptics=${SKEPTICS} · worst-case verify agents ~= ${MAX_FINDINGS * SKEPTICS}.` + (bgt.total ? ` · budget ${fmt(bgt.total)} tok target, ${fmt(bgt.remaining())} left.` : ' · no budget target (measuring only).'))

// --- Find (barrier: we need ALL findings before dedup) -----------------------
// Cost split: finders run on Sonnet (cheap "grep + report" work — this is where
// the agent count and most tokens live). The Verify phase below has NO model
// override, so it inherits the session model (Opus) — the adversarial judgment
// that actually gates false positives stays on the strong model.
phase('Find')
const raw = (await parallel(
  dims.map((d) => () =>
    agent(
      `You are a READ-ONLY auditor for the WORKZ project (React 18 + Vite + Tailwind + Firebase PWA, a mobile-first work-time tracker for workers and managers). ` +
        `Read CLAUDE.md, AGENTS.md, docs/design/DESIGN_SYSTEM.md and docs/decisions-log.md for conventions as needed. Hunt ONLY this dimension:\n\n${d.prompt}\n\n` +
        `Report concrete issues you can point to in actual source (path + line). Do NOT fix anything. ` +
        `Quality over quantity — skip anything you are not fairly sure about. Set dimension to "${d.key}".`,
      { label: `find:${d.key}`, phase: 'Find', agentType: 'Explore', model: 'sonnet', schema: FINDINGS_SCHEMA }
    )
  )
))
  .filter(Boolean)
  .flatMap((r) => (r.findings || []).map((f) => ({ ...f, dimension: r.dimension })))

// dedup by file:line:title — genuinely needs the whole set at once
const seen = new Set()
const deduped = raw.filter((f) => {
  const k = `${f.file}:${f.line || ''}:${(f.title || '').toLowerCase()}`
  if (seen.has(k)) return false
  seen.add(k)
  return true
})

log(`Find: ${raw.length} raw findings, ${deduped.length} after dedup across ${dims.length} dimension(s).`)
const findSpend = bgt.spent() - spendStart
const perFindAgent = dims.length ? findSpend / dims.length : 0
log(`Find spend: ~${fmt(findSpend)} output tokens measured (~${fmt(perFindAgent)}/finder).`)
if (opts.findOnly) {
  log('findOnly: returning raw findings without verification (cheap preview).')
  return { findings: deduped, counts: { raw: raw.length, deduped: deduped.length }, tokens: { find: findSpend, verify: 0, total: findSpend } }
}
let toVerify = deduped.slice(0, MAX_FINDINGS)
if (deduped.length > MAX_FINDINGS) log(`Capped to ${MAX_FINDINGS} for verification (raise args.maxFindings to cover the rest).`)

// Budget guard: extrapolate the MEASURED per-finder cost to the verify fan-out
// (toVerify × SKEPTICS agents). If a budget target is set and the projection
// overruns the remaining headroom, trim the verify set rather than letting an
// agent() call throw mid-phase. Fully inert when no budget target is set.
if (bgt.total && perFindAgent > 0 && toVerify.length) {
  const reserve = bgt.remaining() * 0.85 // headroom for synthesis + the final reply
  const affordable = Math.max(0, Math.floor(reserve / (perFindAgent * SKEPTICS)))
  if (affordable < toVerify.length) {
    log(`Budget guard: remaining ${fmt(bgt.remaining())} tok affords ~${affordable} finding(s) × ${SKEPTICS} skeptics. Trimming verify ${toVerify.length}→${affordable} (raise the budget target to cover the rest).`)
    toVerify = toVerify.slice(0, affordable)
  }
}
if (!toVerify.length) return { confirmed: [], rejected: [], note: 'No findings to verify (or budget-trimmed to zero).', tokens: { find: findSpend, verify: 0, total: bgt.spent() - spendStart } }

// --- Verify (each finding: N skeptics try to REFUTE; majority "real" survives)
phase('Verify')
const judged = await parallel(
  toVerify.map((f) => () =>
    parallel(
      Array.from({ length: SKEPTICS }, (_, i) => () =>
        agent(
          `Adversarially verify a claimed code issue in WORKZ via the "${LENSES[i % LENSES.length]}" lens. ` +
            `Open and READ the real source at ${f.file}${f.line ? ':' + f.line : ''} before deciding. ` +
            `Be a skeptic: default real=false unless the issue is clearly real AND not a deliberate design choice ` +
            `(Chesterton's fence — check for an intentional reason before condemning). ` +
            `Claim [${f.dimension}/${f.severity}]: "${f.title}" — ${f.detail}`,
          { label: `verify:${f.dimension}:${i + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA }
        )
      )
    ).then((votes) => {
      const vs = votes.filter(Boolean)
      const realCount = vs.filter((v) => v.real === true).length
      return {
        ...f,
        votesReal: realCount,
        votesTotal: vs.length,
        confirmed: realCount * 2 > vs.length, // strict majority
        reasons: vs.map((v) => v.reason),
      }
    })
  )
)

const all = judged.filter(Boolean)
const confirmed = all.filter((f) => f.confirmed).sort((a, b) => ({ high: 0, medium: 1, low: 2 })[a.severity] - ({ high: 0, medium: 1, low: 2 })[b.severity])
const rejected = all.filter((f) => !f.confirmed)
const totalSpend = bgt.spent() - spendStart
const verifySpend = totalSpend - findSpend
log(`Verify: ${confirmed.length} confirmed, ${rejected.length} rejected as false positives. Verify spend ~${fmt(verifySpend)} tok · sweep total ~${fmt(totalSpend)} output tokens (${dims.length} finder(s) + ${toVerify.length}×${SKEPTICS} verifier(s)).`)

return { confirmed, rejected, counts: { raw: raw.length, deduped: deduped.length, verified: all.length, confirmed: confirmed.length }, tokens: { find: findSpend, verify: verifySpend, total: totalSpend } }
