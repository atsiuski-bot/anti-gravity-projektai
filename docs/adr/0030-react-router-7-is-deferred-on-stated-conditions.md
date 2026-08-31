# ADR 0030 — React Router 7 is deferred on stated conditions, not skipped

Status: **Superseded by [ADR 0031](./0031-react-router-7-adopted-in-library-mode.md)** (2026-08-31) · Date: 2026-08-25

> The deferral recorded below ended as this ADR's own follow-up asked it to: the endgame was
> decided in favour of migrating. `react-router-dom` is now 7.18.3 and both advisories are
> closed. The three conditions are still enforced by section 4 of `sourceConsistency.test.js`,
> but they now defend **library mode as an architectural choice**, not a known-vulnerable
> dependency — see ADR 0031 for the current reasoning. Everything below is kept as the record of
> why the bump was deferred between 2026-08-25 and 2026-08-31.

## Context

`9141d2e` bumped `react-router-dom` to 6.30.6 and closed GHSA-jjmj-jmhj-qwj2. Two advisories
against `react-router` survive that bump, and **neither has a fix in any 6.x release**:

- **GHSA-wrjc-x8rr-h8h6** — open redirect via a backslash in `<Link>` and `useNavigate`
  (CVE-2025-68470 bypass), vulnerable range `>=6.0.0 <7.18.0`.
- **GHSA-337j-9hxr-rhxg** — arbitrary constructor injection via `deserializeErrors()` during SSR
  hydration, vulnerable range `>=6.4.0 <7.18.0`.

`npm audit` therefore offers exactly one remedy — `react-router-dom@7.18.2`, a **major** — and will
keep offering it after every future `npm install`. The question this ADR settles is not "is a major
bump scary"; it is **whether the advisories describe code this app actually runs**, and if not, what
must stay true for that answer to remain valid.

**The app's entire router surface is four call sites.** Navigation in WORKZ is tab-based through
`NavigationContext`, not route-based, so the router does almost nothing:

- `src/App.jsx` — `BrowserRouter` with two literal routes (`/login`, `/`) and one
  `<Navigate to="/login" />` for the unauthenticated case. There is no catch-all route.
- `src/pages/Login.jsx` — one `useNavigate`, called as `navigate('/')`.
- `src/context/NavigationContext.jsx` — `useLocation` and `useSearchParams`; `setSearchParams`
  writes the **query component only**, which cannot change origin or path.
- Nothing else. No `<Link>`, no `<NavLink>`, no `<Form>`, no `createBrowserRouter` /
  `RouterProvider`, no `loader` / `action`, and no SSR or prerender entry point — the app is a pure
  client-side Vite SPA.

Against that surface both advisories are unreachable, for two different reasons:

- **`deserializeErrors` is on the data-router hydration path.** With no data router and no server
  render, that code path is never constructed. This is structural, not a matter of input.
- **The backslash open redirect needs a navigation target someone else can influence.** Every
  target in the app is a hardcoded literal. There is no route parameter, no `?redirect=` handling,
  and the one place that does read the URL on a cold start (`src/notifications/pushIntent.js`)
  feeds a **notification intent** into the tab context and strips the query — it never produces a
  router destination.

(`Linkify` renders user-pasted URLs as plain `<a target="_blank" rel="noopener noreferrer nofollow">`
anchors. That is an app-level surface with its own hardening, entirely outside react-router, and it
is not a precondition of this decision.)

The reachability argument is therefore a statement about **our usage**, not about the library — so
it has an expiry date, and the expiry conditions are the load-bearing part of this record. Until now
they existed only in a commit message, where nobody reading `npm audit` will ever find them.

## Alternatives considered

- **Bump to `react-router-dom` 7 now.** Closes both advisories outright. Rejected *for now*: it is a
  major on the one component that gates the entire app behind authentication, to remove a risk this
  app's usage does not carry — and it is the change we can prove the least. There is no end-to-end
  test of the login route (sign-in runs through a Google popup an automated browser cannot drive,
  which is why [ADR 0014](./0014-dev-test-login-and-visual-qa.md) exists at all), so the migration
  would be verified by lint, build and unit tests, none of which exercise a real route transition.
- **Delete react-router entirely.** Genuinely available: two literal routes, one redirect and a
  query-param reader do not obviously need a router, and removing it would retire this advisory
  class permanently rather than resetting it to the next major. Rejected as *larger* than the bump
  it avoids — it would re-implement history and `searchParams` semantics that `NavigationContext`
  depends on — but recorded because it may be the better endgame than a v7 migration.
