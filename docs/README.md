# WORKZ — docs/

Design and decision knowledge base for WORKZ. AI agents and contributors read this to know
how the product should look and how the repo is run.

## Map

| Path | What |
|---|---|
| [`design/DESIGN_SYSTEM.md`](./design/DESIGN_SYSTEM.md) | The design bible: principles, the signature color-state system, typography, color, accessibility (WCAG AA), components, layout/density, voice. **Read before any UI change.** |
| [`design/tokens.md`](./design/tokens.md) | Canonical design tokens (color/type/space/radius/shadow/z-index) + the proposed `tailwind.config.js` block. |
| [`adr/`](./adr/) | Architecture Decision Records — the *why* behind major choices. |
| [`decisions-log.md`](./decisions-log.md) | Chronological index of ADRs + notable inline decisions. **Read first for orientation.** |

## Conventions

- **Language of these docs:** English (see [ADR 0002](./adr/0002-agent-operating-model.md)).
- **Major decision?** Add an ADR (`adr/NNNN-slug.md`) and a line in `decisions-log.md`.
- **Minor decision?** Inline `<!-- DECISION YYYY-MM-DD: ... -->` where it applies.
- **Living docs:** every file reflects current state; history is the git diff.
