# Runbook — Activate FCM push + notification infrastructure

> The code for FCM background push, the Cloud Functions sender, Storage-orphan cleanup, the
> in-app toast, and the unread badge is **already merged**. This runbook is the **human-run
> activation** — steps an AI agent cannot perform (billing, a console-generated key, and prod
> deploys the permission classifier blocks). See [ADR 0004](../adr/0004-notification-infrastructure.md).

**Account/project:** Firestore/Storage/Functions live in Firebase project `darbo-planavimas`.
Use the owner account (`audrius@medievalclub.org`). Hosting is Netlify (`workztest1`); the
client reads `VITE_FIREBASE_VAPID_KEY` from the Netlify build env.

Until steps 2–4 are done, the app runs normally: the **toast + unread badge work today** (they
ride the live Firestore listeners), token registration simply no-ops without a VAPID key, and
push/cleanup stay dormant. Nothing is broken by deploying the client without the backend.

---

## 1. Enable Blaze billing (required for Cloud Functions)

2nd-gen Cloud Functions run on Cloud Run and need the **Blaze (pay-as-you-go)** plan.
Firebase console → ⚙ → Usage and billing → **Modify plan → Blaze**. (Free tier covers a tiny
app like this; set a budget alert if you want a safety cap.)

## 2. Generate the Web Push (VAPID) key and set it in Netlify

1. Firebase console → Project settings → **Cloud Messaging** → *Web configuration* →
   **Web Push certificates** → Generate key pair. Copy the public key.
2. Netlify → site `workztest1` → Site configuration → Environment variables → add
   **`VITE_FIREBASE_VAPID_KEY`** = `<the public key>`.
3. Redeploy the site (push to `main`, or Netlify → Deploys → Trigger deploy) so the env var is
   baked into the build. Without this var the client logs `VITE_FIREBASE_VAPID_KEY not set` and
   skips token registration.

## 3. Deploy the Cloud Functions

> **Node 20 → 22 migration — hard deadline 2026-10-30.** The deployed functions currently run on
> **Node 20**, which Google decommissions for Cloud Functions after **2026-10-30**. Before then,
> set `engines.node` to `"22"` in `functions/package.json`, bump `firebase-functions` (currently
> `^6.1.0`) and `firebase-admin` to the current release (deploy-coupled — both ride one re-deploy),
> and re-run the deploy below. See the decisions-log entry dated 2026-06-22.

```bash
cd functions
npm install
cd ..
firebase deploy --only functions --project darbo-planavimas
```

This deploys five triggers (region `europe-west1`):
`notifyOnRequestNotification`, `notifyOnCalendarRequest`,
`cleanupAttachmentsOnTaskUpdate`, `cleanupAttachmentsOnTaskDelete`,
`cleanupAttachmentsOnArchivedDelete`.

> The Claude Code permission classifier blocks this as a high-stakes prod deploy — run it
> yourself in a terminal.

## 4. Deploy the Firestore + Storage rules

```bash
firebase deploy --only firestore:rules,storage:rules --project darbo-planavimas
```

Adds the `fcm_tokens/{uid}` owner-only rule and the Storage image/size constraint
(`image/*`, < 20 MB).

---

## 5. Verify

1. Open the app on a phone (PWA installed), grant the notification prompt (it now appears on
   first interaction). Confirm a doc was created at `fcm_tokens/{your-uid}` with a `tokens`
   array.
2. As another user, trigger a manager alert (e.g. submit a task for approval, or a calendar
   change request). With the manager's app **closed**, a system notification should appear.
   With it **open**, an in-app toast appears instead and the app-icon badge increments.
3. Remove an attachment from a task and save → the underlying Storage object should disappear
   (check Storage console). Delete a task → its attachments should be gone; **archive** a task
   → its attachments should remain.
4. Functions logs: `firebase functions:log --project darbo-planavimas`.

## Rollback

- Push dormant again: clear `VITE_FIREBASE_VAPID_KEY` in Netlify + redeploy (client stops
  registering tokens; existing tokens go stale and are pruned on the next failed send).
- Remove senders/cleanup: `firebase functions:delete <name> --project darbo-planavimas` per
  function, or redeploy after removing them from `functions/index.js`.
- The rules changes are additive/backward-safe; revert by re-deploying the previous rules files.
