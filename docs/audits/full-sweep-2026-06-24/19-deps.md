# Phase 19 — Dependencies (outdated · audit · functions lint)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 3

## Method

Root + `functions/` subtree: `npm outdated`, `npm audit --json`
(`19-audit.json` / `19-functions-audit.json`), and `npm --prefix functions run lint`.

## Findings

### ✅ Functions lint — clean
`functions/` eslint exited **0**. (Recorded here per the command's functions-lint step.)

### 🟡 Risk — npm audit: 7 root + 9 functions moderate advisories (ACCEPTED, do not force)
- **Root: 7 vulns (1 low, 6 moderate), 0 high/critical.** Prod tree = 128 deps; the
  vulnerable packages are all **dev-only**:
  - 6 moderate: the `firebase-admin → @google-cloud/storage → {teeny-request, retry-request,
    gaxios} → uuid` chain. `firebase-admin` is a **devDependency** (used by maintenance
    scripts), never bundled into the client. The `uuid` advisory is "missing buffer bounds
    check when `buf` is provided" — not reachable through the SDK's usage.
  - 1 low: `esbuild` dev-server arbitrary-file-read **on Windows, dev server only**. Not a
    production exposure (esbuild is already latest under Vite).
  - npm's only "fix" downgrades into breaking changes; matches the documented accepted state
    (memory: *dependency-vuln-remediation* — 44→7, prod tree = 0). **Do not `audit fix --force`.**
- **Functions: 9 moderate, 0 high/critical.** All transitive under the **official
  `firebase-admin` ^13 / `firebase-functions` ^7** SDKs (same uuid/gaxios chain). npm's
  suggested "fix" is a **major *downgrade*** of `firebase-admin` to 10.3.0 / `firebase-functions`
  to 4.9.0 — i.e. a regression, not a fix. These resolve only when the upstream Firebase SDKs
  bump their pins. **Accept; do not downgrade.**

### ℹ️ Info — outdated (held back deliberately, not failures)
1. **React 18 → 19, react-dom 18 → 19, react-router 6 → 7** held at 18/6. A React 19 major
   is a deliberate, separate migration (concurrent-mode + router v7 data APIs), not drift.
   `@types/react` 18 → 19 held to match.
2. **`firebase` 10 → 12, `tailwindcss` 3 → 4, `vite` 7 → 8, `eslint` 8 → 10,
   `@vitejs/plugin-react` 4 → 6, `lucide-react` 0.344 → 1.21** — each is a major with its own
   migration cost; staying pinned is intentional. `tailwind 4` in particular is a config-format
   rewrite. `vite 8` is capped by the PWA-plugin peer range.
3. **Safe minors available**: `date-fns` 4.1→4.4, `react-big-calendar` 1.19→1.20,
   `vite-plugin-pwa` 1.2→1.3, `autoprefixer` 10.4→10.5, `tailwind-merge` 2.6.0→2.6.1. Low-risk
   patch/minor bumps for the next housekeeping pass; none are security-driven.

## Summary
Lint (root + functions) green; audit posture is the known-accepted dev-only/transitive set
with **zero high/critical** and a **prod tree clean of the flagged advisories**. The only
standing item is the deliberate hold on framework majors.
