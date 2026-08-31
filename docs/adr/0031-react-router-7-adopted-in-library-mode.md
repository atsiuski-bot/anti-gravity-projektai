# ADR 0031 — React Router 7, adopted in library mode

Status: Accepted · Date: 2026-08-31 · Supersedes [ADR 0030](./0030-react-router-7-is-deferred-on-stated-conditions.md)

## Context

[ADR 0030](./0030-react-router-7-is-deferred-on-stated-conditions.md) deferred the
`react-router-dom` 6 → 7 major on three stated conditions, and left one follow-up open: **decide
the endgame — migrate to v7, or delete react-router entirely.** The 2026-08-31 weekly dependency
audit forced the answer. Two advisories against `react-router` still have no fix in any 6.x
release:

- **GHSA-wrjc-x8rr-h8h6** — open redirect via a backslash in `<Link>` and `useNavigate`
  (CVE-2025-68470 bypass), vulnerable range `>=6.0.0 <7.18.0`.
- **GHSA-337j-9hxr-rhxg** — arbitrary constructor injection via `deserializeErrors()` during SSR
  hydration, vulnerable range `>=6.4.0 <7.18.0`.

Both are still unreachable against this app's usage, exactly as ADR 0030 argued. What changed is
not the reachability but the **standing of the argument**: this is the only advisory in the whole
tree that lands in code shipped to a user's browser — every other finding sits in dev tooling or
has no upstream fix — and a reachability claim about our own usage is a promise the codebase has
to keep forever. `npm audit` re-offers the major after every install, so the choice was between
carrying that argument indefinitely and spending it once.

The migration itself is small because ADR 0030's deferral was not standing still: **both v7 future
flags were already enabled** on `BrowserRouter`, which is what the official v6 → v7 upgrade guide
defines "no breaking changes" as. Of the six flags the guide lists, four (`v7_fetcherPersist`,
`v7_normalizeFormMethod`, `v7_partialHydration`, `v7_skipActionErrorRevalidation`) apply only to a
data router, which this app does not have. The other two were already on:

- `v7_relativeSplatPath` — needs code changes only for multi-segment splat routes
  (`<Route path="dashboard/*">`). This app has two literal routes and no splat at all.
- `v7_startTransition` — needs code changes only when `React.lazy` is called **inside** a
  component. `App.jsx` calls `lazyWithRecovery` at module scope, which is the required shape.

The guide's remaining items do not apply: `json()` / `defer()` are deprecated on the loader path
and this app has no loaders; the Node 20 / React 18 floors are already met (Node 22, React 18.2).

## Alternatives considered

- **Delete react-router entirely.** ADR 0030 recorded this as the possibly-better endgame: two
  literal routes and a query-param reader barely need a router, and removing it would retire this
  advisory class permanently instead of resetting it to the next major. Rejected as strictly
  larger than the bump it avoids — it would re-implement the history and `searchParams` semantics
  `NavigationContext` depends on, i.e. hand-rolling the exact code whose CVEs we are trying to
  stop tracking. Still the better answer if a v8 major ever costs more than this one did.
- **Consolidate onto the `react-router` package.** The upgrade guide's optional final step:
  uninstall `react-router-dom` and import everything from `react-router`, since v7 merged the
  packages. Rejected for this change: `react-router-dom@7.18.3` is a published, supported
  re-export of `react-router@7.18.3` (its entire source is `export * from "react-router"` plus the
  two DOM-only symbols), so it closes both advisories identically while touching three fewer
  files. Worth doing on its own, not folded into a security bump.
- **Stay on 6.x and keep the deferral.** Rejected: the deferral's own re-evaluation trigger has
  fired. ADR 0030 said to revisit "when a **third** advisory lands on the 6.x line, or when 6.x
  stops receiving fixes at all" — and the second condition is now visible: both advisories are
  fixed in 7.18.0 and in **no** 6.x release, which is 6.x declining a fix rather than not yet
  shipping one.

## Decision

**Move to `react-router-dom` 7.18.3 and stay in library mode.** The app keeps `BrowserRouter` +
`<Routes>` / `<Route>`; it does not adopt the React Router Vite plugin, framework mode, a data
router, loaders/actions, or SSR. Two source changes were needed in total:

