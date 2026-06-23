---
description: Read-only Firebase health check for WORKZ via the Firebase MCP. Pulls the live project config, the live Firestore/Storage security rules and active indexes, deployed Cloud Functions, and deploy status — then diffs the live security rules AND the live function set against the repo (firestore.rules / storage.rules / functions exports) and reports any drift. Pure inspection: makes NO writes and triggers NO deploy. Use to answer "is what's live the same as the repo?" without pasting console commands or keys.
allowed-tools: mcp__firebase__firebase_get_project, mcp__firebase__firebase_get_sdk_config, mcp__firebase__firebase_get_security_rules, mcp__firebase__firebase_validate_security_rules, mcp__firebase__firebase_deploy_status, mcp__firebase__firestore_list_indexes, mcp__firebase__functions_list_functions, Read, Grep, Glob
---

# /firebase-status — live Firebase vs. repo (read-only)

Answer "what's actually live, and does it match this repo?" entirely through the Firebase MCP,
so the founder never pastes a console snippet or a key. **This command writes nothing and
deploys nothing** — every tool it uses is read-only and pre-approved in `.claude/settings.json`.

## Why this exists

Deploys to Firebase are human-initiated (CLAUDE.md → *Minimizing manual toil* → human-only
boundary). The recurring risk is **drift**: rules deploy reads the *CWD's* `firestore.rules`,
so the live ruleset can silently diverge from the repo if a deploy ran from the wrong worktree
or never ran at all. This command makes that drift visible on demand, cheaply, before it bites.

## Steps

1. **Project + config.** `firebase_get_project` and `firebase_get_sdk_config` — confirm the
   active project is `darbo-planavimas` and report the app config the browser actually uses.
   (These values are public client config, not secrets — print them plainly.)
2. **Live security rules.** `firebase_get_security_rules` for both Firestore and Storage. Read
   the repo's `firestore.rules` and `storage.rules` and **diff live vs. repo**. Report each
   difference precisely (added/removed/changed match blocks or conditions). If they are
   identical, say so explicitly.
3. **Validate the repo rules.** `firebase_validate_security_rules` against the repo files so a
   syntactically broken ruleset is caught before anyone tries to deploy it.
4. **Function-set parity (live ↔ repo).** `functions_list_functions` for the LIVE deployed set,
   then `Grep` the repo for the source-of-truth set: `exports\.\w+\s*=` in `functions/index.js`.
   **Diff the two NAME sets** and report:
   - **Deployed but not in repo** — an ORPHAN: a function deleted from code that a later deploy
     from a branch missing the deletion left running live. Surface it; it is dead weight at best,
     a stale behavior at worst.
   - **In repo but not deployed** — MISSING: the change was committed but never deployed (or a
     deploy ran from a worktree that did not contain it). This is the exact "deployed from a feature
     branch" gap — a code path the app expects that does not exist in prod.
   - Also report each live function's runtime/region; flag any not on the expected `nodejs22` /
     `europe-west1`.
   (The repo-INTERNAL companion to this — client callables ↔ server functions, function collections
   ↔ rules, and the hand-copied client↔function constants — is locked by the `npm test` gate in
   `src/__tests__/firebaseConsistency.test.js`, which runs before any deploy. This step is the
   live-side half: it confirms what actually shipped matches that same repo.)
5. **Indexes + deploy status.** `firestore_list_indexes` and `firebase_deploy_status` for a
   recent-deploy summary.

## Output

A short report:

- **Project / config** — active project, key public config values.
- **Rules drift** — `IN SYNC` or a per-rule list of differences, separately for Firestore and
  Storage. This is the headline.
- **Validation** — repo rules valid? (flag any error verbatim).
- **Functions parity** — `IN SYNC` or the explicit orphan / missing lists, plus any function on an
  unexpected runtime/region. This is a second headline alongside rules drift.
- **Indexes** — count + anything unexpected.
- **Next step** — if drift exists, surface the exact human-run deploy one-liner for the affected
  surface (rules: `firebase deploy --only firestore:rules ...`; functions:
  `firebase deploy --only functions ...`; both with
  `--project darbo-planavimas --account audrius@medievalclub.org`), run from an **up-to-date `main`
  checkout post-merge** (NOT a feature worktree — see CLAUDE.md: a worktree deploy can push
  unreviewed code or regress prod), and remind that the live state must be re-verified via the MCP
  after — but **do not run it**; deploy stays a deliberate human action.