- **Silence the audit** (an `overrides` pin, `--omit=dev`, or an ignore list). Rejected: it removes
  the signal without removing the risk, and it would hide the *next* advisory in the same package —
  the one that might actually be reachable.
- **Leave it in the commit message.** The status quo this ADR replaces. A reachability argument that
  lives in `git log` cannot be checked by the person or agent who next runs `npm audit`, and it
  silently becomes false the first time somebody adds a `<Link>`.

## Decision

**Stay on `react-router-dom` 6.30.6, and treat the deferral as conditional.** These three conditions
are what make the two advisories unreachable. If any one of them stops holding, the deferral is void
and closing the advisories — by migrating to v7 or by removing react-router — becomes the next
dependency task, ahead of the routine bumps.

1. **No `<Link>`, `<NavLink>` or `<Form>` from react-router anywhere in `src/`.**
2. **Every navigation target stays a hardcoded literal.** No `navigate(x)` or `<Navigate to={x} />`
   where `x` derives from the URL, a Firestore document, a notification payload, or any other
   input the app did not author.
3. **No data router and no server render** — no `createBrowserRouter` / `RouterProvider`, no
   `loader` / `action`, no SSR or prerender entry point.

Re-evaluate when a condition breaks, when a **third** advisory lands on the 6.x line, or when 6.x
stops receiving fixes at all — 6.30.6 is evidence that it still does.

## Consequences

- **`npm audit` will keep reporting these two moderate advisories, and that is the accepted
  baseline, not an oversight.** After the two lockfile bumps that shipped alongside this ADR
  (transitive `protobufjs` 7.6.4 → 7.6.5, and `esbuild` 0.27.7 → 0.28.2 via `vite` 7.3.6), the whole
  tree reads **8 moderate, 0 low**: the two react-router entries (counted against both
  `react-router` and `react-router-dom`) and the `uuid` → `gaxios` / `teeny-request` /
  `@google-cloud/storage` cluster, which reaches us only through the `firebase-admin`
  **devDependency**. None of it is shipped-browser exposure. An agent that finds this number
  unchanged should read this ADR rather than reach for `npm audit fix --force`, which proposes two
  unrelated majors (`react-router-dom@7`, `firebase-admin@10` — a *downgrade*). Plain
  `npm audit fix` is not the answer either: `gaxios` still advertises a non-breaking fix, but taking
  it was tried here and rewrote **124 lockfile lines while closing nothing** — the `uuid` advisory
  stays reachable through `teeny-request` regardless, so the churn buys no security and was
  reverted.
- **Condition 2 is the fragile one.** Conditions 1 and 3 are visible in an import list; condition 2
  is a property of every navigation call anyone writes in the future, including one added by an
  agent that never read this file.
- **The conditions are enforced, so the deferral cannot go quietly false.** Section 4 of
  [`src/__tests__/sourceConsistency.test.js`](../../src/__tests__/sourceConsistency.test.js) fails
  the ship on any of them. It reads **import specifiers**, not JSX — `<Link` also matches this
  repo's own `Linkify` and lucide's `LinkIcon`, whereas react-router's `Link` cannot be used without
  being imported — and it separately refuses a namespace import, which is the one hole that
  approach leaves. **When that gate goes red the answer is not to relax it:** the deferral is void
  and closing the advisories becomes the next dependency task.
- **The v7 `future` flags are already set** on `BrowserRouter` (`v7_startTransition`,
  `v7_relativeSplatPath`), so the eventual migration starts smaller than a cold one — deferring is
  not the same as standing still.
- **Verified for this record:** the router surface above was enumerated by grep over `src/`
  (3 files import from `react-router-dom`; `createBrowserRouter`, `RouterProvider`, `StaticRouter`,
  `HydratedRouter`, `hydrateRoot`, `renderToString` and react-router `<Link>`/`NavLink` return no
  hits), and the residual audit set was read from `npm audit` after both bumps. The guard was proven
  **discriminating**, not merely green: a temporary source file importing `Link` and
  `createBrowserRouter`, importing react-router as a namespace, calling `navigate(dest)` with a
  variable and calling `hydrateRoot(…)` turned all four assertions red at once, and each names the
  condition it defends. No application code changed for this ADR.

## Follow-ups

1. **Decide the endgame** — migrate to v7, or delete react-router and hand its two routes to
   `NavigationContext`. Worth answering before the next router advisory forces it.
