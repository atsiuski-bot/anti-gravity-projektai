# Phase 19 — Dependencies and Functions lint

**Status:** ✅ COMPLETE  
**Findings:** 🔴 0 · 🟠 0 · 🟡 2 · ℹ️ 2

## Method

Ran root and `functions/` `npm outdated --json` and `npm audit --json`, plus the Cloud Functions ESLint gate. `npm outdated` and `npm audit` use exit code 1 when they report findings; the commands themselves completed and returned structured results.

## Findings

### 🟡 Risk

- Root dependency tree — 6 moderate transitive advisories flow through the root `firebase-admin` development dependency (`@google-cloud/storage` / request stack / `uuid`). There are no high or critical advisories. The root Admin SDK is used for tooling/tests rather than the browser runtime, which limits exposure, but the chain should be reassessed during dependency maintenance.
- `functions/` production dependency tree — 8 moderate advisories flow through `firebase-admin@13.10.0` into Firestore, Storage, request, and UUID dependencies. These execute in the trusted Cloud Functions runtime, so this is the more consequential tree. `npm audit` proposes `firebase-admin@14.1.0`, but the repository decision log records a peer-compatibility constraint with `firebase-functions@7`; do not apply an automated major upgrade without verifying that constraint and running the full Functions gate.

### ℹ️ Info

- Root audit also reports one low-severity Windows development-server advisory in transitive `esbuild` (`GHSA-g7r4-m6w7-qqqr`). It affects the local dev-server threat model, not the emitted static production bundle. A normal patch refresh should clear it once the compatible Vite/esbuild graph advances.
- Major-version drift exists for React, Firebase client SDK, Vite, Tailwind, ESLint, React Router, and several UI libraries. This is migration work, not evidence of a current defect; upgrade them deliberately and independently. Compatible minor/patch updates are also available for several packages.

## Functions lint

`npm --prefix functions run lint` passed with zero errors or warnings.
