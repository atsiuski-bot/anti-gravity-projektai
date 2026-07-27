# Phase 05 - Build

**Status:** COMPLETE  
**Findings:** P0 0 / P1 0 / P2 1 / P3 1

## Method

Ran `npm run build`. The first sandboxed run failed because Vite/esbuild could not read the config through the managed filesystem sandbox, then an unsandboxed rerun built successfully. Raw output is in `05-build-raw.txt`.

## Result

- Build succeeded in 11.55s.
- `dist/sw.js` exists.
- `dist/manifest.webmanifest` exists.
- PWA precache: 32 entries, 1602.80 KiB.
- Total `dist/` size: 2,262,691 bytes.
- Largest JS asset: `firebase-firestore-CznExc4L.js`, 479,115 bytes uncompressed.

## Findings

### P2

- `vite.config.js:18-37` - The generated PWA manifest has `lang: "en"` and `description: "Productivity App"`. WORKZ UI is Lithuanian and `index.html` is `lang="lt"`, so the install surface can present the app in the wrong language. Add `lang: "lt"` and Lithuanian app description to the PWA manifest.

### P3

- Build prints a stale Browserslist/caniuse-lite warning. This does not break the artifact, but browser support data should be refreshed during dependency maintenance.
