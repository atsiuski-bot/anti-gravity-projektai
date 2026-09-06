# 05 — Production build (deterministic)

**Command:** `npm run build` (Vite 7.3.6 + vite-plugin-pwa 1.2.0, `injectManifest`, iife SW)
**Exit code:** 0 · app bundle built in 1m 20s, service worker in 0.9s · **Raw:** `05-build-raw.txt` · **Manifest:** `05-build-stats.json`
**Findings:** 🔴 0 · 🟠 0 · 🟡 1 · ℹ️ 4

## Result

Build succeeds. All rubric thresholds pass:

| Check (FULL_SWEEP_PLAN deterministic rubric) | Threshold | Measured | Verdict |
|---|---|---|---|
| Largest JS chunk (gzip) | > 500 KB → 🟠 | `index-*.js` 123.5 KB gz (452.6 KB raw) | ✅ |
| Total `dist/` | > 10 MB → 🟡 | 7.0 MB | ✅ |
| Any single asset | > 500 KB → 🟡 | largest 452.6 KB (`index-*.js`); largest image 273 KB (`splash/apple-splash-1320-2868-dark.png`) | ✅ |
| PWA artifacts present | manifest + SW | `manifest.webmanifest`, `sw.js` (18.6 KB), `firebase-messaging-sw.js`, `_headers`, `_redirects` | ✅ |
| PWA precache | bloat | 47 entries · 1977.67 KiB (splash PNGs are **not** precached) | ✅ |

### Chunk map (top 10, gzip)

| Chunk | Raw | Gzip | Nature |
|---|---|---|---|
| `index-*.js` (app shell) | 452.6 KB | 123.5 KB | eager |
| `firebase-firestore-*.js` | 371.5 KB | 113.1 KB | eager vendor |
| `react-vendor-*.js` | 181.6 KB | 59.9 KB | eager vendor |
| `calendar-vendor-*.js` (react-big-calendar) | 170.8 KB | 55.4 KB | lazy (calendar views) |
| `ManagerView-*.js` | 96.9 KB | 25.8 KB | lazy |
| `firebase-auth-*.js` | 71.2 KB | 21.4 KB | eager vendor |
| `DailyStatistics-*.js` | 77.8 KB | 21.2 KB | lazy |
| `TaskCompletionSummaryModal-*.js` | 69.9 KB | 20.4 KB | lazy |
| `FilterPills-*.js` | 63.6 KB | 20.1 KB | lazy |
| `dndA11y-*.js` (dnd-kit) | 50.9 KB | 17.0 KB | lazy (board) |

First-load transfer (index + react + firestore + auth + CSS) is roughly **331 KB gzip**, which is
acceptable for a phone PWA. The manual chunking in `vite.config.js` (react / firebase-auth /
firebase-storage / firebase-firestore / lucide / calendar / date-fns / utils vendors) does its job:
the worker's hot path never pulls react-big-calendar or dnd-kit.

## 🟡 Risk

- 🟡 **One Vite warning: `src/utils/sessionAdmin.js` is `import()`-ed dynamically by
  `src/utils/taskActions.js` but imported statically by `ActiveWorkSessions.jsx`,
  `UserManagement.jsx` and `utils/managerFinishTask.js`, so "dynamic import will not move module
  into another chunk".** The dynamic import therefore buys no code-splitting. If its purpose was
  splitting, it is dead weight (an async hop on the task-action hot path for nothing); if its
  purpose was to break a `taskActions <-> sessionAdmin` import cycle, it works but should say so
  in a comment so nobody "fixes" it back to a static import and re-introduces the cycle. Effort S.
  (`05-build-raw.txt` line 13.)

## ℹ️ Notes

- ℹ️ **Splash screens are 53 % of `dist/`.** 20 iOS splash PNGs = 3.7 MB of the 7.0 MB output.
  They are fetched by iOS only at install time and are excluded from the SW precache, so this is
  hosting weight, not runtime weight. Fine as is.
- ℹ️ **Self-hosted Firebase auth helper (`dist/__/auth/handler.js` 280 KB + `iframe.js` 288 KB).**
  This is the static copy that fixed the iOS-PWA login lockout. It is a vendored snapshot of the
  firebase SDK's auth helper and is **coupled to the installed `firebase` major (10.x)**. When the
  SDK is bumped (10 → 12 is pending, see `19-deps.md`) this copy must be refreshed in the same
  change or sign-in inside the installed iOS app may break again.
- ℹ️ **`firebase-firestore` is 113 KB gzip and eager.** It is the single largest vendor cost on
  every cold start. No action; this is the baseline.
- ℹ️ **Build time 1m 20s** on this machine (Windows, worktree). Fine for a human gate.
