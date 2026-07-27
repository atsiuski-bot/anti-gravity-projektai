# Phase 05 — Production build and PWA artifacts

**Status:** ✅ COMPLETE  
**Findings:** P0 0 · P1 0 · P2 1 · P3 0

## Method

Ran `npm run build`, inspected the generated PWA manifest and generated hosting headers, and reviewed Vite's chunk report.

## Result

- Build passed: 2,946 modules transformed.
- PWA generated successfully: 45 precache entries, 1,832.55 KiB total.
- `manifest.webmanifest` uses the public brand `Gildija`, Lithuanian language, standalone display, and 192/512 regular plus maskable icons.
- `dist/sw.js` and `dist/_headers` are present.
- Largest application asset: 390.70 KiB raw / 105.95 KiB gzip.
- Largest Firebase chunk: 371.23 KiB raw / 113.04 KiB gzip.
- No chunk exceeds the sweep's 500 KiB gzip threshold.

## Finding

### [P2] Timer command module is still eagerly bundled

Vite reports that `timerCommandEngine.js` is dynamically imported by `AuthContext` but statically imported by all timer controls and recovery hooks, so the dynamic import cannot create a separate chunk. This is not a correctness defect, but the misleading split adds maintenance noise and should be simplified or genuinely isolated.

