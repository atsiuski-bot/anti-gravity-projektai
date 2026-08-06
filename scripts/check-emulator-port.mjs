// Preflight for `npm run test:firestore`: refuse to start when a port the emulator needs is
// already held, and name the process holding it.
//
// Why this exists. The Firebase CLI's own failures here are true but not actionable — they do
// not say WHAT is holding the port — so the reflex is to assume a stale run of your own and
// start guessing. Two DIFFERENT ports can fail, with different causes and different fixes:
//
//   FIRESTORE port (8180) — "Port 8180 is not open on localhost, could not start Firestore
//   Emulator". Almost always an ORPHANED emulator: `firebase emulators:exec` runs the emulator
//   as a Java child process, and killing the firebase wrapper does NOT reap it — verified
//   2026-08-02, when stopping a wrapper left its java child listening, and again on a java
//   emulator that had been holding the port since 2026-07-31 across a killed session.
//
//   HUB port (4477) — "hub: emulator hub unable to start on port N, starting on N+1 instead",
//   then a bare "Error: An unexpected error has occurred". The fallback port does not actually
//   serve, so every suite dies in discovery with
//   `FetchError: request to http://127.0.0.1:<N+1>/emulators failed, ECONNREFUSED` — a message
//   that points at the hub and says nothing about the port collision that caused it. Observed
//   2026-08-06 on the CLI's default hub port 4400, held by an unrelated long-running process.
//
// THE TWO ARE NOT SYMMETRIC, and the messages below differ accordingly:
//   - An orphan on the FIRESTORE port is dangerous. It may serve a DIFFERENT worktree's
//     firestore.rules (the 2026-07-31 one did), so moving the port would let a rules regression
//     pass against rules that are not the ones under test. Reap it; never route around it.
//   - A holder on the HUB port is usually an unrelated process that has nothing to do with this
//     repo. The hub carries no rules and no data — it is only a discovery endpoint — so moving
//     OUR declared port in firebase.json is a legitimate fix, and killing someone else's process
//     is not obviously the right call.
//
// Neither port is ever auto-picked. Failing loudly with the PID is the point: an auto-picked
// port would let the suite start while the orphan keeps running, hiding a leak.
//
// One failure CHAINS into the other: when the hub cannot start, the run dies after the java
// emulator is already up, orphaning it on the Firestore port — so the NEXT run trips the
// Firestore guard instead, with no sign of the hub problem that actually caused it. If you are
// reaping an orphan that you did not knowingly leave, suspect the hub.
//
// Ports are read from firebase.json so this cannot drift from the emulator config.

import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// BOTH loopback stacks must be probed. The hub collision that motivated this guard was a
// listener on ::1 only: a connect to 127.0.0.1 was REFUSED while the port was genuinely
// unbindable, because the CLI binds "localhost" and Windows resolves that to ::1 first. An
// IPv4-only probe reports such a port free and the guard never fires — verified 2026-08-06.
const LOOPBACKS = ['127.0.0.1', '::1'];

function emulatorPorts() {
    const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
    // A missing port means the CLI picks its own default; there is nothing of ours to guard.
    return [
        { kind: 'firestore', port: config?.emulators?.firestore?.port },
        { kind: 'hub', port: config?.emulators?.hub?.port },
    ].filter(entry => Boolean(entry.port));
}

// Resolves once we know whether anything accepts a connection on the port. A refused
// connection is the healthy case — nothing is listening, so the emulator can bind it.
function isPortHeldOn(host, port) {
    return new Promise((resolve) => {
        const socket = createConnection({ host, port });
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

async function isPortHeld(port) {
    for (const host of LOOPBACKS) {
        if (await isPortHeldOn(host, port)) return true;
    }
    return false;
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
"address : $($c.LocalAddress)"
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

function remedyFor(kind, details) {
    if (kind === 'firestore') {
        return (
            'This is usually an ORPHANED emulator: killing a `firebase emulators:*` wrapper leaves its\n' +
            'java child listening. It can also be the aftermath of a HUB port failure, which dies after\n' +
            'the java child is already up — check the hub port too if you did not leave this yourself.\n' +
            'Reap it, then re-run:\n\n' +
            `  ${killHint(details)}\n\n` +
            'Do not work around this by changing the port — an orphan may be serving a different\n' +
            "worktree's firestore.rules, in which case the suite would pass against the wrong rules.\n"
        );
    }
    return (
        'The hub is only the emulator DISCOVERY endpoint — it carries no rules and no data — so a\n' +
        'holder here is usually an unrelated process rather than a stale emulator of yours. Left\n' +
        'alone, the CLI "falls back" to the next port but does not actually serve there, and every\n' +
        'suite fails with ECONNREFUSED during discovery.\n\n' +
        'Either change OUR declared port (safe — unlike the Firestore port, nothing about the rules\n' +
        'under test depends on it):\n\n' +
        '  firebase.json -> emulators.hub.port\n\n' +
        'or, if the holder really is yours to stop:\n\n' +
        `  ${killHint(details)}\n`
    );
}

let blocked = false;

for (const { kind, port } of emulatorPorts()) {
    if (!(await isPortHeld(port))) continue;

    blocked = true;
    const label = kind === 'hub' ? 'emulator hub' : 'Firestore emulator';
    const details = describeHolder(port);

    process.stderr.write(
        `\nPort ${port} (${label}) is already in use — not starting the emulator.\n\n` +
        (details
            ? `Holding process:\n${details.replace(/^/gm, '  ')}\n\n`
            : 'Could not identify the holding process (insufficient permissions, or it exited just now).\n\n') +
        remedyFor(kind, details) +
        '\n'
    );
}

process.exit(blocked ? 1 : 0);
