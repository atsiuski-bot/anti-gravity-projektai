/**
 * Source consistency gate — invariants that live in MORE THAN ONE FILE and that neither the linter
 * nor the type system can see.
 *
 * WHY THIS EXISTS (separate from firebaseConsistency.test.js)
 * That gate covers drift across the client / Cloud Functions / rules deploy boundary. This one
 * covers a different failure mode with the same shape: two places in the SAME codebase that must
 * agree, where each side is individually valid so nothing complains — only their COMBINATION is
 * wrong. Every case below is a defect that actually shipped and was found by reading, not by a test:
 *
 *   1. ManagerView gated the legacy recovery nets on a raw `!timerEngineEnabled` while WorkerView
 *      used the resolved-aware `legacyRecoveryOwns`. Both lines compile, both look reasonable, and
 *      for up to five seconds after boot the manager ran BOTH recovery models against one session.
 *   2. `workDay.test.cjs` existed and passed, but was absent from the test scripts — and when that
 *      was fixed in functions/package.json, the RELEASE gate still missed it, because the root
 *      package.json carries its own duplicated copy of the file list.
 *   3. docs/design/tokens.md drifted from the runtime palette: three colours had been darkened for
 *      WCAG in src/index.css while the binding document still documented the old values, in two
 *      places each (the table AND the config snippet).
 *
 * The technique is the one that already works next door: read the other files as TEXT and assert
 * they agree. It costs nothing at runtime and it fails the ship, which is the only moment anyone
 * is looking.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // src/__tests__ -> repo root
const SRC = resolve(ROOT, 'src');

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      files.push(...walk(full));
    } else if (/\.(js|jsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

// Production sources only — this file names the very identifiers it scans for, and a test file is
// not a call site.
const PROD_SOURCES = walk(SRC).filter((f) => !/\.test\.(js|jsx)$/.test(f) && !/__tests__/.test(f));

/**
 * Drop comments before scanning for code. WORKZ comments explain their own subject at length and
 * routinely write a hook's name followed by a parenthesis in prose — which reads exactly like a call
 * site. (useTaskTimeMonitor.js says "useOrphanedTaskRecovery (mirroring the same APP_LOAD_TIME
 * instant)" and that alone failed this gate on its first run.)
 *
 * Not a general-purpose stripper: it will also cut inside a string that contains `//`. That is
 * harmless here because the only thing read afterwards is whether a known identifier is CALLED, and
 * no string literal in this repo contains one.
 */
const codeOnly = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/**
 * Every production source, read and comment-stripped ONCE at module load.
 *
 * A source-scanning gate is I/O-bound, and its cost must not be charged to a per-test timeout meant
 * for interactive assertions: the scans below used to re-read the whole tree inside each `it()`, so
 * the same 250 files were opened five times over and, under a parallel full-suite run on Windows,
 * that alone exceeded vitest's 5s default and failed the ship with a timeout rather than a verdict.
 * Extracting at module scope is what sections 2 and 3 already do — the tests assert, they do not scan.
 */
const PROD_CODE = PROD_SOURCES.map((file) => ({
  file: file.slice(ROOT.length + 1).replace(/\\/g, '/'),
  code: codeOnly(readFileSync(file, 'utf8')),
}));

// =============================================================================================
// 1. RECOVERY OWNERSHIP WIRING — which recovery net owns an orphaned run is a question about the
//    ENGINE, so it cannot be answered before the rollout flag has RESOLVED. `!timerEngineEnabled`
//    answers "legacy" during that window, and the legacy closer only clears the projection flags —
//    so it can tear down the visible half of a canonical run and leave active_sessions still
//    claiming it active, which is the wedged state the canonical nets exist to prevent.
//
//    The rule is therefore: every legacy-recovery call site passes `legacyRecoveryOwns`, and every
//    definition of that name is the resolved-aware expression. Enforced across ALL of src/ rather
//    than by comparing the two views pairwise, so a THIRD screen mounting these hooks is covered
//    the day it is written.
// =============================================================================================

