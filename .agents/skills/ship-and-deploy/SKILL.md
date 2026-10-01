---
name: ship-and-deploy
description: "WORKZ ship to PRODUCTION (same procedure as /ship, kept under this name for Antigravity). Use ONLY when the user explicitly asks to ship or deploy to production. Pointer to .claude/commands/ship.md."
---

# Ship and deploy — pointer to the canonical procedure

This skill is deliberately a pointer, not a copy. Its earlier copy ran a weaker gate than the
canonical /ship (no functions or emulator tiers) and triggered on everyday words such as
"commit", "push" and "pull", so an ordinary request could end in an untested production push.

1. Read `.claude/commands/ship.md` in full, then execute it exactly, using this tool's
   equivalent capabilities.
2. Keep every STOP condition and every "What /ship does NOT do" line. Rules, indexes and
   Cloud Functions are never deployed by this skill — they are human-only, post-merge, from an
   up-to-date `main` checkout (CLAUDE.md, human-only boundary).
3. If any gate tier cannot run here, STOP and name what would go unverified. Never push past a
   skipped gate.
4. Run only on an explicit ship/deploy request — never because the user said "commit", "push"
   or "pull".
