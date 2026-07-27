# Phase 19 - Dependencies

**Status:** FAILED  
**Findings:** P0 0 / P1 2 / P2 1 / P3 1

## Method

Ran `npm outdated`, `npm audit --json`, and `npm audit --omit=dev --json` from the repository root. Raw outputs are in `19-outdated-raw.txt`, `19-audit-raw.json`, and `19-audit-prod-raw.json`.

## Findings

### P1

- Root production dependency tree has 15 advisories even with dev dependencies omitted: 1 critical and 4 high. Notable nodes: `protobufjs` critical, `undici` high through Firebase client packages, `@grpc/grpc-js` high, `lodash` / `lodash-es` high. This is a release hygiene issue for a live PWA.
- Root full audit has 44 total advisories: 2 critical, 14 high, 26 moderate, 2 low. Direct packages with advisories include `firebase`, `firebase-admin`, `vite`, and `vitest`.

### P2

- `package.json:35`, `fetch_task.cjs`, `fetch_task.mjs` - Root `firebase-admin` appears to be pulled in for one-off debug scripts while `functions/` has its own server package. Keeping admin SDK in the root package increases audit noise and transitive vulnerability surface for the frontend repo.

### P3

- Major version drift exists across React, Firebase, Vite, Vitest, Tailwind, and related tooling. Do not bulk-upgrade blindly; plan a dependency lane with compatibility testing.
