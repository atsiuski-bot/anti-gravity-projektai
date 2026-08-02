// Preflight for `npm run test:firestore`: refuse to start when the emulator port is
// already held, and name the process holding it.
//
// Why this exists. `firebase emulators:exec` fails with "Port 8180 is not open on
// localhost, could not start Firestore Emulator" and stops there. That sentence is true
// but not actionable: it does not say WHAT is holding the port, so the reflex is to assume
// a stale run of your own and start guessing.
//
// The port is almost always held by an ORPHANED emulator. `firebase emulators:start` runs
// the emulator as a Java child process, and killing the firebase wrapper does NOT reap it —
// verified 2026-08-02, when stopping a wrapper left its java child listening, and again on a
// java emulator that had been holding the port since 2026-07-31 across a killed session.
//
// Deliberately NOT auto-picking a free port. That would let the suite start while the orphan
// keeps running, which hides a leak instead of fixing it — and worse, the orphan may serve a
// DIFFERENT worktree's firestore.rules (the 2026-07-31 one did), so a rules regression could
// pass against rules that are not the ones under test. Failing loudly with the PID is the
// point.
//
// The port is read from firebase.json so this cannot drift from the emulator config.

import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const HOST = '127.0.0.1';

function emulatorPort() {
    const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
    const port = config?.emulators?.firestore?.port;
    if (!port) {
        // No explicit port means the CLI picks its own default; there is nothing to guard.
        process.exit(0);
    }
    return port;
}

// Resolves once we know whether anything accepts a connection on the port. A refused
// connection is the healthy case — nothing is listening, so the emulator can bind it.
function isPortHeld(port) {
    return new Promise((resolve) => {
        const socket = createConnection({ host: HOST, port });
        const settle = (held) => {
            socket.destroy();
            resolve(held);
        };
        socket.setTimeout(1500);
        socket.once('connect', () => settle(true));
        socket.once('timeout', () => settle(false));
        socket.once('error', () => settle(false));
    });
}

// Best-effort identification. Never throws: a preflight that crashes while diagnosing is
// worse than one that reports "could not identify" and still fails for the right reason.
function describeHolder(port) {
    try {
        if (process.platform === 'win32') {
            const ps = `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $c) { exit }
$p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
$cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)" -ErrorAction SilentlyContinue).CommandLine
"PID     : $($c.OwningProcess)"
"process : $($p.ProcessName)"
"started : $($p.StartTime)"
if ($cmd) { "command : $cmd" }`;
            return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
                encoding: 'utf8',
                timeout: 10_000,
            })
                // PowerShell pads its formatted output; strip it so the block reads clean.
                .replace(/[ \t]+$/gm, '')
                .trim();
        }
        return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
            encoding: 'utf8',
            timeout: 10_000,
        }).trim();
    } catch {
        return '';
    }
}

function killHint(details) {
    if (process.platform !== 'win32') return 'kill -9 <PID>';
    const pid = /PID\s*:\s*(\d+)/.exec(details)?.[1];
    return pid ? `Stop-Process -Id ${pid} -Force` : 'Stop-Process -Id <PID> -Force';
}

const port = emulatorPort();
if (!(await isPortHeld(port))) process.exit(0);

const details = describeHolder(port);

process.stderr.write(
    `\nPort ${port} is already in use — not starting the Firestore emulator.\n\n` +
    (details
        ? `Holding process:\n${details.replace(/^/gm, '  ')}\n\n`
        : 'Could not identify the holding process (insufficient permissions, or it exited just now).\n\n') +
    'This is usually an ORPHANED emulator: killing a `firebase emulators:*` wrapper leaves its\n' +
    'java child listening. Reap it, then re-run:\n\n' +
    `  ${killHint(details)}\n\n` +
    'Do not work around this by changing the port — an orphan may be serving a different\n' +
    "worktree's firestore.rules, in which case the suite would pass against the wrong rules.\n\n"
);
process.exit(1);
