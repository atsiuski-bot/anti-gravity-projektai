# 06 — Firebase deterministic diff (rules · indexes · functions) — ✅ IN SYNC

**Method:** the Firebase MCP never connected this session (`CONNECT_TIMEOUT`), and the CLI's
`audrius@medievalclub.org` token had expired. After the founder re-authenticated
(`firebase logout <email>` + `firebase login:add <email>`, 2026-09-06 ~01:20 +03:00), the live side
was read with **read-only CLI calls plus one script that reuses the CLI's own auth layer** to fetch
the live ruleset bodies (`06-fetch-live-rules.cjs` — `firebase-tools/lib/gcp/rules`
`listAllReleases` + `getRulesetContent`; it writes nothing to Firebase). Raw evidence:
`06-firebase-live-functions-raw.txt`, `06-firebase-live-functions.json`,
`06-firebase-live-indexes-raw.json`, `06-firebase-live-cloud.firestore.rules`,
`06-firebase-live-firebase.storage__darbo-planavimas.firebasestorage.app.rules`.
**Findings:** 🔴 0 · 🟠 0 · 🟡 0 · ℹ️ 3

## Security rules — IDENTICAL

| Service | Live release | Released (UTC) | Live vs repo (CRLF-normalised `diff`) |
|---|---|---|---|
| `cloud.firestore` | ruleset `7ae47efe-…56d3` | 2026-07-31 12:33:58 | **IDENTICAL** to `firestore.rules` (1150 lines, sha256 `79c12cae…`) |
| `firebase.storage` (`darbo-planavimas.firebasestorage.app`) | ruleset `7f93ccfe-…06c1` | 2026-06-22 09:08:00 | **IDENTICAL** to `storage.rules` (39 lines) |

The Firestore release time matches the last repo change to the rules (`69e4c81`, 2026-07-31):
what is live is exactly HEAD's ruleset. This closes the "live ruleset body not retrievable"
gap that the 2026-07-27 sweep also carried.

## Composite indexes — 14 local = 14 live

Normalised on `collectionGroup | queryScope | fields` (the API appends an implicit `__name__`
field to every live index; stripped before comparing): **missing live: none · unexpected live:
none · field overrides: 0 = 0.** All 14 are `ACTIVE` (no `CREATING`/`NEEDS_REPAIR` states).

## Cloud Functions — 24 repo exports = 24 live, one deploy after the last change

| Check | Result |
|---|---|
| Name parity (`exports.*` in `functions/index.js` vs `functions:list`) | 24 = 24 · missing none · orphan none |
| Runtime / region | all `nodejs22` · `europe-west1` · gcfv2 · 256 MB · `ACTIVE` |
| Source upload window (GCS `generation` of every `function-source.zip`) | **2026-08-25 18:53:37 → 18:54:26 UTC** (21:53 Vilnius) |
| Last repo commits touching `functions/` | `a7c9c06` SDK bump 16:59 UTC · `e46aa8b` tests 18:14 UTC · `a0a0c32` merge to main 18:41 UTC — **all before the upload** |
| Bundle hash label (`firebase-functions-hash`) | `f32f542590…` on 23 functions; `a63fd04a2b…` on `parseTaskDraft` (the one function bound to a secret, so its config hash differs — same upload window) |

So the live bundle post-dates both changes this sweep worried about (the 2026-08-15 recognition
reframe `bdb0c94` and the 2026-08-25 SDK bump) and was uploaded twelve minutes after those
commits merged to `main`. The "functions may be stale in prod" concern in the synthesis is
**withdrawn**. (The one residual unknown any timestamp check leaves: a deploy from a checkout that
was itself missing a commit. The upload being minutes after the merge, from the session that made
the merge, makes that implausible; the next `/firebase-status` after any future functions deploy
should keep recording the hash.)

## ℹ️ Notes

- ℹ️ **The MCP outage was not the token.** Re-auth fixed the CLI, but the `firebase` MCP server still
  reports `CONNECT_TIMEOUT`. It should be investigated separately (server startup, not credentials);
  until then `/firebase-status` cannot run as written, and the CLI + `06-fetch-live-rules.cjs`
  path is the working fallback for every read it needs (config, rules, indexes, functions).
- ℹ️ `firebase login:add <email>` refuses when the account is already stored; an expired stored
  account must be `firebase logout <email>` first, then re-added. `firebase login --reauth` only
  refreshes the *default* account (karolis.j), not the WORKZ one.
- ℹ️ Storage rules last released 2026-06-22 — unchanged since; nothing pending.