describe('legacy recovery ownership wiring', () => {
  const LEGACY_RECOVERY_HOOKS = ['useOrphanedTaskRecovery', 'useOrphanedSessionRecovery'];

  // Call sites only: a definition (`export function useX(`) is not a call.
  function callSites(hook) {
    const found = [];
    for (const { file, code } of PROD_CODE) {
      const re = new RegExp(`(function\\s+)?\\b${hook}\\s*\\(([^)]*)\\)`, 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        if (m[1]) continue; // the hook's own declaration
        found.push({ file, args: m[2] });
      }
    }
    return found;
  }

  const CALL_SITES = LEGACY_RECOVERY_HOOKS.map((hook) => ({ hook, sites: callSites(hook) }));

  const DEFINITIONS = PROD_CODE.flatMap(({ file, code }) => {
    const found = [];
    const re = /const\s+legacyRecoveryOwns\s*=\s*([^;]+);/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      found.push({ file, expr: m[1].replace(/\s+/g, ' ').trim() });
    }
    return found;
  });

  it('found the recovery hook call sites (extraction sanity)', () => {
    // Guards the regex itself: if this ever reads empty, the assertion below would pass vacuously
    // and the gate would be silently disarmed — the exact class of failure this file exists for.
    for (const { hook, sites } of CALL_SITES) {
      expect(sites.length, `No call sites found for ${hook} — the extraction regex broke.`)
        .toBeGreaterThan(0);
    }
  });

  it('every legacy-recovery call site is gated on legacyRecoveryOwns, never on a raw flag', () => {
    const offenders = [];
    for (const { hook, sites } of CALL_SITES) {
      for (const { file, args } of sites) {
        const last = args.split(',').pop().trim();
        if (last !== 'legacyRecoveryOwns') {
          offenders.push(`${file}: ${hook}(… ${last}) — expected legacyRecoveryOwns`);
        }
      }
    }
    expect(
      offenders,
      `A legacy recovery net is gated on something other than legacyRecoveryOwns:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('legacyRecoveryOwns means "resolved AND disabled" everywhere it is defined', () => {
    expect(DEFINITIONS.length, 'No legacyRecoveryOwns definition found — the extraction regex broke.')
      .toBeGreaterThan(0);

    const wrong = DEFINITIONS.filter((d) => d.expr !== 'timerEngineResolved && !timerEngineEnabled');
    expect(
      wrong,
      `legacyRecoveryOwns must be \`timerEngineResolved && !timerEngineEnabled\`:\n${wrong
        .map((d) => `${d.file}: ${d.expr}`)
        .join('\n')}`,
    ).toEqual([]);
  });
});

// =============================================================================================
// 2. TEST-SCRIPT COVERAGE — the functions/ suites run on bare node, and their file list is written
//    out BY HAND in two package.json files: functions/package.json (`test`) and the root
//    package.json (`test:functions`, the one the release gate actually invokes). A suite missing
//    from either is a test that exists, passes when run directly, and protects nothing.
// =============================================================================================

describe('functions test-script coverage', () => {
  const suites = readdirSync(resolve(ROOT, 'functions')).filter((f) => /\.test\.cjs$/.test(f));
  const rootScript = JSON.parse(read('package.json')).scripts['test:functions'] || '';
  const fnScript = JSON.parse(read('functions/package.json')).scripts.test || '';

  it('found the functions test suites (extraction sanity)', () => {
    expect(suites.length, 'No functions/*.test.cjs found — did the suites move?').toBeGreaterThan(0);
  });

  it('every functions suite is wired into BOTH test scripts', () => {
    const missing = [];
    for (const suite of suites) {
      if (!rootScript.includes(suite)) missing.push(`${suite} → root package.json "test:functions"`);
      if (!fnScript.includes(suite)) missing.push(`${suite} → functions/package.json "test"`);
    }
    expect(
      missing,
      `A functions suite exists but is never run by the gate:\n${missing.join('\n')}`,
    ).toEqual([]);
  });
});

// =============================================================================================
// 3. DESIGN TOKEN DOC ↔ RUNTIME — docs/design/tokens.md is BINDING (CLAUDE.md), but it is
//    maintained by hand while the runtime palette is what gets fixed under pressure, so the two
//    drift in one direction: the document keeps documenting a colour that failed WCAG and was
//    already replaced.
//
//    Scope is deliberate. Only TABLE ROWS and the config code fence carry token values; prose and
//    blockquotes legitimately mention colours that are NOT tokens — a contrast threshold to stay
//    under, or a historical note about a magic hex that was removed. Those must not fail the gate.
// =============================================================================================

