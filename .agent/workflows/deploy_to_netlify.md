---
description: How to build and deploy WORKZ to Netlify (the production host)
---

WORKZ is hosted on **Netlify**. Firebase remains the backend (Auth, Firestore, Storage);
only the static app is served by Netlify. The older `deploy_to_firebase.md` runbook describes
Firebase *Hosting* and is **superseded** — WORKZ no longer deploys hosting to Firebase.

### Where it lives

- **Site:** `workz-darbo-laikas` → https://workz-darbo-laikas.netlify.app
- **Netlify team:** "Darbo planavimo serveris" (account **atsiuski@gmail.com**)
- **Repo:** `atsiuski-bot/anti-gravity-projektai`, production branch **`main`**
- **Build settings** come from [`netlify.toml`](../../netlify.toml): build `npm run build`,
  publish `dist`, SPA redirect `/* → /index.html`.

### Prerequisites

- The Netlify CLI: `npm install -g netlify-cli`.
- Log in as the **correct** account (the CLI may default to a different one):
  ```bash
  netlify login          # complete the browser flow as atsiuski@gmail.com
  netlify status         # must show: atsiuski@gmail.com / Darbo planavimo serveris
  ```

### Path A — Manual deploy (always works, bypasses the contributor gate)

Use this for an immediate, reliable deploy from your machine.

```bash
npm run build
netlify deploy --prod --dir=dist
```

The production URL is printed at the end. Manual deploys are **not** subject to the
contributor gate described below.

### Path B — Continuous deployment (GitHub → Netlify)

`main` is connected to Netlify, so a build triggers on push. **But** the repo is private on a
Netlify **Free** plan, which only builds commits whose Git author is a *verified* team member.
A commit pushed from the CLI by a local identity is rejected with:

> Build blocked: Unrecognized Git contributor.

A **GitHub pull-request merge by `atsiuski-bot`** is recognized and builds. So, to ship via CD:

1. Push your branch and open a PR into `main`.
2. **Merge the PR while signed in to GitHub as `atsiuski-bot`**, using **"Create a merge
   commit"** (not squash/rebase) so the merge commit's author is `atsiuski-bot`.
3. Netlify auto-builds `main` and publishes.

> `gh` on the build machine is often signed in to the wrong account (`Kazkasbelekas`). A PR
> merged by that account hits the same contributor gate. Sign `gh`/GitHub in as atsiuski-bot
> in your own terminal for WORKZ.

To remove the gate entirely (so a plain `git push` to `main` deploys): make the repo public,
upgrade the Netlify plan, or verify the contributor in Netlify team settings.

### Build note (do not re-introduce)

`@vitejs/plugin-basic-ssl` peer-requires vite 6/7; this project is pinned to **vite 5**. The
plugin was unused (imported nowhere) and broke Netlify's fresh `npm install` with an ERESOLVE
conflict, so it was removed. A local `npm run build` can hide this because it reuses an
existing `node_modules`; always test a clean `npm install` before relying on CD.
