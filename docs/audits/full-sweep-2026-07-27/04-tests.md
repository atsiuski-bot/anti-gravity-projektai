# Test evidence

Audited commit: `57a9324bbff91f7a7cc3347d488a00390d35b74f`

| Gate | Result |
|---|---|
| Root Vitest suite | PASS — 81 files passed, 5 skipped; 1,131 tests passed, 74 skipped |
| Firestore emulator suite | PASS — 5 files, 74/74 tests, 106.94 s |
| Functions integrity scans | PASS |
| Functions decision log | PASS |

The 74 root-suite skips are the same five Firestore integration suites that subsequently passed
against the emulator. This is important: the default root test command does not fail when the
emulator is absent, and the documented ship gate currently invokes only that default command.

The standalone Functions programs also pass, but are not wired into either the root test script
or a Functions package test script. The current commit is green; the delivery gate is
nevertheless incomplete.

