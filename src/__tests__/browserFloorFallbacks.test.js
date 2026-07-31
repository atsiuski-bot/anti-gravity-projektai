/**
 * Browser-floor gate — CSS this app uses that its OLDEST supported engines cannot parse.
 *
 * WHY THIS EXISTS
 * package.json "browserslist" declares the floor (Safari/iOS 14, Chrome 87, Firefox 78, Edge 88)
 * and vite.config.js mirrors it for JS. That covers SYNTAX: esbuild lowers the bundle and the build
 * fails loudly if it cannot. CSS has no such gate. An unsupported CSS feature does not fail the
 * build and does not throw at runtime — the engine silently DROPS the declaration and the layout
 * quietly loses a rule it depended on. On a field worker's phone that reads as "the app is broken"
 * with nothing anywhere to explain why.
 *
 * Two such features are in use, each with a hand-written fallback in index.css:
 *   - `dvh` (needs Safari 15.4+) caps modal height. Dropped => no cap => a long dialog runs off the
 *     bottom of the screen with no internal scroll.
 *   - `:has()` (needs Safari 15.4+ / Firefox 121+) draws a focus ring. Dropped => no visible focus
 *     indicator, which DESIGN_SYSTEM treats as a hard a11y requirement, not a nicety.
 *
 * A fallback written once decays silently: the next component to reach for `max-h-[70dvh]` gets no
 * warning that its twin is missing. So this test derives the required set from the COMPONENTS and
 * fails when index.css has not kept up.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'src');
const INDEX_CSS = readFileSync(join(SRC, 'index.css'), 'utf8');

/** Every .jsx/.js under src/, excluding tests (a test may mention a class it does not render). */
const sourceFiles = (dir) => {
    const out = [];
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...sourceFiles(full));
            continue;
        }
        if (!/\.(jsx?|tsx?)$/.test(entry)) continue;
        if (/\.test\.[jt]sx?$/.test(entry)) continue;
        out.push(full);
    }
    return out;
};

/**
 * Tailwind escapes an arbitrary value into a class selector: `max-h-[80dvh]` becomes
 * `.max-h-\[80dvh\]`. The fallback in index.css must use that same escaped form, so build it here
 * rather than trusting the two to be written identically by hand.
 */
const escapeTailwindClass = (cls) => cls.replace(/[[\]():.%,/]/g, (ch) => `\\${ch}`);

