# WORKZ — CLAUDE.md

> Canonical operating protocol for AI agents working in the WORKZ repository.
> [`AGENTS.md`](./AGENTS.md) is the short cross-tool entry point; this file is the full
> version. Read it before changing anything.

## What WORKZ is

A **mobile-first PWA for work-time tracking**, used by two roles:

- **worker** — blue-collar / field staff on phones, often outdoors. Loop: see tasks → start
  work → stop / finish. Also quick-work, call, and break timers; shift planning.
- **manager / admin** — oversight: team tasks, live sessions, approvals/notifications,
  reports, user management. Often on desktop.

The product was originally framed as "Viduramžiai.LT"; it has since grown into a standalone
tool named **WORKZ**. WORKZ is the only name — the old one is retired everywhere.

## Tech & architecture

- **React 18 + Vite + Tailwind CSS**, PWA via `vite-plugin-pwa`.
- **Firebase** backend: Auth (Google sign-in), Firestore (tasks, users, sessions, calendar),
  Storage (attachments). Rules in `firestore.rules` / `storage.rules`.
- **Hosting: Netlify** (`netlify.toml`). Backend stays Firebase.
- Routing: a single app route `/` with **tab-based navigation via context**
  (`NavigationContext`); only `/login` is a separate route.
- Key source areas: `src/pages/` (Login, Dashboard, WorkerView, ManagerView),
  `src/components/`, `src/context/` (Auth, Users, Navigation), `src/hooks/`, `src/utils/`
  (tokenized logic already exists: `priority.js`, `taskConstants.js`, `timeUtils.js`).
- **Signature UI trait:** the whole-screen background color reflects the active session
  (red = quick work, blue = call, amber = break, green = task running). This is intentional —
  see the design system before touching it.

## Language policy

**English for everything persisted** — files, code, comments, commit messages, `Reason:`
lines, ADRs. **Lithuanian only for user-facing UI strings** (formal "Jūs"). Lithuanian proper
nouns and tax/legal terms are kept verbatim. Never render raw `err.message` to users; map
errors to friendly Lithuanian copy.

## AI access tier — Free write + audit

Agents may write anywhere in the repo. **Every commit must carry metadata:**

```
fix(timer): keep Pradėti dominant over Užbaigti on the task card

[ai-author: claude-opus-4-8]
Reason: Primary action must outweigh the destructive one (DESIGN_SYSTEM §8).
```

The founder periodically reviews via `git log --grep="ai-author"` and can revert anything.
This trades maximum velocity against retrospective audit. **Do not deploy autonomously** —
deploy is human-initiated.

## Minimizing manual toil — agent autonomy

The founder is not a programmer and **cannot evaluate security trade-offs**. Agents must
therefore minimize the manual, copy-paste "monkey work" (pasting keys, running console
scripts, switching accounts) and do as much as possible themselves — **without ever crossing
the human-only boundary below.** The split is deliberate: drive avoidable toil to zero, and
reduce the genuine security boundary to a single confirmation, never many paste steps.

### Do it yourself (don't ask the founder to paste/run it)

- **Firebase work goes through the Firebase MCP, not pasted scripts.** Reading config,
  inspecting/validating security rules, querying Firestore, reading function logs, checking
  deploy status — all are MCP calls the agent makes directly. Never ask the founder to copy a
  console snippet for anything the MCP can do. Read-only MCP tools are pre-approved in
  `.claude/settings.json`, so they run without a prompt.
- **Read secrets from where they already live; never ask for a re-paste.** Local dev secrets
  live in `.env.local` (gitignored, matches `*.local`). If a value is already there or
  fetchable via MCP, read it — don't make the founder paste it again.
- **Most "Firebase keys" are NOT secrets.** The web `apiKey`, `projectId`, `appId`, `authDomain`,
  and the VAPID public key are *public client config* — they are meant to ship in the browser
  bundle and need no protection. Only **service-account JSON and admin/private keys** are real
  secrets. Don't treat public config with secret-grade ceremony, and don't alarm the founder
  about it.
- **Pin the right account automatically.** WORKZ Firestore/Functions = `audrius@medievalclub.org`
  (`karolis.j` has no access). Use the account already configured (`acc doctor` / global
  `settings.json`); don't ask the founder to re-authenticate unless a token has actually expired.
- **Encapsulate any repeated procedure as a skill/command.** If a console sequence would be run
  more than once, turn it into a `/command` (see `.claude/commands/`) so the founder types one
  word instead of pasting steps. Existing: `/ship`, `/deploy-netlify`, `/firebase-status`.

### Human-only boundary (keep it manual — this is the safety net)

These are irreversible or secret-exposing, so they stay a deliberate human action. Prepare
everything, then hand the founder **one** clearly-labelled step — never a wall of commands:

