# Dependency evidence

Audited commit: `57a9324bbff91f7a7cc3347d488a00390d35b74f`

Fresh lockfile installs completed successfully.

| Package tree | Install-time advisory count |
|---|---:|
| Root | 15 total: 1 low, 9 moderate, 4 high, 1 critical |
| Functions | 10 total: 8 moderate, 2 high |

These counts are unresolved risk signals, not enough evidence to assign product severity:
install output does not establish whether an advisory is production-reachable or dev-only.
A detailed advisory export was blocked by the environment's package-metadata egress policy, so
the audit does not speculate about affected packages or fixes.

Recommended follow-up: retrieve the advisory details in an approved environment, classify
runtime reachability, and update only packages whose fix path is compatible with the current
Firebase/Vite stack.

