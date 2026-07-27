# Phase 06 — Firebase rules, indexes, and Functions deploy state

**Status:** ✅ COMPLETE  
**Findings:** 🔴 0 · 🟠 1 · 🟡 0 · ℹ️ 3

## Method

Pinned the Firebase MCP environment to this WORKZ checkout and `darbo-planavimas`, validated both local rulesets, compared normalized local and live rules byte-for-contract, compared local and live composite indexes, and compared local Function exports with deployed Function names/runtime/location.

## Findings

### 🟠 Likely

- `useWorkerStats` has emitted five live missing-index failures for an `archived_tasks` query requiring `teamManagerIds ARRAY_CONTAINS + archivedAt ASC + __name__ ASC`. The 12 local/live definitions include only the descending `teamManagerIds + archivedAt` variant. Local/live equality therefore proves deploy parity, not query completeness. Add the ascending composite and a query/index consistency test.

### ℹ️ Info

- Local `firestore.rules` and `storage.rules` both validate with no errors. Their normalized content exactly matches the live releases in `darbo-planavimas` (`firestore.rules`: 776 lines, FNV-1a `9b64c6b2`; `storage.rules`: 39 lines, `603e82ae`). Therefore the source-level rule findings in the reasoning track are also present in the live ruleset.
- All 12 local composite index definitions match 12 live indexes, and every live index reports `READY`; see `06-live-indexes.json`.
- Local `functions/index.js` exports 22 Functions and the live project exposes the same 22 names. Every live Function is v2, `nodejs22`, and `europe-west1`. The listing API does not expose deployed source bytes, so this proves surface/runtime parity but not byte-identical Function implementation.

No deploy was attempted. Any future Firebase operation must still begin by re-reading the environment because the MCP project selection is shared across repositories.
