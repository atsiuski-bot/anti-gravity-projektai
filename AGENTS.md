# AGENTS.md — WORKZ

WORKZ is a mobile-first PWA for work-time tracking (React 18 + Vite + Tailwind, Firebase
backend). This file is the cross-tool entry point for **any** AI agent (Claude Code, Codex,
Antigravity, Cursor, …). [`CLAUDE.md`](./CLAUDE.md) is the canonical, fuller protocol — read it
before changing anything.

## Non-negotiables

- **Language split:** all persisted artifacts — files, code, comments, commit messages — are
  **English**. User-facing **UI strings are Lithuanian** (formal "Jūs"). The only Lithuanian
  on disk is UI copy and Lithuanian proper nouns.
- **Brand:** the product is **WORKZ** only. The legacy "Viduramžiai.LT" name is retired —
  never reintroduce it in code, titles, manifests, or copy.
- **Design system is binding:** any UI change conforms to
  [`docs/design/DESIGN_SYSTEM.md`](./docs/design/DESIGN_SYSTEM.md) and
  [`docs/design/tokens.md`](./docs/design/tokens.md). **WCAG 2.1 AA is a mandatory gate**
  (≥12 px text, ≥44 px touch targets, ≥4.5:1 contrast, visible focus, color never the sole
  signal).
- **No secrets in git:** no API keys, tokens, or credentials.
- **Don't deploy autonomously:** deploy (Netlify) is a human-initiated action.

## Before you finish a code change

- `npm run lint` passes (zero warnings) and `npm run build` succeeds.
- UI changes satisfy the checklist in `DESIGN_SYSTEM.md` §11.
- **Visual QA:** the app is Google-popup-only, so to actually log in and look at a change, use the
  dev-only test account (popup-free admin login on the Login page in `npm run dev`) —
  [`docs/runbooks/visual-qa-test-account.md`](./docs/runbooks/visual-qa-test-account.md).

## Commits (audit trail)

Every AI commit must carry:

```
<conventional commit subject>

[ai-author: <model-name>]
Reason: <why this change was made>
```

The founder audits via `git log --grep="ai-author"`.

## Decisions

- Major decision → an ADR in [`docs/adr/`](./docs/adr/) + a line in
  [`docs/decisions-log.md`](./docs/decisions-log.md).
- Minor decision → inline `<!-- DECISION YYYY-MM-DD: ... -->`.

## Orientation reading order

1. This file → [`CLAUDE.md`](./CLAUDE.md)
2. [`docs/decisions-log.md`](./docs/decisions-log.md)
3. [`docs/design/DESIGN_SYSTEM.md`](./docs/design/DESIGN_SYSTEM.md) + [`tokens.md`](./docs/design/tokens.md)
4. The code area relevant to the task.
