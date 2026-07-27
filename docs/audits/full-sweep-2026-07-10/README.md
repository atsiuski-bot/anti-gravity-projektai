# Full Sweep — 2026-07-10

- **Git SHA:** `d3879b7f94bd5a17eabde2b2c33ea3ddaebd9b05`
- **Branch:** `codex/test` (warning: custom branch; not `claude/*`)
- **Worktree:** `C:/Users/karol/Desktop/WORKZ`
- **Node / npm:** `v22.22.0` / `10.9.4`
- **Vite:** `^7.3.5`
- **OS:** Windows / PowerShell
- **Started:** `2026-07-10T07:18:30Z`
- **Finished:** `2026-07-11T17:42:27Z` (completed across multiple user-requested resumptions)
- **Duration:** `34:23:57` wall-clock span, including user-controlled pauses
- **Reasoning cost (measured):** unavailable (the collaboration runtime did not expose per-agent token counters)
- **Total findings (deduplicated):** 🔴 6 · 🟠 19 · 🟡 25 · ℹ️ 11
- **Overall status:** `AUDIT FAIL — 6 critical findings; deterministic and reasoning tracks complete`

## Working-tree snapshot

The sweep started with these pre-existing untracked paths; they are outside the audit output and were not modified:

```text
?? .agents/skills/source-command-debug/
?? .agents/skills/source-command-ship/
?? .claude/projects/
?? .codex/
?? Gildija-Meistro-vadovas.pdf
?? Gildija-NotebookLM-video-promptas.md
?? docs/audits/full-sweep-2026-06-28/
?? functions/cleanup-corrupt-break-sessions.cjs
?? logo.png
?? scripts/cleanup-povilas-stuck-break-2026-01-27.cjs
```

## Resume guard

Resume only if `git rev-parse HEAD` still equals the recorded SHA. Re-run incomplete phases; skip phase files marked `Status: ✅ COMPLETE`.

The resume guard passed before every resumed analysis block. A final repeat of `git rev-parse` / `git status` was quota-blocked after the complete evidence scan; all assistant writes were constrained to this audit directory, and no source/rules/Functions mutation was performed.
