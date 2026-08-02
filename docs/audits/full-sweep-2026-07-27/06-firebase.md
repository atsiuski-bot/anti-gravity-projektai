# Firebase local/live comparison

Audited commit: `57a9324bbff91f7a7cc3347d488a00390d35b74f`

## Composite indexes

- Local normalized indexes: 13
- Live normalized indexes: 13
- Missing live indexes: 0
- Unexpected live indexes: 0

## Cloud Functions

- Local exported function IDs: 23
- Live active function IDs: 23
- Missing live functions: 0
- Unexpected live functions: 0
- Observed runtime: Node.js 22

The latest `notifyOverEstimateTimers` function is active in the live inventory.

## Limitation

The available read-only tooling did not expose the live Firestore ruleset body, so rules
content could not be compared byte-for-byte with this commit. The local rules passed all 74
emulator tests.