1. `package.json`: `react-router-dom` `^6.30.6` → `^7.18.3` (plus the lockfile).
2. `src/App.jsx`: the `future={{ v7_startTransition, v7_relativeSplatPath }}` prop is removed.
   Both flags are unconditional behaviour in v7 and the keys no longer exist in the runtime
   (verified: zero occurrences of `v7_` in the installed `react-router` dist), so passing them
   would be dead config.

**Library mode is now the standing constraint**, and it is what section 4 of
[`src/__tests__/sourceConsistency.test.js`](../../src/__tests__/sourceConsistency.test.js)
defends. Its assertions are unchanged from ADR 0030 — no `<Link>` / `<NavLink>` / `<Form>` import,
no data-router symbol, no namespace import, every navigation target a hardcoded literal, no SSR
entry point — but their **justification** has changed. They are no longer the price of running
known-vulnerable code; they are the shape of the router surface this app deliberately keeps.
Navigation is tab-based through `NavigationContext`; the router exists to own two routes, the
history entry and `?tab=`. Widening that surface is a real architectural decision, so this gate
now asks for **an updated ADR**, not a version bump.

## Consequences

- **`npm audit` drops from 8 moderate to 6 moderate**, and the shipped-to-browser exposure goes to
  zero. The residual 6 are the `uuid` → `gaxios` / `teeny-request` / `@google-cloud/storage`
  cluster, which reaches us only through the `firebase-admin` **devDependency**. That set is
  unchanged and still accepted; `npm audit fix --force` still proposes `firebase-admin@10`, a
  **downgrade**, and must not be run.
- **The dependency graph gained two transitive packages and lost one**: `@remix-run/router` is
  gone (v7 folded it in), and `cookie` + `set-cookie-parser` arrive as `react-router` dependencies.
  They exist for v7's server-side cookie helpers, which this app never imports.
- **The bundle grew ~20 KiB precached** (47 entries, 1957.29 → 1977.32 KiB). `react-vendor` is
  181.63 kB / 59.88 kB gzipped. Vite's `manualChunks` still routes it correctly: the
  `node_modules/react-router` test in `vite.config.js` matches both packages unchanged.
- **`v7_startTransition` is now permanent, not a flag.** Router state updates run inside
  `React.useTransition`. The constraint it carries — `React.lazy` must stay at module scope —
  is no longer opt-out, so a future `lazy()` call inside a component would break navigation rather
  than merely warn.
- **Verified by an actual browser run, not by lint and build alone.** ADR 0030 named this as the
  reason to defer: no test drives a route transition, because sign-in runs through a Google popup
  an automated browser cannot script. The dev-only test account from
  [ADR 0014](./0014-dev-test-login-and-visual-qa.md) is what closed that gap here. Exercised on
  the running app against real production data: the unauthenticated `/` → `/login` redirect
  (`<Navigate>`), the post-login `navigate('/')` transition, the lazy-loaded route boundary, all
  seven tabs on desktop and the mobile tab bar at 375 px, a cold reload on `/?tab=users`
  restoring the deep-linked tab, and `history.length` holding flat across tab switches (proving
  `setSearchParams(…, { replace: true })` still replaces rather than pushes). Zero console errors
  throughout.
- **One pre-existing defect was found during that run and deliberately not fixed here.** On a
  signed-out boot, `NavigationContext`'s `?tab=` mirror and `ProtectedRoute`'s
  `<Navigate to="/login" />` race in the same commit; the `replace` can win and clobber the
  pending redirect, leaving `/?tab=tasks` rendered as an empty `#root` — a white screen. It was
  **bisected against the exact pre-change baseline** (`react-router-dom` 6.30.6 with both future
  flags restored) and reproduces there identically, 3 probes out of 3 on each version, so it is
  not caused by this upgrade. Tracked separately.

## Follow-ups

1. **Fix the signed-out boot race** between the `?tab=` mirror and the `/login` redirect
   (pre-existing; see above). This is a white screen for a real user, and it is the higher-value
   piece of work this change uncovered.
2. **Optionally consolidate onto the `react-router` package** (drop the `react-router-dom`
   re-export shim, rewrite three import lines) — cosmetic, deferred above.
