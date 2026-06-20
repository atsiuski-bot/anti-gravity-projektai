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
