---
description: Read-only Firebase health check for WORKZ via the Firebase MCP. Pulls the live project config, the live Firestore/Storage security rules and active indexes, recent Cloud Functions, and deploy status — then diffs the live security rules against the repo's firestore.rules / storage.rules and reports any drift. Pure inspection: makes NO writes and triggers NO deploy. Use to answer "is what's live the same as the repo?" without pasting console commands or keys.
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
4. **Indexes + functions + deploy status.** `firestore_list_indexes`,
   `functions_list_functions` (report each function's runtime/region), and
   `firebase_deploy_status` for a recent-deploy summary.

## Output

A short report:

- **Project / config** — active project, key public config values.
- **Rules drift** — `IN SYNC` or a per-rule list of differences, separately for Firestore and
  Storage. This is the headline.
- **Validation** — repo rules valid? (flag any error verbatim).
- **Indexes / functions** — counts + anything unexpected (e.g. a function on an old runtime).
- **Next step** — if rules drift exists, surface the exact human-run deploy one-liner
  (`firebase deploy --only firestore:rules --project darbo-planavimas --account audrius@medievalclub.org`),
  run **from the worktree holding the intended rules**, and remind that the live ruleset must be
  re-verified after — but **do not run it**; deploy stays a deliberate human action.
