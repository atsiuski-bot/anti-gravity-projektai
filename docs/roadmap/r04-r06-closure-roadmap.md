# R-04 + R-06-create closure roadmap (planning draft, not an accepted ADR)

_Produced 2026-07-12 by a read-only multi-agent analysis (workflow `r04-closure-roadmap`), with the
pivotal finding independently re-verified via Firebase MCP. This is a **planning draft** to steer the
deferred R-04 thread — it is NOT an accepted decision. Formalize the chosen slice as ADR-0022 when a
direction is picked (ADR-0021 Follow-up #3)._

## Pivotal finding — the offline engine is DORMANT in production (verified)

`system_config/timerEngine` **does not exist** in prod (`darbo-planavimas`) — confirmed by direct
Firebase MCP `firestore_get_document` (not found). The client reads this flag at
[`AuthContext.jsx:404`](../../src/context/AuthContext.jsx:404) and defaults `timerEngineEnabled=false`
([`:33`](../../src/context/AuthContext.jsx:33)); with the flag absent, every user runs the **legacy**
timer path and legacy recovery ([`WorkerView.jsx:75`](../../src/pages/WorkerView.jsx:75)). So the
ADR-0020 "revisioned offline session engine" (shipped to code as `d3879b7`) is **inert** — the
migration (steps 4-6) that gates R-04's self-mint close **has not started at all**, and its step-6
telemetry does not exist yet.

## What this reframes

R-04 is really **two** properties, and they have opposite readiness:

- **The self-minting core** (a worker authoring their OWN credited `work_sessions` row — intents a–f
  self-writes): the durable structural close is **genuinely gated** on the migration. The client
  self-create door can only be shut once the 4 legacy self-write sites (a,b,c,d) are retired, which
  needs the engine rolled out + telemetry proving zero active legacy clients. Correctly deferred.
- **The cross-user slice** (intent **g** — a manager minting ANOTHER worker's paid time) plus
  **R-06-create** (server authoring task `confirmed`): **closeable now**, migration-invariant. This is
  the adversarially-confirmed correction to "do nothing until the migration."

Verdicts (adversarial, majority read): "R-04 has no safe full close before the migration" — **upheld**.
"Nothing can start now" — **refuted** (intent g is closeable today). "Rules alone can't author the
credited number" — **upheld** (a server producer is required for correctness).

## Phased roadmap

Legend: **NOW** = startable today, no migration dependency · **BLOCKED** = gated on the migration/telemetry.

| Phase | Closes | Status | Gate |
|---|---|---|---|
| **P0** Deploy the detection backstop (`scanCreditIntegrity`, already shipped `9bdac41`) | R-04 detection (not a close) | **NOW** | none — human `firebase deploy --only functions` |
| **P1** Provenance-flag pin on `work_sessions` create (pure rules) | R-04 (narrows evasion) | **NOW** | none |
| **P2** Close intent **g** manager-manual + stand up the `session_intents` server-producer rail | R-04 — structural close of the cross-user slice | **NOW** | migration-invariant |
| **P3** Close intent **f** worker self-backdate via the rail | R-04 — declared backdate path | **NOW** | needs P2 rail |
| **P-R06** Server authors task confirmation | R-06-create — structural close | **NOW** (touches live legacy auto-log — needs browser QA) | reuses P2 rail |
| **P4** Build the step-6 migration telemetry (engineVersion==2 discriminator scan) | R-04 enabler — the missing gate instrument | **NOW** | none to build; it IS the gate everything else waits on |
| **P5** Browser-QA the revisioned engine, then flip `system_config/timerEngine` ON | R-04 migration — starts rollout | **BLOCKED** | engine browser-QA (never done) + P4 baseline |
| **P6** Migration step 4 — fold b,c,d into the engine batch | R-04 migration | **BLOCKED** | P5 (engine on) |
| **P7** Migration step 5 — server owns the task-total projection | R-04 migration | **BLOCKED** | P6 + telemetry shows no legacy runs |
| **P8** Retire legacy self-write sites a,b,c,d + remove the flag | R-04 migration | **BLOCKED** | P4 telemetry PROVING zero active legacy clients (ADR-0020 step 6) |
| **P9** Slam the door — forbid direct client `work_sessions` create; route (e) gap-claim through the rail | R-04 — structural close of the self-mint core | **BLOCKED** | P8 (surface reduced; e is offline/recovery-coupled) |

## The `session_intents` rail (the reusable pattern P2/P3/P-R06/P9 share)

Instead of the client writing a canonical `work_sessions`/task row directly, it writes a bounded
**intent** doc (offline-capable, queues like any Firestore write — a callable would break offline, so
NOT a callable). A Firestore-trigger Cloud Function re-checks authorization server-side, **re-derives
the credited number** (never trusts the client's `durationMinutes`), and mints the canonical row via
the admin SDK with a deterministic (idempotent) id. Rules then forbid the client from creating that
shape directly. The founder audits **one** new pattern once; every later phase extends it.

## Recommended sequence

1. **Deploy the ready bundle now** (rules P0-adjacent + `scanCreditIntegrity`) — independent of all of
   the above; activates the real, ready security fixes.
2. **P1** (provenance pin) — a small, emulator-provable rules tightening that removes today's disguise
   vector (a self-logger stamping `createdByAdmin` to evade the integrity scan). Lowest risk.
3. **P2** (close intent g + build the rail) — the workflow's recommended next: converts a real slice
   of R-04 from accepted-risk to structurally closed, with **zero migration rework risk**, and builds
   the rail P3/P-R06/P9 reuse.
4. **P3 + P-R06** — close the self-backdate declared path and R-06-create on the same rail.
5. **P4** — build the migration telemetry: the long-pole's first segment. Without it, ADR-0020 step 6
   can never be evaluated, so the self-mint core close stays deferred indefinitely.
6. **P5–P9** — the actual migration + door-slam. Genuinely deferred until the engine is browser-QA'd,
   flipped on, and telemetry matures.

## Honest bottom line

"Do nothing on R-04 until telemetry X" is **half right**: the self-mint **door-slam** (P9) and its
prerequisites (P5-P8) are correctly deferred. But three slices are closeable **now** with no migration
dependency — intent **g** (highest-trust: cross-user paid-time minting), **f**'s declared backdate
path, and **R-06-create** — plus the gate instrument (P4) must be **built now** or the whole self-mint
close defers forever. Each "NOW" phase is auditable-sized and independently shippable with its own
emulator oracle and a single human deploy.
