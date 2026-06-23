# Runbook — Visual QA via the dev-only test account

> **What this solves.** WORKZ signs in **only** through a Google popup, and a first login
> lands in a disabled `pending` state needing admin approval. An automated browser cannot
> drive the Google OAuth popup, so for months every UI change shipped on a `lint + build`
> gate marked *"not visually QA'd — needs Google auth"*. This runbook gives every session a
> **popup-free, admin-level login** so changes can be opened and checked in a real browser,
> plus the procedure to **disable it** when the dev phase ends.
>
> Decision record: [ADR 0014](../adr/0014-dev-test-login-and-visual-qa.md).

---

## The model in one paragraph

"See everything" is decided **entirely** by one Firestore field: `users/{uid}.role == 'admin'`
(no custom claims). So the test user is just a user doc with `role: 'admin'`. The product already
has an `isTest` flag with a one-click toggle in User Management, and **Reports + Statistics exclude
`isTest` users** — so a test account on the real database never skews payroll or leaderboards. The
only missing piece was a login path an agent can drive: a **dev-only email/password panel** on the
Login page, gated by `import.meta.env.DEV` (so it is dead-code-eliminated from production builds).

**Security on a PUBLIC repo:** the standing credential is made safe by keeping the account
**disabled at rest** (a disabled Firebase Auth user cannot obtain a token at all). Enable it only
during an active QA session; park it disabled otherwise. Credentials live in `.env.local`
(gitignored) — never committed.

---

## One-time setup (founder — Firebase Console)

