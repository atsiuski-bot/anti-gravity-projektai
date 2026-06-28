# Phase 19 — Dependencies (root + functions)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 2

## Method
Root: `npm outdated` (→ `19-outdated-raw.txt`) + `npm audit --json` (→ `19-audit-raw.json`).
Functions subtree: `npm --prefix functions install` then `npm --prefix functions run lint`
(→ `19-functions-lint-raw.txt`). Severity per plan §6.3 (high/critical advisory → 🟠).

## Audit result (root)
**7 vulnerabilities: 0 critical · 0 high · 6 moderate · 1 low.** All sit in the
`firebase-admin` → `@google-cloud/storage` transitive chain (`@google-cloud/storage`,
`gaxios`, `retry-request`, `teeny-request`, `uuid`) plus a low `esbuild` advisory. The only
`npm audit` "fix" for the moderate chain is a **breaking downgrade to `firebase-admin@10.3.0`**
(current is 14.x) — i.e. not a real fix. This matches the documented, accepted dev-tree
residual (prior remediation took root audit 44→7, prod tree=0). **Do NOT `npm audit fix
--force`** — it would downgrade `firebase-admin`.

## Functions lint
`eslint .` in `functions/` exited **0** — clean. (`functions/node_modules` had to be
installed first; this fresh worktree ships none.)

## Findings
### 🔴 Critical
_(none)_
### 🟠 Likely
_(none — 0 high/critical advisories)_
### 🟡 Risk
- **6 moderate + 1 low advisory in the `firebase-admin`/`@google-cloud/storage` dev chain.**
  No non-breaking fix; downgrading `firebase-admin` is worse than the advisory. WHY 🟡: these
  are in the admin SDK used by Cloud Functions / scripts, not the shipped browser bundle
  (prod tree = 0 vulns). FIX: leave as-is; re-evaluate when `firebase-admin` ships a patched
  `@google-cloud/storage`. `esbuild` (low) + `gaxios` (moderate) have non-breaking fixes if a
  targeted bump is ever wanted, but neither reaches production.

### ℹ️ Info — outdated (held back intentionally; major bumps are migrations)
- Held on majors by design: `react`/`react-dom` 18→19, `firebase` 10→12, `eslint` 8→10,
  `tailwindcss` 3→4, `vite` 7→8, `react-router-dom` 6→7, `@dnd-kit/sortable` 8→10,
  `lucide-react` 0.344→1.x, `@vitejs/plugin-react` 4→6. Each is a breaking migration, not a
  routine patch — out of scope for a read-only sweep. `firebase 10→12` and `react 18→19` are
  the two with real migration cost; note before a large feature series.
- Safe patch/minor drift available: `vite` 7.3.5→7.3.6, `date-fns` 4.1→4.4,
  `firebase-admin` 14.0→14.1, `react-big-calendar` 1.19→1.20, `autoprefixer` 10.4.23→10.5.2,
  `vite-plugin-pwa` 1.2→1.3, `tailwind-merge` 2.6.0→2.6.1. Low-risk; not a finding.
