# Phase 19 — Dependencies

**Status:** ⚠️ PARTIAL  
**Findings:** current registry state not queried

## Method

The requested registry-backed `npm outdated` check was blocked by the environment's external-data policy because it would disclose the private project's dependency list to the npm registry. The check was not retried or bypassed.

## Result

- Root and Functions dependency manifests are unchanged from the 2026-07-10 audited commit.
- The 2026-07-10 baseline reported 1 low and 6 moderate root advisories plus 8 moderate Functions advisories, with no high or critical advisory.
- Those counts are historical context only, not a current vulnerability claim.
- Functions lint passes in the current working tree.

