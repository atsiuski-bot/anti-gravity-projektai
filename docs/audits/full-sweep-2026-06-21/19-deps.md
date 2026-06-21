# Phase 19 — Dependencies

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 3 · 🟡 0 · ℹ️ 3

## Method

`npm outdated` (→ `19-outdated-raw.txt`) and `npm audit --json` (→ `19-audit-raw.json`),
parsed for advisory severity and version drift. Each high/critical advisory is weighed for
whether it actually ships in the **client bundle** (Vite tree-shakes anything not imported
from `src/`; devDependencies never ship), per §6.3. Single root `package.json` — no
`functions/` subtree.

**Audit totals:** 44 advisories — **1 critical · 17 high · 24 moderate · 2 low** across 799
installed packages (208 prod / 528 dev / 113 optional).

> **Worktree note:** `npm outdated` shows `Current: MISSING` for every package because this
> worktree has **no local `node_modules`** — Node resolves up the tree to the parent repo's
> install, which is why `npm run lint`/`build` still succeed. The audit is computed from the
> committed `package-lock.json`, so the advisory list is valid; only the "Current" column is
> a worktree artifact (ℹ️, not a finding).

## Findings

### 🟠 Likely
- `package.json:16` (`firebase-admin` in **`dependencies`**) — the **server-side Firebase
  Admin SDK is a production dependency of a client-only PWA**, and it is the source of the
  single **CRITICAL** advisory (`protobufjs` — arbitrary code execution) plus ~8 of the
  HIGH advisories (`@grpc/grpc-js`, `undici`, `form-data`, `fast-uri`, `fast-xml-builder`,
  `@babel/plugin-transform-modules-systemjs` via its build graph) — WHY: `firebase-admin`
  is imported in exactly one place, the root one-off debug script `fetch_task.cjs:1-2`
  (hardcoded `TASK_ID`, not part of the app or the Vite build), and **nowhere in `src/`**.
  Vite therefore tree-shakes it out of `dist/`, so these advisories do **not** reach the
  shipped client — but they inflate the install/audit surface and the supply-chain
  footprint of every `npm install` — FIX: move `firebase-admin` to `devDependencies` (or
  delete it and `fetch_task.cjs` if the debug script is obsolete). That single change clears
  the critical + most highs from the production dependency set.
- `package.json:21` (`react-router-dom` ^6.22.1) — **HIGH advisory `@remix-run/router` —
  React Router XSS via open redirects** — WHY: unlike the firebase-admin tree, react-router
  **does ship in the client bundle** (used for the `/login` route per CLAUDE.md), so this is
  the one high advisory with genuine end-user exposure. `npm` reports the in-range "Wanted"
  as 6.30.4, but the advisory remains flagged — the patched line is React Router **v7**
  (a major-version migration) — FIX: evaluate the v7 upgrade, or confirm the app's redirect
  surface is closed (no user-controlled redirect targets) and document the accepted risk.
- `package.json:36` (`vite` ^5.1.4) — **HIGH advisory — Vite path traversal in optimized
  deps `.map` handling** — WHY: exploitable only against the running **dev server**, not the
  static `dist/` deploy, so production users are not exposed; still a real risk to any
  developer running `npm run dev` with the network host enabled (which WORKZ does, for phone
  testing) — FIX: bump Vite to the patched 5.x release (in-range, low-risk) on the next
  dependency pass.

### ℹ️ Info
- `(npm audit)` — **The headline "1 critical / 17 high" overstates user-facing risk.** The
  critical (`protobufjs`) and the majority of highs are transitive under `firebase-admin`
  or build-only tooling (`serialize-javascript`, `minimatch`, `picomatch`, `flatted`,
  `brace-expansion`, `lodash`/`lodash-es`) and never enter the shipped client bundle. The
  genuinely client-shipping highs are **react-router** (above). Triage by reachability, not
  by raw count — WHY: avoids burning effort on advisories that Vite already tree-shakes — FIX:
  fix the two reachable items (react-router, vite) first; the rest resolve when firebase-admin
  leaves `dependencies`.
- `(npm outdated)` — **Major-version drift** on several packages, each a non-trivial
  migration: `react`/`react-dom` 18→19, `firebase` 10→12, `react-router-dom` 6→7,
  `firebase-admin` 13→14, `lucide-react` 0.344→1.21, `tailwind-merge` 2→3 — WHY: staying on
  majors-behind is fine short-term but compounds migration cost and keeps the app on
  unpatched lines (see react-router) — FIX: none urgent; plan the React 19 + Firebase 12
  bumps as a deliberate, separately-tested change, not folded into a feature PR.
- `(browserslist)` — `caniuse-lite` is ~6 months stale (cosmetic build warning) — FIX:
  `npx update-browserslist-db@latest` at convenience; no behavioural impact.
