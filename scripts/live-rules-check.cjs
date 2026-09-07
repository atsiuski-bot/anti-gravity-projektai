#!/usr/bin/env node
/**
 * live-rules-check — prove what security rules are ACTUALLY live, byte for byte, against the repo.
 *
 * Read-only. Fetches the released Firestore + Storage rulesets from the Firebase Rules REST API
 * and diffs them against `firestore.rules` / `storage.rules` in this repo. Exit code 0 = both
 * in sync, 1 = drift (or a surface that could not be read), 2 = could not authenticate.
 *
 * WHY THIS EXISTS (2026-09-07). `/firebase-status` used to rely on the Firebase MCP's
 * `firebase_get_security_rules`. On the day the audit-remediation rules shipped, the MCP process
 * held a DIFFERENT credential than the CLI (it 403'd with a foreign quota project even after
 * `firebase_update_environment`), so the one tool meant to answer "is what's live the same as the
 * repo?" could not answer it. A deploy log is not that answer either — "Deploy complete" from a stale
 * checkout has regressed prod before (memory: main-checkout-branch-drift). This script reads the
 * live release through the SAME stored credential the CLI deploys with (`firebase login` in this
 * directory), so it works exactly when the deploy works, and needs no console paste.
 *
 * The access token is obtained in-process from firebase-tools' own auth module and is never
 * printed. Requires a global firebase-tools install (the CLI the repo already deploys with).
 *
 * Run from anywhere:  node scripts/live-rules-check.cjs [--project darbo-planavimas]
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PROJECT = (() => {
    const i = process.argv.indexOf('--project');
    if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
    try {
        const rc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, '.firebaserc'), 'utf8'));
        return rc.projects && rc.projects.default;
    } catch {
        return 'darbo-planavimas';
    }
})();

// Resolve the globally installed firebase-tools (npm prefix differs per OS; try the usual homes).
function findFirebaseTools() {
    const candidates = [
        process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', 'firebase-tools'),
        '/usr/local/lib/node_modules/firebase-tools',
        '/usr/lib/node_modules/firebase-tools',
        process.env.HOME && path.join(process.env.HOME, '.npm-global', 'lib', 'node_modules', 'firebase-tools'),
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(path.join(c, 'lib', 'auth.js'))) return c;
    }
    return null;
}

const norm = (s) => String(s).replace(/\r\n/g, '\n').trimEnd();

// First differing line, so drift is actionable without a full diff tool.
function firstDiff(a, b) {
    const la = a.split('\n');
    const lb = b.split('\n');
    const n = Math.max(la.length, lb.length);
    for (let i = 0; i < n; i += 1) {
        if (la[i] !== lb[i]) {
            return { line: i + 1, live: la[i] === undefined ? '<absent>' : la[i], repo: lb[i] === undefined ? '<absent>' : lb[i] };
        }
    }
    return null;
}

(async () => {
    const ft = findFirebaseTools();
    if (!ft) {
        console.error('live-rules-check: global firebase-tools not found — install it (npm i -g firebase-tools) or run `firebase login` first.');
        process.exit(2);
    }
    const auth = require(path.join(ft, 'lib', 'auth'));
    // The account pinned to THIS repo directory (firebase login:use), else the global default —
    // the same resolution the CLI applies when it deploys from here.
    const account = (auth.getProjectDefaultAccount && auth.getProjectDefaultAccount(REPO_ROOT)) || auth.getGlobalDefaultAccount();
    if (!account || !account.tokens || !account.tokens.refresh_token) {
        console.error('live-rules-check: no stored Firebase CLI credential — run `firebase login` (as the account with access to the project).');
        process.exit(2);
    }
    let token;
    try {
        token = (await auth.getAccessToken(account.tokens.refresh_token, [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/firebase',
        ])).access_token;
    } catch (err) {
        console.error(`live-rules-check: token refresh failed for ${account.user && account.user.email}: ${err.message} — run \`firebase login --reauth\` from the repo root.`);
        process.exit(2);
    }
    const headers = { Authorization: `Bearer ${token}` };
    const api = async (p) => {
        const res = await fetch(`https://firebaserules.googleapis.com/v1/${p}`, { headers });
        const body = await res.json();
        if (!res.ok) throw new Error(`${p} → HTTP ${res.status}: ${(body.error && body.error.message) || JSON.stringify(body).slice(0, 200)}`);
        return body;
    };

    console.log(`live-rules-check: project ${PROJECT}, account ${account.user && account.user.email}`);
    let releases;
    try {
        releases = (await api(`projects/${PROJECT}/releases`)).releases || [];
    } catch (err) {
        console.error(`live-rules-check: cannot list releases — ${err.message}`);
        process.exit(1);
    }

    // Surface → { release name pattern, repo file }. Storage releases are named per bucket
    // (firebase.storage/<bucket>); every bucket must carry the repo's storage.rules.
    const surfaces = [
        { label: 'Firestore', releases: releases.filter((r) => r.name.endsWith('/releases/cloud.firestore')), file: 'firestore.rules' },
        { label: 'Storage', releases: releases.filter((r) => r.name.includes('/releases/firebase.storage/')), file: 'storage.rules' },
    ];

    let drift = false;
    for (const s of surfaces) {
        const repoPath = path.join(REPO_ROOT, s.file);
        if (!fs.existsSync(repoPath)) {
            console.log(`  ${s.label}: repo has no ${s.file} — skipped`);
            continue;
        }
        const repo = norm(fs.readFileSync(repoPath, 'utf8'));
        if (s.releases.length === 0) {
            console.log(`  ${s.label}: NO live release found — DRIFT (rules never deployed?)`);
            drift = true;
            continue;
        }
        for (const rel of s.releases) {
            const ruleset = await api(rel.rulesetName);
            const live = norm(ruleset.source.files.map((f) => f.content).join('\n'));
            const same = live === repo;
            const which = rel.name.split('/releases/')[1];
            console.log(`  ${s.label} [${which}]: released ${rel.updateTime}, ruleset ${rel.rulesetName.split('/').pop()} — ${same ? 'IN SYNC' : 'DRIFT'} (live ${live.length} B, repo ${repo.length} B)`);
            if (!same) {
                drift = true;
                const d = firstDiff(live, repo);
                if (d) console.log(`      first difference at line ${d.line}:\n        live: ${d.live}\n        repo: ${d.repo}`);
            }
        }
    }
    process.exit(drift ? 1 : 0);
})().catch((err) => {
    console.error(`live-rules-check: ${err.message}`);
    process.exit(1);
});
