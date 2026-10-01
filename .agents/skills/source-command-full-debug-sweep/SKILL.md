---
name: "source-command-full-debug-sweep"
description: "Autonomous whole-project audit of WORKZ: deterministic gates run sequentially, then the reasoning phases (parallel finders + adversarial verify). Read-only. NOT a replacement for a diff-scoped review or a pre-ship gate. Pointer to .claude/commands/full-debug-sweep.md."
---

# /full-debug-sweep — pointer to the canonical procedure

This skill is deliberately a pointer, not a copy: hand-made copies of the WORKZ procedures
drifted from the canonical commands.

1. Read `.claude/commands/full-debug-sweep.md` in full, then execute it exactly, using this
   tool's equivalent capabilities. It is read-only apart from its own audit folder.
2. The reasoning phases run on the Claude Code triage-sweep Workflow. If that runtime is not
   available here, run the deterministic track and report the reasoning phase as NOT RUN —
   never present a partial sweep as complete.