These three steps touch the production project (`darbo-planavimas`) and are **human-run** (the
provider toggle has no API/MCP path; creating the auth user and seeding an admin doc are
prod-config changes — per `CLAUDE.md` agents don't do these autonomously).

1. **Enable the Email/Password provider.**
   Firebase Console → **Authentication → Sign-in method → Email/Password → Enable** (leave
   "Email link / passwordless" off). Project: `darbo-planavimas`.

2. **Create the test auth user.**
   Authentication → **Users → Add user**. Use a clearly-test address, e.g.
   `qa-bot@workz.test` (a real mailbox is not required — there is no email verification step),
   and a strong password. Copy the generated **UID**.

3. **Seed its Firestore profile as an enabled admin test user.** Two ways:

   - **Fast path (Firebase MCP, an agent can run it):** with the UID from step 2,
     write `users/{uid}`:
     ```
     mcp__firebase__firestore_update_document
       path: users/<uid>
       data: {
         email: "qa-bot@workz.test",
         displayName: "QA Bot",
         role: "admin",
         isTest: true,
         isDisabled: true,        // parked OFF until a session needs it
         status: "active",
         createdAt: "<ISO date>"
       }
     ```
     (Confirm the MCP is pointed at `darbo-planavimas` first via
     `mcp__firebase__firebase_get_project`.)

   - **No-tooling path (app UI):** run the app, dev-login once (step below) — the app creates a
     `pending`/disabled doc and signs out. Then log in as a real admin (Google) → **Vartotojai**
     → find the test user → set **role = Administratorius**, click the flask **"Žymėti bandomu"**
     (`isTest`), and leave it **blocked** until you need it.

4. **Put the credentials in `.env.local`** (in the repo root; gitignored):
   ```
   cp .env.local.example .env.local
   # then fill in:
   VITE_DEV_LOGIN_EMAIL=qa-bot@workz.test
   VITE_DEV_LOGIN_PASSWORD=<the password from step 2>
   ```
   Worktrees do **not** inherit `.env.local` (it is gitignored, so it is not checked out into a
   new worktree). For a QA session inside a worktree, copy it in:
   `cp <main-checkout>/.env.local .env.local`.

---

## Per-session QA loop (every agent / developer)

1. **Unblock the test account for this session** (it is parked disabled at rest):
   - App UI: log in as a real admin → **Vartotojai** → unblock the QA user; **or**
   - Firebase MCP: `auth_update_user { uid: <uid>, disabled: false }` (find the uid via
     `auth_get_users { emails: ["qa-bot@workz.test"] }`). Also set the Firestore
     `isDisabled: false` if you blocked it there.

2. **Start the app:** `npm run dev` (the dev server binds the network host, so a phone on the
   same LAN can hit it too).

3. **Open it in a browser** — Chrome MCP (`mcp__Claude_in_Chrome__*`) or the Preview tools
   (`mcp__Claude_Preview__*`), or just point your own browser at the dev URL.

4. **Sign in via the DEV panel.** Below the Google button there is a dashed **"DEV testavimas"**
   box, pre-filled from `.env.local`. Click **"Prisijungti (DEV)"** — no popup. You are now an
   admin and see every tab (team tasks, live sessions, reports, user management, calendar).

5. **Verify the change.** Check the actual behaviour on a **~360 px** viewport first (workers are
   on phones) and on desktop. Use the **DESIGN_SYSTEM §11** checklist for any UI change.

6. **Re-park the account when done** (see teardown — at minimum, re-disable it).

### Driving it headless via Claude Preview (agent QA — verified 2026-06-23)

The Preview tools (`mcp__Claude_Preview__*`) can run the dev server and inspect the page without a
human at the browser. The exact path that works here (the naive one does not — read the gotchas):

1. **Start the server:** `preview_start({ name: "workz-dev" })`. The repo ships
   [`.claude/launch.json`](../../.claude/launch.json) (`npm run dev`, port 5173) so this works out
   of the box. If port 5173 is held by a stray `node.exe`, free it first
   (`Stop-Process -Id <pid> -Force`) — Preview will not attach to a non-Preview server.
2. **Kill the dev service worker BEFORE looking.** `vite-plugin-pwa` registers a dev SW that
   serves a stale/blank shell, so the first paint is empty and the page sticks at a *"Atnaujinta
   versija"* prompt. Clear it once with `preview_eval`:
   ```js
   (async () => { for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
     if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
     location.reload(); })()
   ```
   After the reload the app boots clean to `/login`.
3. **Verify with `preview_eval` / `preview_snapshot`, NOT `preview_screenshot`.** Screenshots
   time out in this environment (30 s, every time); the a11y snapshot and reading
   `document.body.innerText` are reliable and are the documented-preferred check anyway.
4. **Log in:** the `#dev-email` / `#dev-password` inputs are pre-filled from `.env.local` (Vite
   reads it from the checkout root), so just `preview_click({ selector: 'button[type="submit"]' })`.
   A successful login leaves `/login` for `?tab=...` and the nav shows **"Administratorius"** with
   the MANO / KOMANDA / ADMINISTRAVIMAS groups; opening **Vartotojai** loads the whole roster
   (proof that team-wide Firestore reads work). A `[role="alert"]` in the panel means sign-in
   failed — read its text (e.g. `auth/operation-not-allowed` = provider disabled).

### Stay safe on real production data
- The account is `isTest`, so Reports/Statistics already drop it — **but the data is real prod
  data**, not an emulator. Prefer read-only visual checks.
- If a test requires writing (starting/stopping a timer, creating a task), do it **as the QA test
  user** (its rows are `isTest`-owned and excluded), and **clean up** afterwards.
- **Never** edit, delete, or re-point another user's sessions/hours/tasks while testing.

---

## Teardown — disabling the account

### Between sessions (default resting state)
Keep the account **disabled** so the credential is inert even though the repo is public and the
provider is enabled:
- **Hard control (recommended):** disable the **Firebase Auth** user — sign-in becomes impossible
  (no token at all). App UI block, or `auth_update_user { uid, disabled: true }`.
- App-level only (`users/{uid}.isDisabled = true`) also works (the app signs the user out and the
  rules deny `isUserActive()`), but a token already minted stays valid ~1 h — weaker than the
  Auth-level disable.

### End of the development phase ("atjungti kai baigsim")
When visual QA is no longer needed, remove the surface entirely:
1. **Disable / delete** the test Auth user (Console → Authentication → Users).
2. **Delete** its `users/{uid}` doc (or leave it `isDisabled: true`).
3. **Disable the Email/Password provider** (Console → Authentication → Sign-in method) so no
   email/password sign-in exists on the project at all.
4. **Remove the credentials** from every `.env.local`.
5. *(Optional, for a fully clean tree)* delete the dev-login block from
   [`src/pages/Login.jsx`](../../src/pages/Login.jsx) (the `import.meta.env.DEV` `<form>` + the
   `handleDevLogin` handler + the `devEmail`/`devPassword` state) and the two `VITE_DEV_LOGIN_*`
   lines in `.env.local.example`. It is already inert in production builds, so this is cosmetic.

---

## Invariants (do not break)
- The dev-login UI and handler stay behind `import.meta.env.DEV`. Never make it reachable in a
  production build. (Verify after a build: `dist/` must contain neither `DEV testavimas` nor
  `Prisijungti (DEV)`.)
- No real credentials in git. `.env.local` only; the repo is public.
- The test account is `role: 'admin'` **and** `isTest: true`. The `isTest` flag is what keeps it
  out of reports — do not drop it.
- Park the account **disabled** when not actively testing.
