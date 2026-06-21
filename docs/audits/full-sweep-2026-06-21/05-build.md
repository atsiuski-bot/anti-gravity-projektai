# Phase 05 — Build

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 2

## Method

`npm run build` (`vite build` → `dist/`). Exit code, chunk sizes, total `dist/` size, and
PWA artifact presence checked against the §6.2 thresholds (vendor chunk > 500 KB gz → 🟠;
total `dist/` > 10 MB → 🟡; single asset > 500 KB raw → 🟡). Raw output in `05-build-raw.txt`;
parsed chunk stats in `05-build-stats.json`. `dist/.vite/manifest.json` was not emitted
(build manifest not enabled), so stats come from build stdout.

## Findings

### 🟡 Risk
- `dist/assets/TaskTimeLimitPopup-*.js` (built from `src/components/TaskTimeLimitPopup.jsx`)
  — the **TaskTimeLimitPopup chunk is 412.77 KB raw / 114.77 KB gz**, by far the largest
  app (non-vendor) chunk and ~5× the next page chunk — WHY: a single "popup" component
  carrying that much code almost certainly statically bundles a heavy dependency (the
  `react-big-calendar` + `date-fns` calendar stack). It is loaded as its own lazy chunk,
  so it does not bloat first paint, but any view that imports it pays a 115 KB gz download —
  FIX: confirm what it pulls in (`react-big-calendar`); if the calendar is only needed in a
  sub-view, split it behind a further dynamic import or move the heavy dep out of the popup.
  (Within the rubric's hard threshold — gz < 500 KB — so 🟡, not 🟠. The `perf` reasoning
  dimension may corroborate.)

### ℹ️ Info
- `(build)` — **Build succeeds, exit 0**, 2942 modules transformed in 10.81s. Total `dist/`
  = **2.0 MB** (well under the 10 MB PWA-precache ceiling). Largest vendor chunk is
  `firebase-firestore` at 426 KB raw / 106 KB gz — expected for the Firestore SDK, not a
  finding — WHY: build gate is green — FIX: none.
- `(PWA)` — **PWA artifacts present and valid**: `dist/manifest.webmanifest`, `dist/sw.js`,
  and `dist/workbox-676600ea.js` all generated; precache = 21 entries (1383.82 KiB) — WHY:
  PWA installability + offline precache are intact — FIX: none. (Browserslist `caniuse-lite`
  is ~6 months stale — a cosmetic warning, folded into the deps phase.)
