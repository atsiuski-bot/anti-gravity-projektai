# Phase 20 - Cloud Functions

**Status:** PARTIAL  
**Findings:** P0 0 / P1 0 / P2 1 / P3 0

## Method

Ran `npm run lint` and `npm audit --json` inside `functions/`. Raw outputs are in `20-functions-lint-raw.txt` and `20-functions-audit-raw.json`.

## Result

- Functions lint: PASS.
- Functions audit: 8 moderate advisories, 0 high, 0 critical.

## Findings

### P2

- `functions/package.json` - `firebase-admin` has a moderate advisory chain through Google Cloud dependencies. This is not currently high/critical, but it belongs in the same dependency maintenance lane as the root Firebase upgrade.