describe('design tokens doc ↔ runtime palette', () => {
  const toHex = (r, g, b) =>
    `#${[r, g, b].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  // Every colour the runtime actually renders: literal hexes in either file, plus the
  // space-separated RGB channel triples index.css stores its CSS variables as (and the rgb(...)
  // overrides beside them).
  const runtimeHexes = (() => {
    const css = read('src/index.css');
    const tw = read('tailwind.config.js');
    const out = new Set();
    for (const m of `${tw}\n${css}`.matchAll(/#([0-9a-fA-F]{6})\b/g)) out.add(`#${m[1]}`.toUpperCase());
    for (const m of css.matchAll(/(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})\s*[;)]/g)) {
      out.add(toHex(m[1], m[2], m[3]));
    }
    return out;
  })();

  const documentedHexes = (() => {
    const out = new Set();
    let inFence = false;
    for (const line of read('docs/design/tokens.md').split(/\r?\n/)) {
      if (line.trim().startsWith('```')) {
        inFence = !inFence;
        continue;
      }
      // Token values live in table rows and in the tailwind.config.js snippet — nowhere else.
      if (!inFence && !line.trim().startsWith('|')) continue;
      for (const m of line.matchAll(/#([0-9a-fA-F]{6})\b/g)) out.add(`#${m[1]}`.toUpperCase());
    }
    return out;
  })();

  it('extracted colours from both sides (extraction sanity)', () => {
    expect(documentedHexes.size, 'No token colours parsed out of tokens.md — the format moved.')
      .toBeGreaterThan(20);
    expect(runtimeHexes.size, 'No colours parsed out of the runtime palette — the format moved.')
      .toBeGreaterThan(20);
  });

  it('every colour the doc documents as a token still exists in the runtime palette', () => {
    const stale = [...documentedHexes].filter((h) => !runtimeHexes.has(h));
    expect(
      stale,
      `tokens.md documents colours that no longer exist in src/index.css or tailwind.config.js — ` +
        `the doc is describing a palette that was already changed (check BOTH the table and the ` +
        `config snippet; each value appears twice):\n${stale.join(' ')}`,
    ).toEqual([]);
  });
});

// =============================================================================================
// 4. REACT ROUTER DEFERRAL PRECONDITIONS (ADR 0030) — two advisories against react-router have no
//    fix in any 6.x release (GHSA-wrjc-x8rr-h8h6 backslash open redirect, GHSA-337j-9hxr-rhxg
//    deserializeErrors constructor injection), so npm's only remedy is the react-router-dom@7
//    major. We stay on 6.x because neither advisory describes code this app runs — but that is a
//    claim about OUR USAGE, not about the library, and it expires the moment somebody writes the
//    usage it excludes. ADR 0030 names three conditions; this section is what makes them fail the
//    ship instead of quietly becoming false.
//
//    Scanning IMPORT SPECIFIERS rather than JSX is deliberate and is the only precise option here:
//    `<Link` also matches this repo's own `<Linkify>` and lucide's `<LinkIcon>`, while react-router's
//    Link cannot be used without being imported. The namespace-import check closes the one hole that
//    leaves (`import * as RR from 'react-router-dom'`).
//
//    If this gate goes red, the correct response is NOT to relax it: the deferral is void, and
//    closing the advisories — migrate to v7, or delete react-router and hand its two routes to
//    NavigationContext — becomes the next dependency task. See docs/adr/0030-*.md.
// =============================================================================================

