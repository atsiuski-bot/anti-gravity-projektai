# ADR 0029 — The Google sign-in helper is served first-party, but only where it must be

Status: Accepted · Date: 2026-08-19

## Context

A manager reported that the installed iOS app kept refusing to sign in, showing the coded message
`app/redirect-handshake-blocked`, while the same account signed in fine from a Safari tab.

[ADR 0014's](./0014-dev-test-login-and-visual-qa.md) sign-in path had already been narrowed once for
this device class: the installed iOS app was routed through `signInWithRedirect` because WebKit gives
a home-screen web app's popup a null `window.opener`, so the credential has nowhere to be posted back
to and `signInWithPopup` can never complete there. That fix was necessary but not sufficient, and the
reason is structural rather than incidental.

**The redirect's return leg reads the credential back through an iframe on the *helper's* origin.**
Firebase serves that helper from `darbo-planavimas.firebaseapp.com`, while the app is served from
`anti-gravity-projektai.pages.dev`. Those are different origins, so the iframe is third-party — and
Safari partitions third-party storage. The redirect comes home with nothing. Firebase documents this
exact configuration as unsupported ("[Best practices for `signInWithRedirect`
flows](https://firebase.google.com/docs/auth/web/redirect-best-practices)"), and Chrome has been
moving the same way since M115.

So both routes into the installed app were closed at once: the popup by the null opener, the redirect
by storage partitioning. Signing out of the installed app was a one-way door.

Two further facts shaped the decision:

- **The existing fallback was not a repair.** The login screen offered "open it in the browser", but
  an iOS home-screen web app has its own storage jar, separate from Safari. Signing in there does not
  sign in the icon; it silently relocates the person to Safari for good.
- **This failure cannot be diagnosed remotely.** `error_logs` requires `isAuthenticated()`, and a
  locked-out user by definition is not. The screenshot the user sends *is* the diagnostic channel.
  Recorded here so nobody plans a telemetry fix that cannot work; opening an unauthenticated write
  surface for it would be a far worse trade than the reporting gap.

## Alternatives considered

- **A different `persistence` setting.** The first hypothesis, and wrong. Persistence decides where
  an *already-obtained* session is stored; this failure happens strictly before a session exists, in
  the transport of the credential between origins. Every persistence mode returns the same nothing.
- **Move hosting to Firebase Hosting** so the app and `authDomain` share a domain. Fixes the cause,
  but trades a sign-in bug for a hosting migration off Cloudflare Pages.
- **A transparent reverse proxy** of `/__/auth/*` (Firebase's own recommendation). Cloudflare Pages
  cannot express it: `_redirects` proxies only relative URLs, a Worker route needs a zone we do not
  have on `*.pages.dev`, and the repo's root `functions/` directory is already Firebase Cloud
  Functions — mixing Pages Functions into it would make `firebase deploy` and Pages fight over the
  same folder. `_worker.js` advanced mode remains, but it seizes *all* routing and disables the
  `functions/` directory, putting `_redirects`/`_headers` behaviour at risk for the whole app.
- **Drive Google sign-in ourselves** (Google Identity Services + `signInWithCredential`). Bypasses
  the helper entirely, but One Tap needs the third-party cookies Safari blocks, and the redirect
  form needs a server endpoint to receive the token — a much larger change with its own iOS unknowns.
- **Accept Safari-only for installed iOS.** Rejected: the app is a mobile-first PWA for field staff
  and the home-screen icon is the primary way in.

## Decision

**Self-host Firebase's sign-in helper (Firebase's documented option 4), and switch to it only in the
environment that cannot work without it.**

- `public/__/auth/` carries a verbatim copy of the helper, plus `public/__/firebase/init.json`
  (which `handler.js` fetches from its own origin). Contents are byte-identical to upstream so
  re-syncing is a re-download with no patch to reapply.
- `resolveAuthDomain()` (in `utils/authEnvironment.js`, beside the popup decision it mirrors) returns
  our own `location.host` **only** when `isPopupSignInBlocked()` — the installed iOS/iPadOS app.
  Every other browser keeps `darbo-planavimas.firebaseapp.com` and the popup, unchanged. Every
  uncertain case (no DOM, no readable host) falls back to the hosted helper.
- The helper answers on the extensionless URLs Firebase uses, while the files carry `.html` so hosts
  send `text/html` without per-path header overrides; `_redirects` and `netlify.toml` bridge the two,
  above the SPA catch-all.
- `src/sw.js` denies `/__/*` on its navigation route, and the precache skips those paths.

## Consequences

- **The blast radius is the population that is already 100% broken.** Nobody else's sign-in path
  changes, so this cannot regress a working user, and reverting is a one-line change plus a redeploy.
- **The service worker had to be taught to stay out of the way.** Moving the helper same-origin
  brought it inside the worker's scope, where the navigation route would have served the app shell to
  Google's redirect — reproducing the very symptom being fixed, from a new cause. Both legs of the
  handshake and the `iframe` subframe load are navigations, hence the `/__/*` denylist.
- **A standing maintenance debt.** These files are a snapshot of code Firebase maintains and will not
  auto-update. Re-sync procedure and the staleness symptom:
  [`docs/runbooks/firebase-auth-helper-selfhost.md`](../runbooks/firebase-auth-helper-selfhost.md).
- **Apple and SAML sign-in are now foreclosed.** They return via HTTP POST, which needs Firebase
  Hosting to fill the `{{POST_BODY}}` template slot a static host leaves literal. `handler.js`
  already guards for the unfilled slot, so Google (which returns via GET) is unaffected — but adding
  either provider means replacing this approach.
- **Each hosting origin needs its `/__/auth/handler` URL authorized in the Google OAuth client.**
  A new domain for the app is now a two-step change, and forgetting the second step fails as
  `redirect_uri_mismatch`.
- **Verified:** vendored files byte-identical to upstream and syntactically complete; the `/__/*`
  denylist present in the compiled worker; precache down 54 → 47 entries (2597 → 1957 KiB);
  `lint` clean, `build` green, 1421 tests pass. **Not yet verified:** the end-to-end handshake on a
  real installed iOS app, which cannot be exercised until the OAuth redirect URI is registered.

## Follow-ups

- Prove the flow on the reporting manager's iPhone, then remove the now-misleading half of the
  `app/redirect-handshake-blocked` copy (it still implies signing in via Safari repairs the icon).
- Decide whether the same first-party helper should become the default for *all* origins once it has
  proven itself on iOS, which would retire the cross-origin popup dependency entirely.
