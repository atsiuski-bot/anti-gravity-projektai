# WORKZ whole-app audit — 2026-07-27

This directory records a read-only audit of the latest fetched GitHub `origin/main`.

## Audited source

- Repository: WORKZ
- Ref: `origin/main`
- Commit: `57a9324bbff91f7a7cc3347d488a00390d35b74f`
- Commit subject: `feat(timer): alert workers offline when a running task blows its plan`
- Commit time: 2026-07-27 15:47:00 +03:00
- Ahead/behind against local `main`: `0 / 0`
- Audit copy: a separate clean clone under `C:\tmp`; the application source was not edited

The primary review question was whether employee-side time capture remains correct through
offline operation, reload, suspend, replay, correction, recovery, role changes, and partial
backend failure.

## Result

**NEEDS WORK.** The deterministic checks are green, but ten confirmed P1 issues can cause
employee time to be misrepresented, make a failure hard to recover, or weaken the controls
that are meant to detect ledger corruption.

Start with [00-SYNTHESIS.md](./00-SYNTHESIS.md).

## Evidence files

- `00-SYNTHESIS.md` — prioritized findings, score, and next actions
- `00-reasoning-confirmed.md` — detailed causal chains and rejected false positives
- `02-lint.md` — lint evidence
- `04-tests.md` — unit, Functions, and Firestore emulator evidence
- `05-build.md` — production build and bundle evidence
- `06-firebase.md` — local/live index and function inventory comparison
- `19-deps.md` — lockfile install and dependency-risk evidence

## Scope limitations

- Authenticated visual QA was not completed: the isolated clean copy had no local test-account
  configuration and the in-app browser webview did not attach. The unverified 360 px nested
  timer-header geometry concern is therefore not counted as a confirmed finding.
- Live Firestore ruleset content was not retrievable with the available read-only tools.
- A detailed package advisory report was blocked by the environment's metadata-egress policy;
  only the install-time vulnerability counts are recorded.
- The repository does not contain proof that the historical `workerId` to `userId` session
  migration was run in production. This is recorded as a live verification gap, not as a
  confirmed defect in the current snapshot.
