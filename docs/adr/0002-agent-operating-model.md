# ADR 0002: Agent operating model & repository conventions

- **Date**: 2026-06-20
- **Status**: Accepted
- **Decision-maker**: Founder (Karol)
- **AI assistant during decision**: claude-opus-4-8

## Context

WORKZ is built primarily with AI agents (Claude Code, Codex, Antigravity, Cursor, and
others). The repo had **no agent-facing documentation** — no `AGENTS.md`, no `CLAUDE.md`, no
design docs — so any connected bot had to guess conventions. The sibling strategy repo
`godsgloom-strategy` already proves a structure the founder likes: a short `AGENTS.md`, a
canonical `CLAUDE.md`, ADRs + a decisions log, English-only persisted content, and
`[ai-author]` commit metadata. This ADR mirrors that model for WORKZ (a code repo).

## Alternatives considered

- **AI access tier**
  - *Free-write + audit* (chosen) — agents may write directly; every commit carries
    `[ai-author: <model>]` + `Reason:`; the founder audits via `git log --grep`.
  - *PR-gated review* — ❌ safer but slower; overkill for a small team optimizing for velocity.
  - *Free-write, no metadata* — ❌ fast but untraceable.
- **Persisted-artifact language**
  - *English docs + code, Lithuanian UI* (chosen) — mirrors `godsgloom-strategy`; maximizes
    tool/model compatibility; the only Lithuanian on disk is user-facing UI strings.
  - *All Lithuanian* — ❌ diverges from the sibling repo; weaker tool support.
- **Hosting** — *Netlify (hosting) + Firebase (backend)* chosen; matches the GODSGLOOM APP
  pattern. Firebase remains Auth/Firestore/Storage.
- **Doc location** — *`docs/` folder with ADRs* chosen over a single `DESIGN.md` (doesn't
  scale) or stuffing everything into `CLAUDE.md` (not all tools read it; `AGENTS.md` is the
  cross-tool standard).

## Decision

- **Entry points:** `AGENTS.md` (root, cross-tool, short) points to `CLAUDE.md` (root,
  canonical protocol). Both are read before any change.
- **AI access tier:** **Free-write + audit.** Agents may write anywhere. **Every commit must
  carry** `[ai-author: <model-name>]` and a `Reason:` line. The founder periodically reviews
  with `git log --grep="ai-author"`.
- **Language:** **English** for all persisted artifacts — files, code, comments, commit
  messages, `Reason:` lines. **Lithuanian** only for user-facing UI strings (and Lithuanian
  proper nouns / tax-legal terms kept verbatim).
- **Decision logging:** hybrid — major decisions become ADRs in `docs/adr/NNNN-slug.md`;
  minor decisions go inline as `<!-- DECISION YYYY-MM-DD: ... -->`; `docs/decisions-log.md` is
  the chronological index agents read first for orientation.
- **Hosting:** Netlify for hosting, Firebase for backend. Deploy is a **human-initiated**
  action, not something agents do autonomously.
- **Quality gate:** before declaring a code change done, an agent runs `npm run lint` (zero
  warnings) and `npm run build`. UI changes are also held to the `DESIGN_SYSTEM.md` §11
  checklist.
- **Docs structure:** root `AGENTS.md` + `CLAUDE.md`; `docs/design/` (design system + tokens);
  `docs/adr/` (decision records); `docs/decisions-log.md` (index).

## Consequences

### Positive
- Any agent (Claude, Codex, Antigravity, …) connecting to the repo has one unambiguous
  protocol and one design source of truth.
- Maximum velocity with retrospective traceability via `[ai-author]`.
- Decisions and their rationale are durable (ADRs), not lost in chat.

### Negative / risks
- Free-write depends on periodic audit discipline; unreviewed mistakes can accumulate.
- Two languages on disk (English artifacts, Lithuanian UI) require care at the boundary.

### Mitigation
- A recurring "AI commit audit" (`git log --grep="ai-author"`).
- The language boundary is stated in `CLAUDE.md` and enforced in review.

## Follow-ups

- Add the strategy-repo and app-repo paths to each other's `.claude/settings.json` `allow`
  list for prompt-free cross-repo reads (as GODSGLOOM does).
- Optional later: per-folder `CLAUDE.md` to narrow agent scope as the team grows.
