# WORKZ — Decisions log

Chronological index of major decisions (ADRs) and notable inline decisions.
**AI agents read this first for orientation.**

## ADRs

| # | Date | Status | Decision |
|---|---|---|---|
| [0001](./adr/0001-visual-design-system.md) | 2026-06-20 | Accepted | Visual design system & tokens — keep the bold whole-screen session color (with mandatory text labels), indigo brand accent, system font, WCAG AA as a mandatory gate, dual density, canonical component set. |
| [0002](./adr/0002-agent-operating-model.md) | 2026-06-20 | Accepted | Agent operating model — `AGENTS.md`/`CLAUDE.md` entry points, free-write + `[ai-author]` audit, English artifacts / Lithuanian UI, Netlify hosting + Firebase backend, `docs/` + ADR structure. |

## Notable inline decisions

- **2026-06-20** — Retired the legacy **"Viduramžiai.LT"** brand. The product name is now
  **WORKZ** only; the old name was removed from `index.html`, `vite.config.js`, and
  `README.md`, and must not be reintroduced anywhere in code or copy.
- **2026-06-20** — `index.html` `lang` corrected from `en` to **`lt`** (the UI is Lithuanian).
- **2026-06-22** — Retroactive description for **remote-ended quick-work sessions** (audit
  #8(a)). A quick-work session ended on another device is auto-logged with a generic title and
  `autoStopped: true` (the worker never saw the naming prompt); that flag was previously written
  but never read. The worker can now describe it after the fact, surfaced both ways: a one-shot
  "prompt on return" modal and a persistent "Aprašyti" banner in `Layout`, sourced from
  `useUndescribedQuickWork` (live `tasks`, so an entry drops out when described **or** when the
  nightly automation archives it — "until archived"). `addQuickWorkDescription` renames BOTH the
  task and its work_session; to make that join reliable the auto-log path now stores a
  `workSessionId` link on the task (the session's own `taskId` is synthetic, so the two were
  otherwise unjoined). Stays within existing Firestore rules (owner update, no approval-field
  flip) — no rules change. Legacy pre-link records fall back to a bounded best-effort session
  lookup. The bold whole-screen session red stays reserved for the ACTIVE state; the reminder is
  a calm card with only a quick-work accent strip.