- **Production deploys** — Firestore/Storage **rules** and **Cloud Functions** deploys, and any
  hosting promote. The permission classifier blocks these by design; surface the exact one-liner
  and let the founder run it. (Rules deploy reads the **CWD's** `firestore.rules` — deploy from
  the worktree holding the intended rules, then re-verify the *live* ruleset, don't trust
  "Deploy complete" alone.)
- **Secret creation/rotation** and writing real secrets to a hosting provider's env settings.
- **Destructive data operations** — bulk Firestore writes/deletes against production.

When in doubt whether something crosses this line, treat it as human-only and explain why in
one sentence.

## Design system (binding)

All UI work conforms to [`docs/design/DESIGN_SYSTEM.md`](./docs/design/DESIGN_SYSTEM.md) and
[`docs/design/tokens.md`](./docs/design/tokens.md). The essentials:

- **Calm canvas, loud state.** Keep the bold whole-screen session color, but always pair it
  with a text label + icon, and source it from one `SESSION_COLORS` map.
- **WCAG 2.1 AA is mandatory:** ≥12 px readable text, ≥44 px touch targets, ≥4.5:1 contrast,
  visible focus rings, reduced-motion support, accessible names, color never the sole signal.
- **Tokens, not magic numbers.** No raw hex or arbitrary `text-[9px]` in components.
- **Canonical components only:** `Button`, `IconButton`, `Card`, `Modal`, `ConfirmDialog`,
  `StatusPill`, `EmptyState`, `Loading`. `window.confirm`/`alert` are banned in UI flows.
- **Dual density:** workers get spacious mobile cards; managers may get denser tables on
  `md+`. On a phone, data is cards — never a horizontally-scrolling table.
- Use the **§11 checklist** in the design system before declaring a UI change done.

## Quality gate

Before a code change is "done":

```bash
npm run lint     # zero warnings (enforced)
npm run build    # must succeed
```

Run the app with `npm run dev` (network host is enabled for phone testing). For UI, verify on
a ~360 px viewport, not just desktop.

### Visual QA — how to actually log in and look

The app signs in **only** through a Google popup, which an automated browser cannot drive — which
is why so much shipped "not visually QA'd". For a popup-free, admin-level login each session, use
the **dev-only test account**: a dashed "DEV testavimas" panel on the Login page (shown only in
`npm run dev`, dead-code-eliminated from production) signs in with credentials from `.env.local`.
Full procedure (one-time setup, per-session loop, security model, teardown when dev is done) —
[`docs/runbooks/visual-qa-test-account.md`](./docs/runbooks/visual-qa-test-account.md)
([ADR 0014](./docs/adr/0014-dev-test-login-and-visual-qa.md)). The account is `role: admin` +
`isTest: true` (excluded from reports) and is kept **disabled at rest**; `.env.local` is gitignored
(this repo is public — never commit the credentials).

## Folder structure

```
workz/
├── AGENTS.md                  # Cross-tool entry point
├── CLAUDE.md                  # This file
├── README.md                  # Project summary
├── docs/
│   ├── README.md              # Docs map
│   ├── decisions-log.md       # Chronological decision index (read first)
│   ├── design/
│   │   ├── DESIGN_SYSTEM.md    # The design bible
│   │   └── tokens.md           # Canonical tokens + tailwind block
│   └── adr/                    # Architecture Decision Records
├── src/                       # App source (pages, components, context, hooks, utils)
├── firestore.rules / storage.rules
├── .agent/workflows/          # Operational runbooks (e.g. deploy)
└── vite.config.js / tailwind.config.js / netlify.toml / firebase.json
```

## Decision logging — hybrid

- **Major** decision → an ADR `docs/adr/NNNN-slug.md` (Context · Alternatives · Decision ·
  Consequences · Follow-ups), plus a line in `docs/decisions-log.md`.
- **Minor** decision → inline `<!-- DECISION YYYY-MM-DD: ... -->` where it applies.
- `docs/decisions-log.md` is the master index — **agents read it first**.

## Reading order for a new agent

1. **This file** — protocol.
2. [`README.md`](./README.md) — project summary.
3. [`docs/decisions-log.md`](./docs/decisions-log.md) — what's already decided.
4. [`docs/design/DESIGN_SYSTEM.md`](./docs/design/DESIGN_SYSTEM.md) + [`tokens.md`](./docs/design/tokens.md) — for any UI work.
5. The code area relevant to the task.

## Cross-repo

The strategy knowledge base lives in the sibling repo `godsgloom-strategy` (mirrors this
agent model). Read across repos when context is needed; keep private strategy out of this
public-facing app repo. Add sibling paths to `.claude/settings.json` `allow` for prompt-free
cross-repo reads.