describe('browser-floor CSS fallbacks (index.css)', () => {
    it('every dvh utility used in a component has a vh twin in index.css', () => {
        // Match the UTILITY SHAPE (optional variants + an arbitrary value containing dvh) rather
        // than scanning class attributes: Modal.jsx builds its class list as clsx() string
        // arguments, which no attribute pattern sees. Prose in the surrounding comments quotes the
        // same class names, and matching those is harmless — they name real utilities in use.
        const UTILITY = /(?:[a-z-]+:)*[a-z-]+-\[[^\]\s"'`]*dvh[^\]\s"'`]*\]/g;
        const used = new Set();
        for (const file of sourceFiles(SRC)) {
            for (const [cls] of readFileSync(file, 'utf8').matchAll(UTILITY)) used.add(cls);
        }

        expect(used.size, 'no dvh utilities found — the extraction above has stopped working').toBeGreaterThan(0);

        const missing = [...used].filter((cls) => !INDEX_CSS.includes(`.${escapeTailwindClass(cls)}`));
        expect(
            missing,
            `index.css has no vh fallback for: ${missing.join(', ')}. Below Safari 15.4 these `
            + 'declarations are dropped and the element loses its height cap entirely.'
        ).toEqual([]);
    });

    it('the vh fallbacks are emitted BEFORE the dvh utilities they back up', () => {
        // Position is the whole mechanism: same specificity means the LAST rule wins, so a fallback
        // that lands after `@tailwind utilities` overrides dvh on every browser and silently undoes
        // the dynamic-viewport behaviour. Everything else in this file deliberately sits after that
        // directive, which makes this the easiest line in the repo to "tidy" into a bug.
        // Anchored: the explanatory comment above the fallbacks quotes the directive by name.
        const utilities = INDEX_CSS.search(/^@tailwind utilities/m);
        const firstFallback = INDEX_CSS.search(/^\.max-h-\\\[\d+dvh\\\]/m);
        expect(utilities, '@tailwind utilities directive not found').toBeGreaterThan(-1);
        expect(firstFallback, 'dvh fallback rules not found').toBeGreaterThan(-1);
        expect(
            firstFallback < utilities,
            'the dvh fallbacks must sit between @tailwind components and @tailwind utilities'
        ).toBe(true);
    });

    it('the responsive fallbacks survive the Tailwind/PostCSS pass into the built stylesheet', () => {
        // Learned the hard way: wrapped in `@layer base`, Tailwind DROPPED the nested @media blocks
        // and the two responsive fallbacks vanished from dist/ with no error anywhere — the source
        // looked correct and the shipped stylesheet was not. Only the built artifact can prove it.
        const distAssets = join(process.cwd(), 'dist', 'assets');
        let built;
        try {
            const css = readdirSync(distAssets).filter((f) => f.startsWith('index-') && f.endsWith('.css'));
            if (!css.length) return; // no build in this checkout — the source-order test above still guards
            built = readFileSync(join(distAssets, css[0]), 'utf8');
        } catch {
            return; // dist/ absent (fresh clone, CI without a build step)
        }

        // These pairs DESCRIBE the expressions in index.css / Modal.jsx, so when one of those
        // legitimately changes the description has to follow — the two modal rows gained an
        // `env(safe-area-inset-bottom)` term when the cap started tracking the bottom dock's real
        // height. Editing a row to match a NEW value is fine; deleting a row is not, because that
        // is how a fallback goes missing without anything failing.
        for (const [fallback, real] of [
            ['.max-h-\\[60dvh\\]{max-height:60vh}', '.max-h-\\[60dvh\\]{max-height:60dvh}'],
            ['.max-h-\\[80dvh\\]{max-height:80vh}', '.max-h-\\[80dvh\\]{max-height:80dvh}'],
            ['.h-\\[70dvh\\]{height:70vh}', '.h-\\[70dvh\\]{height:70dvh}'],
            ['{max-height:calc(100vh - 9rem - env(safe-area-inset-bottom))}', '{max-height:calc(100dvh - 9rem - env(safe-area-inset-bottom))}'],
            ['{max-height:calc(100vh - 10rem - env(safe-area-inset-bottom))}', '{max-height:calc(100dvh - 10rem - env(safe-area-inset-bottom))}'],
            ['.lg\\:max-h-\\[90dvh\\]{max-height:90vh}', '.lg\\:max-h-\\[90dvh\\]{max-height:90dvh}'],
        ]) {
            const i = built.indexOf(fallback);
            const j = built.indexOf(real);
            expect(i, `built CSS is missing the fallback ${fallback}`).toBeGreaterThan(-1);
            expect(j, `built CSS is missing the dvh rule ${real}`).toBeGreaterThan(-1);
            expect(i < j, `built CSS orders ${fallback} AFTER ${real} — the fallback would win everywhere`).toBe(true);
        }
    });

    it('every has-[] utility used in a component has a :focus-within fallback', () => {
        const used = new Set();
        for (const file of sourceFiles(SRC)) {
            const text = readFileSync(file, 'utf8');
            for (const [, attr] of text.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]*)["'`]/g)) {
                for (const cls of attr.split(/\s+/)) {
                    if (cls.startsWith('has-[')) used.add(cls);
                }
            }
        }
        if (used.size === 0) return; // nothing to guard yet

        const fallbackBlock = INDEX_CSS.match(/@supports not selector\(:has\(\*\)\)\s*\{([\s\S]*?)\n\}/);
        expect(fallbackBlock, 'index.css is missing the @supports not selector(:has(*)) block').toBeTruthy();

        const missing = [...used].filter((cls) => !fallbackBlock[1].includes(`.${escapeTailwindClass(cls)}`));
        expect(
            missing,
            `no :focus-within fallback for: ${missing.join(', ')}. Below Safari 15.4 the rule is `
            + 'dropped and the control has no visible focus indicator.'
        ).toEqual([]);
    });
});

describe('boot watchdog (index.html)', () => {
    const HTML = readFileSync(join(process.cwd(), 'index.html'), 'utf8');
    const MAIN = readFileSync(join(SRC, 'main.jsx'), 'utf8');

    it('is armed in index.html and disarmed by main.jsx', () => {
        // The two halves are in different languages in different files with nothing but this name
        // linking them: rename one and the watchdog fires over a perfectly healthy app.
        expect(HTML).toContain('__workzBooted');
        expect(MAIN).toContain('window.__workzBooted = true');
    });

    it('stays ES5 so it parses on engines that rejected the bundle', () => {
        // The watchdog's entire job is to run where the module bundle could not. Arrow functions,
        // `const`/`let` and template literals are exactly what an engine below the floor chokes on,
        // and a SyntaxError here would take the recovery screen down with the app.
        const watchdog = HTML.slice(HTML.indexOf('var GRACE_MS'), HTML.lastIndexOf('</script>'));
        expect(watchdog.length).toBeGreaterThan(0);
        expect(watchdog).not.toMatch(/=>/);
        expect(watchdog).not.toMatch(/\b(const|let)\s/);
        expect(watchdog).not.toMatch(/`/);
    });

    it('hands its record to the durable error log', () => {
        const LOG = readFileSync(join(SRC, 'utils', 'errorLog.js'), 'utf8');
        expect(HTML).toContain('workz_boot_failure');
        expect(LOG).toContain('workz_boot_failure');
    });
});
