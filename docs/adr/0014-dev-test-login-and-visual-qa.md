# ADR 0014 — Dev-only test login for repeatable visual QA

**Date:** 2026-06-23
**Status:** Accepted

## Context

WORKZ authenticates **only** through a Google sign-in popup, and a first login provisions a
disabled `pending` account that an admin must approve. That is correct for production, but it has a
standing cost: an automated browser (the agent's Chrome / Preview tools) **cannot drive the Google
OAuth popup** (Google blocks automation, 2FA, "browser may not be secure"). As a result, change
after change shipped on a `lint + build` gate with the recurring note *"app not visually QA'd —
needs Google auth"* (e.g. the 2026-06-23 modal-canonicalisation entry in the decisions log). The
founder asked for a test account that can sign in, see everything, and be visually checked in a
browser each session — then be disabled when the dev phase ends — and for the practice to be written
down so every session knows how to test.

Two facts from the code shaped the design:

- **"See everything" is one field.** Whole-team visibility is decided entirely by
  `users/{uid}.role == 'admin'` in `firestore.rules` (`isAdmin()` → `canSeeWholeTeam()`); there are
  **no custom claims**. So a test admin is just a user doc with `role: 'admin'`.
- **A test-account convention already exists.** `users/{uid}.isTest` has a one-click toggle in
  User Management, and Reports + DailyStatistics **exclude** `isTest` users from payroll totals and
  leaderboards. So a test account on the **real** database does not skew any report — this was an
  intended affordance that simply lacked a usable login path.

The only missing piece was a login an agent can perform. A pure client-side mock identity is a
dead end: the Firestore rules require a real Firebase Auth token (`request.auth != null` + the user
doc must exist), so a fake user would fail every collection read with `permission-denied`.

## Decision

**Add a dev-only email/password sign-in to the Login page, and document the full QA practice.**

1. **Dev-login UI (`src/pages/Login.jsx`).** Below the Google button, a dashed "DEV testavimas"
   panel with email/password fields (pre-filled from `import.meta.env.VITE_DEV_LOGIN_*`) calls
   `signInWithEmailAndPassword`; `onAuthStateChanged` then loads the role from the seeded admin doc.
   The **entire surface** — state initialisers, handler body, and markup — is gated by
   `import.meta.env.DEV`, which Vite hard-codes to `false` in `vite build`, so Rollup
   dead-code-eliminates it from the production bundle (the same pattern as the existing "Skip
   Loading" debug button in `AuthContext`). The handler also has a runtime `if (!import.meta.env.DEV)
   return;` so its dynamic `firebase/auth` import is tree-shaken from prod.

2. **The test identity** is a real Firebase Auth user whose Firestore doc is `role: 'admin'`,
   `isTest: true`, parked `isDisabled: true` at rest. `isTest` keeps it out of reports; `admin`
   gives full visibility through the existing rules unchanged.

3. **Credentials** live in `.env.local` (gitignored via `*.local`), never committed — a committed
   `.env.local.example` documents the variables. The **public** repo never carries the secret.

4. **The practice is written down:** `docs/runbooks/visual-qa-test-account.md` (one-time setup,
   per-session loop, security model, teardown), a pointer in `CLAUDE.md`, and a line in `AGENTS.md`,
   so every session knows how to bring up an authenticated browser.

**No `firestore.rules` change.** Admin already sees everything; `isTest` is already honoured.

## Alternatives considered

- **Dedicated Google account + persisted browser session (zero code).** Real token, no code, but
  the agent cannot re-authenticate after the ~4-day / Google-token expiry, and a fresh
  Preview/Chrome context often starts with no persisted storage — fragile for *recurring*,
  hands-off QA, which is the whole point.
- **Firebase Auth + Firestore emulator with seed data.** The most isolated option (no prod risk,
  fully scriptable), but the heaviest to build and maintain, and its **synthetic** data would not
  reflect the real production state the founder needs to eyeball; FCM/functions only partially
  work. Overkill given the `isTest` convention already makes a real-DB test account report-safe.
- **Client-side mock user (no real token).** Rejected outright — the rules reject it, so every read
  fails `permission-denied`. Useless for visual QA.

## Consequences

- An agent can sign in as admin in a real browser **every session**, popup-free, closing the
  "not visually QA'd" gap that has trailed nearly every UI ship.
- The production project gains an **enabled Email/Password provider** and a **standing admin
  credential** — a real expansion of the auth surface. It is contained by: the login UI existing
  **only** in dev builds; the credential living **only** in gitignored `.env.local`; and the
  account being kept **disabled at rest** (a disabled Firebase Auth user cannot mint a token), so a
  leaked password on the public repo is inert. The "disable when done" the founder asked for is
  therefore also the security control.
- QA runs against **real production data** (dev points at `darbo-planavimas` by default). The
  `isTest` flag keeps it out of reports, but writes still touch live data — the runbook mandates
  read-only-first checks, acting only as the test user, and never mutating other users' records.
- Setup is **founder-run**: enabling the provider has no API/MCP path, and creating an auth user /
  seeding an admin doc are prod-config changes agents do not perform autonomously (`CLAUDE.md`).

## Follow-ups

- **(Optional)** If hands-off QA is wanted without ever enabling a prod credential, revisit the
  emulator route as a separate, isolated harness.
- **(End of dev phase)** Execute the teardown in the runbook — disable/delete the auth user, delete
  its doc, disable the Email/Password provider, clear `.env.local`, and optionally delete the
  (already-inert) dev-login block.