describe('react-router deferral preconditions (ADR 0030)', () => {
  // Condition 1 (navigation components that carry the open redirect) + condition 3 (every symbol
  // that only exists on the data-router path, which is where deserializeErrors lives).
  const BANNED_SPECIFIERS = [
    'Link',
    'NavLink',
    'Form',
    'createBrowserRouter',
    'createHashRouter',
    'createMemoryRouter',
    'RouterProvider',
    'StaticRouterProvider',
    'HydratedRouter',
    'useLoaderData',
    'useActionData',
    'useFetcher',
    'useSubmit',
  ];

  // Condition 3's other half: a server render is what makes the hydration path exist at all. These
  // come from react-dom, not react-router, so they are matched as bare identifiers.
  const SSR_ENTRY_SYMBOLS = [
    'hydrateRoot',
    'renderToString',
    'renderToPipeableStream',
    'renderToReadableStream',
  ];

  const ROUTER_IMPORTS = PROD_CODE.flatMap(({ file, code }) => {
    const found = [];
    const re = /import\s*\{([^}]*)\}\s*from\s*['"]react-router(?:-dom)?['"]/g;
    let m;
    while ((m = re.exec(code)) !== null) {
      const specifiers = m[1]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
        .filter(Boolean);
      found.push({ file, specifiers });
    }
    return found;
  });

  // Every place the app decides WHERE to go. `\bnavigate\s*\(` cannot match `useNavigate(` — the
  // preceding `e` is a word character, so the boundary fails — so this reads call sites only.
  const NAV_TARGETS = PROD_CODE.flatMap(({ file, code }) => {
    const found = [];
    let m;
    const imperative = /\bnavigate\s*\(\s*([^,)]*)/g;
    while ((m = imperative.exec(code)) !== null) {
      found.push({ file, kind: 'navigate(…)', target: m[1].trim() });
    }
    const declarative = /<Navigate\b[^>]*?\bto=(\{[^}]*\}|"[^"]*"|'[^']*')/g;
    while ((m = declarative.exec(code)) !== null) {
      found.push({ file, kind: '<Navigate to=…>', target: m[1].trim() });
    }
    return found;
  });

  // A literal is a quoted string (optionally inside JSX braces) or a history delta like -1. Anything
  // else — an identifier, a member expression, a template literal — can carry a value the app did
  // not author, which is exactly what the open redirect needs.
  const isLiteralTarget = (t) =>
    /^'[^']*'$/.test(t) ||
    /^"[^"]*"$/.test(t) ||
    /^-?\d+$/.test(t) ||
    /^\{\s*'[^']*'\s*\}$/.test(t) ||
    /^\{\s*"[^"]*"\s*\}$/.test(t);

  it('found the react-router imports and the navigation targets (extraction sanity)', () => {
    // Without this, every assertion below passes vacuously the day a regex stops matching — the gate
    // would report green while enforcing nothing, which is worse than not having it.
    expect(ROUTER_IMPORTS.length, 'No react-router import found — the extraction regex broke.')
      .toBeGreaterThan(0);
    expect(
      ROUTER_IMPORTS.every((i) => i.specifiers.length > 0),
      'A react-router import parsed to zero specifiers — the extraction regex broke.',
    ).toBe(true);
    expect(NAV_TARGETS.length, 'No navigation target found — the extraction regex broke.')
      .toBeGreaterThan(0);
  });

  it('condition 1 & 3: no react-router Link/NavLink/Form and no data-router symbol is imported', () => {
    const offenders = [];
    for (const { file, specifiers } of ROUTER_IMPORTS) {
      for (const spec of specifiers) {
        if (BANNED_SPECIFIERS.includes(spec)) offenders.push(`${file}: imports { ${spec} }`);
      }
    }
    expect(
      offenders,
      `ADR 0030's deferral is void — these imports make a react-router advisory reachable:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });

  it('condition 1 & 3: react-router is never imported as a namespace (which would hide the above)', () => {
    const offenders = PROD_CODE.filter(({ code }) =>
      /import\s+\*\s+as\s+\w+\s+from\s*['"]react-router(?:-dom)?['"]/.test(code),
    ).map(({ file }) => file);
    expect(
      offenders,
      `A namespace import puts every banned symbol back in reach:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('condition 2: every navigation target is a hardcoded literal', () => {
    const offenders = NAV_TARGETS.filter(({ target }) => !isLiteralTarget(target)).map(
      ({ file, kind, target }) => `${file}: ${kind} ← ${target || '(empty)'}`,
    );
    expect(
      offenders,
      `A navigation destination is not a literal, so GHSA-wrjc-x8rr-h8h6 becomes reachable:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });

  it('condition 3: the app has no server-render entry point', () => {
    const offenders = [];
    for (const { file, code } of PROD_CODE) {
      for (const symbol of SSR_ENTRY_SYMBOLS) {
        if (new RegExp(`\\b${symbol}\\s*\\(`).test(code)) offenders.push(`${file}: ${symbol}(…)`);
      }
    }
    expect(
      offenders,
      `A server render makes the deserializeErrors hydration path (GHSA-337j-9hxr-rhxg) exist:\n${offenders.join(
        '\n',
      )}`,
    ).toEqual([]);
  });
});
