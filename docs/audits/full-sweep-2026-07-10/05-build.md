# Phase 05 — Production build and PWA artifacts

**Status:** ✅ COMPLETE  
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 2

## Method

Ran `npm run build`, inspected the emitted file sizes, PWA web manifest, icon set, service worker, and precache summary. The build exited successfully.

## Findings

### 🟡 Risk

- `src/context/AuthContext.jsx:420` — the intended boot-time dynamic import of `timerCommandEngine` cannot create a lazy chunk because the same module is statically imported by timer components and hooks. **Why:** Vite must keep the module in the eager dependency graph. **Consequence:** the replay path does not gain the intended loading isolation and contributes to the initial application chunk. **Fix:** either accept and document eager loading, or move the replay-only surface into a module that is not also statically imported.

### ℹ️ Info

- The production build passed: 2,945 modules, 12.27 s, 69 emitted files, 6.08 MB total. No single emitted file exceeded the sweep's 500 KB threshold; the largest was 387,155 bytes. PWA precache is 45 entries / 1,829.13 KiB, below the 10 MB warning threshold.
- `caniuse-lite` is seven months old. This does not break the current build, but refreshing Browserslist data during a dependency-maintenance change will keep Autoprefixer compatibility decisions current. The sweep did not mutate dependencies.

## PWA verification

`manifest.webmanifest` is present and names the product `Gildija`, uses `lang: lt`, includes 192×192 and 512×512 regular and maskable icons, and uses standalone display mode. `sw.js` and the Workbox runtime are present. Vite's optional `.vite/manifest.json` is not enabled, so this sweep recorded equivalent build metrics in `05-build-stats.json` instead.
