# 05 — Build (deterministic)

**Command:** `npm run build` (Vite production)
**Result:** ✅ PASS — built in 12.3 s. PWA `generateSW` mode: `dist/sw.js` +
`dist/manifest.webmanifest` present; **45 precache entries, 1 774.97 KiB**.

## Chunk notes

- Largest chunks: `firebase-firestore` 371 kB (113 kB gz), `index` 340 kB (93 kB gz),
  `calendar-vendor` 171 kB (55 kB gz), `react-vendor` 161 kB (53 kB gz).
- 🟡 Precache total ~1.77 MB — acceptable for a PWA that must work offline, but the
  `index` main chunk (340 kB) keeps growing; route-level splitting already exists
  (Dashboard/Login/views are separate chunks). Watch, no action required.
- `dist/.vite/manifest.json` not emitted (build manifest disabled) — `05-build-stats.json`
  therefore absent; chunk sizes recorded above from build output instead.

Raw output: `05-build-raw.txt`.
