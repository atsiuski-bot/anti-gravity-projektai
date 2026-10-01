---
name: "source-command-ship"
description: "WORKZ /ship: commit, merge origin/main, run the FULL quality gate, fast-forward push to main, which deploys to PRODUCTION. Use ONLY when the user explicitly asks to ship (/ship, $source-command-ship). Pointer to .claude/commands/ship.md."
---

# /ship — pointer to the canonical procedure

This skill is deliberately a pointer, not a copy. A hand-made copy of the procedure drifted:
it still said the gate was lint+build after the canonical command had gained the unit,
functions and emulator test tiers, so a ship run from the copy would have pushed to
production untested.

1. Read `.claude/commands/ship.md` in full, then execute it exactly, using this tool's
   equivalent capabilities.
2. Keep every STOP condition and every "What /ship does NOT do" line.
3. If any gate tier cannot run here (missing runner, no emulator, no Java), STOP and name what
   would go unverified. Never push past a skipped gate.
4. Run only on an explicit ship request — never because the user said "commit", "push" or
   "pull".
