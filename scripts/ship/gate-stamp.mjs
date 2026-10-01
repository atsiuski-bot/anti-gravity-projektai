#!/usr/bin/env node
// Gate stamp — lets /ship reuse a /debug L6 gate PASS on byte-identical content.
//
//   node scripts/ship/gate-stamp.mjs record <gate> [<gate> ...]   (after a full PASS)
//   node scripts/ship/gate-stamp.mjs check                         (MATCH → exit 0, else exit 1)
//   node scripts/ship/gate-stamp.mjs fingerprint                   (print the tree hash)
//
// The fingerprint is the git tree hash of the WORKING TREE (tracked + untracked, minus
// .gitignore'd files), built in a throwaway index seeded from the real one, so the real
// index is never touched. Same hash ⇒ same files ⇒ the recorded gates already passed on
// exactly this content. The stamp lives at `git rev-parse --git-path workz-gate-stamp.json`,
// which is per-worktree and never committed.
// Ported from the viduramziai.lt repo's scripts/ship/gate-stamp.mjs; WORKZ adds the gate list,
// because /debug L6 covers only lint+test+build, not the functions/emulator suites.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const STAMP_NAME = 'workz-gate-stamp.json';

const git = (args, env) =>
  execFileSync('git', args, { encoding: 'utf8', env: env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

process.chdir(git(['rev-parse', '--show-toplevel']));

const gitPath = (name) => resolve(git(['rev-parse', '--git-path', name]));

export function fingerprint() {
  const dir = mkdtempSync(join(tmpdir(), 'workz-gate-stamp-'));
  const tmpIndex = join(dir, 'index');
  try {
    const realIndex = gitPath('index');
    // Seeding from the real index keeps the stat cache, so `add -A` only re-hashes changed files.
    if (existsSync(realIndex)) copyFileSync(realIndex, tmpIndex);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    git(['-c', 'core.safecrlf=false', 'add', '-A'], env);
    return git(['write-tree'], env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function record(gates) {
  if (gates.length === 0) throw new Error('record needs at least one gate name, e.g. lint test build');
  const stamp = { tree: fingerprint(), gates, head: git(['rev-parse', 'HEAD']), recordedAt: new Date().toISOString() };
  writeFileSync(gitPath(STAMP_NAME), JSON.stringify(stamp, null, 2) + '\n');
  console.log(`STAMP RECORDED tree=${stamp.tree} gates=${gates.join(',')}`);
}

function check() {
  const file = gitPath(STAMP_NAME);
  if (!existsSync(file)) {
    console.log('STAMP NONE — no recorded gate pass in this worktree; run all gates');
    return 1;
  }
  let stamp;
  try {
    stamp = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    console.log('STAMP UNREADABLE — run all gates');
    return 1;
  }
  const tree = fingerprint();
  if (stamp.tree !== tree) {
    console.log(`STAMP MISMATCH stamped=${stamp.tree} now=${tree} — content changed since the pass; run all gates`);
    return 1;
  }
  console.log(`STAMP MATCH tree=${tree} gates=${stamp.gates.join(',')} recordedAt=${stamp.recordedAt}`);
  return 0;
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === 'record') record(rest);
  else if (cmd === 'check') process.exitCode = check();
  else if (cmd === 'fingerprint') console.log(fingerprint());
  else {
    console.error('usage: gate-stamp.mjs record <gate>... | check | fingerprint');
    process.exitCode = 2;
  }
} catch (err) {
  // Any failure (e.g. a conflicted index makes write-tree fail) means "no reuse" — never a false MATCH.
  console.log(`STAMP ERROR — ${err.message.split('\n')[0]}; run all gates`);
  process.exitCode = cmd === 'check' ? 1 : 2;
}
