#!/usr/bin/env node
/**
 * SessionStart hook — give every git worktree the gitignored .env.local from the main checkout.
 *
 * `.env.local` matches `*.local` in .gitignore, so `git worktree add` never carries it into a
 * fresh worktree: the dev-only test-login credentials (the "DEV testavimas" panel used for visual
 * QA — see docs/runbooks/visual-qa-test-account.md) silently go missing, which is why so much work
 * shipped "not visually QA'd". This copies the file from the main worktree into the current one
 * when it is absent.
 *
 * Safe by construction:
 *   - No-op when the worktree already has its own .env.local (never overwrites).
 *   - No-op when this IS the main checkout (source === destination).
 *   - No-op when the main checkout has no .env.local (nothing to copy).
 *   - Any failure is swallowed — a convenience step must never block a session from starting.
 *
 * Committed (tracked) on purpose: only tracked files propagate to a new worktree, so this is the
 * one place the auto-copy logic can live and still reach every future worktree. It contains no
 * secrets — only the copy mechanism. The secret values stay solely in the gitignored .env.local.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

try {
  const cwd = process.cwd();
  const dest = path.join(cwd, '.env.local');
  if (fs.existsSync(dest)) process.exit(0); // worktree already has it — never overwrite

  // The shared git dir (…/<main>/.git) is common to every linked worktree; its parent directory
  // is the main worktree root — the one place the gitignored .env.local actually lives. Resolving
  // against cwd handles both the absolute path a linked worktree reports and the bare ".git" the
  // main checkout reports.
  const commonDirRaw = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
  const mainRoot = path.dirname(path.resolve(cwd, commonDirRaw));
  if (path.resolve(mainRoot) === path.resolve(cwd)) process.exit(0); // we ARE the main checkout

  const src = path.join(mainRoot, '.env.local');
  if (!fs.existsSync(src)) process.exit(0); // main checkout has nothing to share

  fs.copyFileSync(src, dest);
  console.log(`[sync-env-local] copied .env.local from main checkout (${mainRoot}) into this worktree`);
} catch (err) {
  // A convenience step must never break session start — log and move on.
  console.error(`[sync-env-local] skipped: ${err && err.message ? err.message : err}`);
}
process.exit(0);
