# Phase 05 — Build (vite)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 0 · ℹ️ 3

## Method

`npm run build` → `vite build`. Raw output: `build-raw.txt`. Chunk + PWA-precache sizes
parsed from the build log; `dist/` inspected on disk. No `dist/.vite/manifest.json` is
emitted (Vite `build.manifest` is not enabled), so there is no `05-build-stats.json` —
sizes are taken from the build log instead.

## Findings

### ✅ Clean
- Build exited **0** in 14.49s. 2900 modules transformed. PWA `generateSW` produced
  `dist/sw.js` + `dist/workbox-2fbc6a65.js`; **precache 39 entries / 1626.81 KiB (~1.59 MB)**.
- `dist/manifest.webmanifest` present (name, icons 192+512 incl. maskable, start_url, display).
- Total `dist/` = **6.9 MB** (threshold 🟡 at >10 MB — under). No single asset > 500 KB.

### Chunk profile (largest, gzip)
| chunk | raw | gz |
|---|---|---|
| `firebase-firestore` | 369.8 kB | 112.7 kB |
| `index` (app entry) | 275.2 kB | 76.2 kB |
| `calendar-vendor` | 170.8 kB | 55.4 kB |
| `react-vendor` | 161.3 kB | 53.0 kB |
| `DailyStatistics` | 87.0 kB | 22.3 kB |
| `ManagerView` | 76.8 kB | 21.0 kB |

No vendor chunk exceeds the 🟠 threshold (500 kB gz). Code-splitting is healthy: per-view
chunks (`WorkerView`, `Reports`, `TaskModal`, `ManagerView`, `DailyStatistics`) are lazy,
and the heavy SDKs (`firebase-firestore`, `firebase-auth`, `firebase-storage`,
`calendar-vendor`, `date-vendor`) are isolated vendors.

### ℹ️ Info
1. **`firebase-firestore` (112.7 kB gz) is the single heaviest chunk** — inherent to the
   Firestore web SDK v10. Migrating to a leaner query surface or v12 modular tree-shaking
   could trim it, but it is loaded once and cached by the SW. Not actionable now.
2. **`dist/logo.jpg` = 324 kB** ships uncompressed-ish at the app root. Under the 500 kB
   flag, but it is the largest single static asset; a WebP/AVIF re-encode would cut it
   substantially. Cosmetic.
3. **Browserslist caniuse-lite is ~6 months old** (build warned). Cosmetic — does not affect
   correctness; refresh with `npx update-browserslist-db@latest` at the next dep bump.
