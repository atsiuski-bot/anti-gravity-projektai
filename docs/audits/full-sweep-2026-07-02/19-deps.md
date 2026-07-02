# 19 — Dependencies (deterministic)

**Commands:** `npm outdated`, `npm audit`, `npm --prefix functions run lint`

## npm audit (root)

**7 vulnerabilities (1 low, 6 moderate)** — all in the `firebase-admin` →
`@google-cloud/storage` → `retry-request`/`teeny-request` chain, which is a
**dev-only dependency at the root** (scripts). This matches the previously ACCEPTED
residual state (`c0ab7f8`, do NOT `npm audit fix --force`). Production tree: 0. ✅ No change.

## npm outdated (root) — informational

Majors behind (deliberate pins, no action this sweep): React 18→19, Firebase SDK 10→12,
Tailwind 3→4, ESLint 8→10, Vite 7.3.5→8, react-router-dom 6→7, lucide-react 0.344→1.x.
Minor/patch drift: date-fns 4.1→4.4, autoprefixer, postcss, vite 7.3.5→7.3.6,
vite-plugin-pwa 1.2→1.3, firebase-admin 14.0→14.1, react-big-calendar 1.19→1.20.

- 🟡 **Firebase JS SDK 10.14.1 vs latest 12.x** — two majors behind on the *production*
  critical path (offline persistence, Firestore sync). Not a vulnerability today, but the
  longer the pin holds, the harder the eventual jump. Schedule a deliberate upgrade window.

## Functions subtree

`npm --prefix functions run lint` → ✅ PASS (exit 0). (`functions/node_modules` was empty in
this fresh worktree; installed locally for the gate — gitignored, no repo change.)
