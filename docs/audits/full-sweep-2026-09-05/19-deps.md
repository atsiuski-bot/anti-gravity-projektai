# 19 — Dependencies & Cloud Functions lint (deterministic)

**Commands:** `npm audit --json` · `npm outdated --json` (root and `functions/`) ·
`npm --prefix functions run lint` · **Raw:** `19-deps-audit-{root,fns}.json`,
`19-deps-outdated-{root,fns}.json`, `19-fns-lint-raw.txt`
**Findings:** 🔴 0 · 🟠 2 · 🟡 2 · ℹ️ 5

## Cloud Functions lint

`eslint .` in `functions/` → **exit 0, clean.** (`firebase-admin` 14.3.0, `firebase-functions`
7.3.2, engines `node 22`; the deploy-shape smoke `discovery.test.cjs` loads `functions/index.js`
and confirms 24 endpoints — 15 event, 3 callable, 6 schedule — all gcfv2 in `europe-west1`.)

## Vulnerability audit

| Tree | critical | high | moderate | low | total |
|---|---|---|---|---|---|
| root (`package.json`, 13 deps + 18 devDeps) | 0 | **2** | 6 | 1 | 9 |
| `functions/` (2 deps + 1 devDep) | 0 | 0 | 8 | 0 | 8 |

**Nothing shipped to the browser is affected.** Every root advisory sits in the build/test
toolchain (`autoprefixer`/Babel/workbox → `browserslist`; `vite-plugin-pwa` → `workbox-build` →
`ajv` → `fast-uri`; `tailwindcss` → `postcss-selector-parser`; the root *devDependency*
`firebase-admin` used only by the emulator suites). The `functions/` advisories are the known
`firebase-admin` → `@google-cloud/storage` → `uuid` echo chain plus `qs` under Express.

### 🟠 Likely (rubric: every high advisory is 🟠)

- 🟠 **`browserslist` 4.28.1 — HIGH ×2** (unbounded memory growth via distinct query results;
  prototype write via untrusted `browserslist-stats.json`). Transitive via `autoprefixer`,
  `@vitejs/plugin-react` → `@babel/helper-compilation-targets`, and `vite-plugin-pwa` →
  `workbox-build` → `core-js-compat`. **Build-time only**, and neither trigger (attacker-controlled
  stats file / unbounded distinct queries) exists in this build. `npm audit` reports a
  non-breaking fix (`fixAvailable: true`). Effort S — a lockfile bump, no code change.
- 🟠 **`fast-uri` 3.1.5 — HIGH ×4** (SSRF / host confusion in URI normalisation). Transitive via
  `vite-plugin-pwa` → `workbox-build` → `ajv` 8.20. **Build-time only** (ajv validates the
  workbox config; it never sees a network URI at runtime). Non-breaking fix available. Effort S.

### 🟡 Risk

- 🟡 **`qs` 6.15.3 (functions/, moderate ×2 — array-limit bypass, DoS via attacker-controlled
  `isBuffer`)** is the one advisory that is **runtime-shipped**: path
  `firebase-functions@7.3.2 → express@5.2.1 → body-parser@2.3.0 → qs`. Exposure is low (callables
  take JSON bodies; no WORKZ function reads `req.query`), but it runs in prod. `fixAvailable: true`
  (non-breaking) — but a functions lockfile change only reaches prod through the human-only
  functions deploy. Effort S.
- 🟡 **ESLint 8.57.1 in both packages is end-of-life** (Oct 2024). It still passes cleanly, but
  gets no fixes; `eslint-plugin-react-hooks` 4.6.2 (latest 7.1.1) does not know React 19 rules.
  Migration is a flat-config rewrite (`eslint.config.js`) — Effort M, separate change.

### ℹ️ Accepted / informational

- ℹ️ **The `firebase-admin` → `@google-cloud/storage` → `retry-request` / `teeny-request` /
  `gaxios` → `uuid` moderate chain (both trees).** `npm audit`'s only "fix" is
  `firebase-admin@10.3.0` (`isSemVerMajor: true`, i.e. a **downgrade** four majors back) — not a
  fix. The `uuid` advisory (v3/v5/v6 buffer bounds) does not apply: the chain calls `uuid.v4()`
  only. This is the already-accepted "uuid echoes" register entry; nothing new. Root pins
  `firebase-admin` 14.0.0 while the range allows 14.3.0 — bumping does not clear it (functions at
  14.3.0 shows the identical chain). `gaxios` alone has a non-breaking fix.
- ℹ️ **`postcss-selector-parser` low** — Tailwind 3.4 build path; non-breaking fix available;
  irrelevant at runtime.
- ℹ️ Root `overrides: { undici: ^6.28.0 }` is intentional (documented rationale) — keep.

## Outdated packages

### Major drift (deliberate migrations, not "run npm update")

| Package | Current | Latest | Note |
|---|---|---|---|
| `firebase` | 10.14.1 | 12.18.0 | Two majors. Must move **together with** `@firebase/rules-unit-testing` (3.0.4 → 5.0.2) **and** the self-hosted `__/auth/*` helper (see `05-build.md`). |
| `react` / `react-dom` / `@types/react*` | 18.3.1 | 19.2.8 | With `@vitejs/plugin-react` 4.7 → 6.1 and `eslint-plugin-react-hooks` 4.6 → 7.1. |
| `vite` / `vitest` | 7.3.6 / 4.1.9 | 8.2.2 / 5.0.0 | Move together (established rule). |
| `tailwindcss` / `tailwind-merge` | 3.4.19 / 2.6.0 | 4.3.3 / 3.6.0 | v4 is a config-model rewrite; the design-token config would need re-porting. Move together. |
| `eslint` (+ plugins) | 8.57.1 | 10.10.0 | EOL engine — see 🟡 above. |
| `lucide-react` | 0.344.0 | 1.41.0 | About two years of icon releases behind; API is stable, mostly new icons. |
| `@dnd-kit/sortable` | 8.0.0 | 10.0.0 | With `@dnd-kit/core` 6.3.1; board drag-and-drop is lazy-loaded. |
| `jsdom` | 27.4.0 | 29.1.1 | Test env only. |

### In-range updates the lockfile is holding back (`wanted` > `current`)

`@types/react` 18.3.27→18.3.31 · `autoprefixer` 10.4.23→10.5.5 · `date-fns` 4.1.0→4.4.0 ·
`firebase-admin` (root devDep) 14.0.0→14.3.0 · `postcss` 8.5.26→8.5.28 · `react-big-calendar`
1.19.4→1.20.0 · `tailwind-merge` 2.6.0→2.6.1 · `vite-plugin-pwa` 1.2.0→1.3.0 · `vitest`
4.1.9→4.1.11. ℹ️ — a plain `npm update` would take all of these; low risk, but it is a change and
this sweep makes none.

`functions/`: only `eslint` is behind (dev). Runtime deps are current.
