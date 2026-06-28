# Phase 05 — Build (vite)

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 0 · ℹ️ 3

## Method
`npm run build` → `vite build` → `dist/` (+ `vite-plugin-pwa` generateSW). Raw output in
`build-raw.txt`. Chunk/asset sizes parsed from the build log; PWA artifacts and total
`dist/` size measured on disk. Plan §6.2 thresholds applied (vendor >500 KB gz → 🟠; total
`dist/` >10 MB → 🟡; single asset >500 KB → 🟡).

## Result
- **Build succeeded (exit 0)** — 1625 modules transformed, built in ~5.5 s.
- PWA: `generateSW` produced `dist/sw.js` + `dist/workbox-*.js`; **40 precache entries /
  1742 KiB**. `dist/manifest.webmanifest` present with `name:"Gildija"`, `start_url:"/"`,
  `display:"standalone"`, and icons 192+512 in both `any` and `maskable` purposes. ✓
- **Total `dist/` = 5.9 MB** (< 10 MB precache-bloat threshold).
- Largest chunks (raw / gz): `firebase-firestore` 371 KB / 113 KB · `index` 326 KB / 89 KB ·
  `firebase-firestore` and the vendor splits (`react-vendor` 161/53, `calendar-vendor`
  171/55) are all code-split. **No chunk exceeds 500 KB gz**; no single asset exceeds
  400 KB raw (largest image `pwa-512x512.png` 171 KB).

## ⚠️ Environment note (not a code defect)
The build **initially failed** with `Rollup failed to resolve import "@dnd-kit/core"`. Root
cause: this fresh worktree had no local `node_modules`, so Vite resolved against the
**parent checkout's** tree (which runs vite 5.4.21 and predates the `@dnd-kit` dependency
added for the priority board). `@dnd-kit/core`, `/sortable`, `/utilities` ARE declared in
this worktree's `package.json`; after `npm install` (gitignored `node_modules` only — no
tracked-source change) the build passed cleanly. This is the known fresh-worktree resolution
gap, not a missing-dependency defect that would surface in CI or a clean clone.

## Findings
### 🔴 Critical
_(none)_
### 🟠 Likely
_(none — no oversized vendor chunk)_
### 🟡 Risk
_(none — `dist/` 5.9 MB, no oversized asset)_
### ℹ️ Info
- No `dist/.vite/manifest.json` emitted (the Vite config does not set `build.manifest:true`),
  so `05-build-stats.json` was not produced — sizes were read from the build log instead.
- Build warns `caniuse-lite is 6 months old` — cosmetic; run `npx update-browserslist-db@latest`
  at some point. No build impact.
- `manifest.webmanifest` carries `"description":"Productivity App"` + `"lang":"en"` — generic
  English placeholders for a Lithuanian product. Cosmetic; recorded for `i18n-brand`.
