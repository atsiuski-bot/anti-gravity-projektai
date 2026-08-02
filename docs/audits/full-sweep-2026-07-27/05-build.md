# Production build evidence

Audited commit: `57a9324bbff91f7a7cc3347d488a00390d35b74f`

`npm run build` passed with Vite 7.3.5.

- Modules transformed: 2,952
- PWA strategy: `injectManifest`
- Precache entries: 46
- Precache size: 1,869.38 KiB
- Service worker output: present
- Dist size: 6,123,803 bytes
- Largest application entry: 413,845 bytes, 112.96 KiB gzip
- Firebase Firestore chunk: 371,226 bytes, 113.04 KiB gzip

The build emitted one material warning: `timerCommandEngine.js` is both dynamically imported
and statically imported, so the dynamic import does not create a separate chunk. This is
recorded as a P2 performance/architecture finding, not as a build failure.

