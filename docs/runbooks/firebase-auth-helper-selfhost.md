# Runbook — the self-hosted Firebase Auth sign-in helper

> Why `public/__/auth/` contains vendored Firebase files, what they are for, and how to
> re-sync them. Read this before touching anything under `public/__/auth/` or
> `public/__/firebase/`.

## The problem this solves

Signing in needs a Google handshake, and the installed iOS app had **no working route left**:

- **Popup is impossible there.** WebKit gives a home-screen web app's popup a null
  `window.opener` (iOS 17.5+), so the credential has nowhere to be posted back to.
- **Redirect was impossible too.** Firebase serves its sign-in helper from
  `darbo-planavimas.firebaseapp.com`, a *different origin* than the app
  (`anti-gravity-projektai.pages.dev`). The return leg reads the credential back through a
  cross-origin iframe, and Safari partitions that iframe's storage — so the redirect came home
  empty and surfaced as `app/redirect-handshake-blocked`.

Signing out of the installed app was therefore a one-way door, and "open it in the browser" was
never a real repair: an iOS home-screen web app has its **own storage jar**, separate from
Safari, so signing in there does not sign in the icon.

The fix removes the third party rather than negotiating with it: serve the helper from **our own
origin**, so the handshake is first-party and there is no partitioned storage to lose.

## What is vendored, and from where

Downloaded 2026-08-19 from `https://darbo-planavimas.firebaseapp.com/__/auth/` (and
`/__/firebase/` for `init.json`):

Every file keeps Firebase's own name and path, so each request is an **exact static-asset match**
and nothing has to rewrite anything:

| Local path | Upstream path | Note |
| --- | --- | --- |
| `public/__/auth/handler` | `/__/auth/handler` | extensionless — needs `_headers` `Content-Type` |
| `public/__/auth/handler.js` | `/__/auth/handler.js` | |
| `public/__/auth/experiments.js` | `/__/auth/experiments.js` | |
| `public/__/auth/iframe` | `/__/auth/iframe` | extensionless |
| `public/__/auth/iframe.js` | `/__/auth/iframe.js` | |
| `public/__/auth/links` | `/__/auth/links` | extensionless |
| `public/__/auth/links.js` | `/__/auth/links.js` | |
| `public/__/firebase/init.json` | `/__/firebase/init.json` | `handler.js` fetches this from its **own** origin |

`init.json` holds only public client config (apiKey, appId, projectId — the values that already
ship in the browser bundle). It is **not** a secret. Note its real path is `/__/firebase/`, not
`/__/auth/`: requesting `/__/auth/init.json` silently returns the SPA's `index.html` instead.

### Nothing is edited, and nothing is renamed

Contents and names are byte-identical to upstream on purpose, so re-syncing is a plain
re-download with no patch to reapply. `init.json` keeps its upstream `authDomain` value for the
same reason — do not "fix" it to our host.

The only host-side wiring is **`Content-Type` in `public/_headers`** (mirrored in `netlify.toml`)
for the three extensionless files: with no extension there is nothing to infer a type from, and a
browser will not execute an HTML document sent as `application/octet-stream`.

### ⚠️ Do NOT add a `_redirects` rewrite for these paths

The obvious-looking alternative — name them `handler.html` and rewrite `/__/auth/handler` onto it
with status 200 — **was shipped once (42b203f) and broke sign-in worse than before.** Cloudflare
Pages already redirects `*.html` to its extension-less counterpart, so the rewrite and that
canonicalization point straight at each other:

```
/__/auth/handler → (our rule) → /__/auth/handler.html → (Pages) → /__/auth/handler → …
```

The live result was `308 Permanent Redirect` with `Location: /__/auth/handler` — an infinite loop,
and an installed iOS app that hung instead of merely failing. Reverted in the follow-up commit.

The extensionless naming avoids the whole class: an exact asset match needs no rule, and existing
assets already win over the SPA catch-all — which `/__/auth/handler.js` and
`/__/firebase/init.json` demonstrate on the live site.

## Re-sync (the standing maintenance debt)

These files are a snapshot of code Firebase maintains. They do not auto-update, and a stale
snapshot can break sign-in if Firebase changes the handshake. Re-check on any Firebase Auth
major upgrade, and if sign-in on the installed iOS app starts failing.

```bash
cd public/__/auth && for f in handler experiments.js handler.js iframe iframe.js links links.js; do curl -sf "https://darbo-planavimas.firebaseapp.com/__/auth/$f" -o "$f"; done
```

```bash
curl -sf "https://darbo-planavimas.firebaseapp.com/__/firebase/init.json" -o public/__/firebase/init.json
```

After re-syncing, confirm nothing came back as our own SPA shell (a wrong upstream path fails
this way silently, returning `index.html` with a 200):

```bash
grep -l 'Theme boot' public/__/auth/* public/__/firebase/* || echo "clean — no SPA shell captured"
```

**Known non-issue:** `handler` contains the literal `var POST_BODY = '{{POST_BODY}}';`.
That is a Firebase Hosting template slot which a static host cannot fill, and `handler.js`
already guards for it (`POST_BODY != "{{POST_BODY}}" ? … : null`). It only matters for providers
that return via HTTP POST (`form_post`) — Apple and SAML. WORKZ uses Google only, which returns
via GET, so the unfilled slot is correct and harmless. **Do not add Apple or SAML sign-in
without replacing this approach.**

## The one human step — required once per origin

> **Status 2026-08-19: PENDING for production.** The code shipped first because it is inert
> without this step; until it is done, the installed iOS app stays broken exactly as before
> (it cannot regress — it already had no working route). Nothing else waits on it.

The helper builds its OAuth `redirect_uri` from the origin serving it, so Google must be told to
trust that URL. In **Google Cloud Console → APIs & Services → Credentials → the Firebase OAuth
2.0 Client ID → Authorized redirect URIs**, this must be present:

```
https://anti-gravity-projektai.pages.dev/__/auth/handler
```

Without it Google refuses the handshake with `redirect_uri_mismatch`. Adding a new hosting
domain for the app means adding its `/__/auth/handler` URL here too. The app's domain itself is
already in Firebase's *Authorized domains* list (today's popup sign-in depends on that), so
nothing is needed there.

## Blast radius, deliberately narrow

`src/firebase.js` points `authDomain` at our own origin **only when the popup is impossible** —
the installed iOS/iPadOS app. Every other browser keeps
`darbo-planavimas.firebaseapp.com` and the popup, byte-for-byte as before. The population that
can regress is the one that is already 100% broken, and reverting is a one-line change plus a
redeploy.
