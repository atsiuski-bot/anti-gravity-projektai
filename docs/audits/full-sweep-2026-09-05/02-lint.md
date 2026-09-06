# 02 — Lint (deterministic)

**Command:** `npm run lint` → `eslint . --ext js,jsx --report-unused-disable-directives --max-warnings 0`
**Exit code:** 0 · **Raw:** `02-lint-raw.txt`
**Findings:** 🔴 0 · 🟠 0 · 🟡 0 · ℹ️ 1

## Result

Clean. Zero errors, zero warnings, zero unused `eslint-disable` directives across the whole
repo (`src/`, root config, `scripts/`). Because the gate runs with `--max-warnings 0`, any
warning would have been a 🟠 — there is none.

The Cloud Functions subtree has its own gate (`npm --prefix functions run lint` → `eslint .`),
recorded in `19-deps.md`: also clean, exit 0.

## ℹ️ Notes

- ℹ️ **ESLint 8.57.1 (end-of-life) is the lint engine in both packages.** ESLint 8 reached
  end-of-life in October 2024 and no longer receives security or compatibility fixes; latest
  is 10.x (flat config only). The lint *result* is green, but the *tool* is unmaintained and
  `eslint-plugin-react-hooks` 4.6.2 lags the 7.x line that understands React 19 / the compiler.
  Recorded as dependency debt in `19-deps.md`, not as a code finding.
