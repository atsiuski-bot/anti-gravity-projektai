# Phase 05 — Build

**Status:** ✅ COMPLETE
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 2

## Method
`npm run build` → `vite build` (v5.4.21). Raw output in `build-raw.txt`. Exit code 0, 3004
modules transformed, PWA service worker generated. `dist/.vite/manifest.json` is NOT emitted
(`build.manifest` is off), so chunk sizes are read from the build log instead.

## Result
- **Build OK** — `✓ built in 6.90s`.
- **PWA artifacts present:** `dist/sw.js`, `dist/workbox-*.js`, `dist/manifest.webmanifest`
  (precache 32 entries / 1592 KiB).
- **`dist/` total ≈ 2.3 MB** (well under the 10 MB precache-bloat threshold).
- **Largest chunks (raw / gzip):**
  | chunk | raw | gzip |
  |---|---|---|
  | firebase-firestore | 479.1 KB | 114.4 KB |
  | index | 165.5 KB | 45.8 KB |
  | react-vendor | 161.6 KB | 52.7 KB |
  | calendar-vendor | 160.2 KB | 52.7 KB |
  | firebase-auth | 112.0 KB | 23.0 KB |

## Findings
### 🟡 Risk
- **`firebase-firestore` chunk is 479 KB raw / 114 KB gzip** — the single dominant payload,
  right at the 500 KB raw line. It is already code-split into its own chunk (good) and lazy
  boundaries exist, but on a cold load over field 4G it is the long pole. No action required
  now; flag if it crosses 500 KB on a firebase major bump.
  WHY: WORKZ's users are blue-collar staff on phones, often outdoors on weak signal — initial
  payload weight is a real UX cost, not just a metric.

### ℹ️ Info
- **Vite build manifest not emitted** (`build.manifest` disabled) — `05-build-stats.json`
  could not be copied. Chunk data above is from the build log, which is sufficient.
- **Browserslist DB is 6 months stale** ("caniuse-lite is 6 months old"). Cosmetic; a
  `npx update-browserslist-db@latest` clears the warning. No build impact.
