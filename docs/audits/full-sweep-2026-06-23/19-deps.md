# Phase 19 — Dependencies

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 2 · 🟡 1 · ℹ️ 2

## Method
`npm outdated` (`19-outdated-raw.txt`) and `npm audit --json` (`19-audit-raw.json`) against
the root `package-lock.json`. There is a separate `functions/package-lock.json` (Cloud
Functions subtree) that was NOT audited in this pass — see the meta note below.
`npm audit` reports **47 vulnerabilities: 2 critical · 17 high · 26 moderate · 2 low.**

## What actually ships to the browser
Severity counts overstate user-facing risk: most flagged packages are **build/test/admin
tooling that never enters the client bundle.** Triaged by reachability:

| Package | Sev | Direct | Ships to browser? | Note |
|---|---|---|---|---|
| `react-router-dom` / `react-router` / `@remix-run/router` | HIGH | yes | **YES** | XSS via open-redirect (protocol-relative `//` URL) |
| `firebase` (`@firebase/auth` → `undici`) | MOD | yes | **YES** | `undici` advisory is a Node path; web SDK uses fetch/XHR — low real exposure |
| `vitest` / `@vitest/mocker` | CRIT | yes | no (test) | RCE only when Vitest UI server is listening — dev only |
| `vite` / `esbuild` / `vite-node` | HIGH/MOD | yes | no (dev) | dev-server path traversal / request bouncing |
| `protobufjs`, `firebase-admin`, `@google-cloud/*`, `google-gax` | CRIT/MOD | partly | no (admin) | admin SDK / Cloud Functions build chain |
| `postcss`, `workbox-build`, `@rollup/plugin-terser`, `lodash(-es)` | MOD/HIGH | partly | no (build) | build-time only |

## Findings
### 🟠 Likely
- **`react-router-dom` open-redirect XSS (HIGH) — this one ships.** Versions ≤ 6.30.3 are
  vulnerable; the repo pins `^6.22.1` (locked 6.30.4 per `npm outdated` "Wanted"). A
  same-origin redirect to a path starting `//` can be reinterpreted as a protocol-relative
  URL → open redirect / reflected XSS vector. WORKZ routes almost entirely through the
  in-app tab context (only `/login` is a real route), so the exploitable surface is small,
  but this is the only HIGH advisory that reaches end users.
  FIX: bump react-router-dom to the patched 6.30.x (the lockfile already wants 6.30.4 — a
  plain `npm install` / `npm audit fix` resolves it without the v7 major).
- **`npm audit fix` is available for the non-breaking subset.** `npm audit` reports a
  fixable set that needs no major bumps. Running it would clear the shipped `react-router`
  advisory and several dev-tool ones without touching `firebase`/`react`/`vitest` majors.
  FIX: run `npm audit fix` (NOT `--force`), re-run lint+build+test, commit the lockfile.

### 🟡 Risk
- **Critical advisories are real but dev/admin-only.** `vitest` (RCE via UI server) and
  `protobufjs` (code injection) are the two CRITICALs; neither is in the production bundle.
  They are a developer-machine / CI exposure, not a user exposure — patch on the next dep
  sweep, not as an emergency.

### ℹ️ Info
- **Major version drift (migration risk, not a vuln):** `firebase` 10→12, `react`/`react-dom`
  18→19, `react-router-dom` 6→7, `lucide-react` 0.344→1.21, `tailwind-merge` 2→3,
  `date-fns` is current (4.4.0). Each major is a deliberate migration, not an `audit fix`.
  Stay on the 18/10/6 line until a planned upgrade window.
- **`functions/` subtree not audited.** A second `functions/package-lock.json` exists (Cloud
  Functions). It was out of scope for this root-level pass; a follow-up `cd functions && npm
  audit` is warranted given `firebase-admin`/`google-gax` advisories cluster there. (Also
  corrects the plan's "single root package.json" claim.)
