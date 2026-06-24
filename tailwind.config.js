/** @type {import('tailwindcss').Config} */
// Design tokens — see docs/design/tokens.md (the source of truth) and DESIGN_SYSTEM.md.
// All keys are collision-safe: they extend, never override, Tailwind defaults — so existing
// markup keeps working while components migrate onto token classes.
//
// THEMING (ADR 0006): the calm-canvas/chrome tokens (brand, surface, ink, line, feedback) are
// CSS-variable-backed in the `rgb(var(--x) / <alpha-value>)` channel form so a single
// `data-theme` attribute on <html> swaps the whole palette while Tailwind opacity utilities
// (e.g. `bg-surface-card/50`) keep working. The light + dark channel values live in
// `src/index.css`. The signature SESSION colors are ALSO variable-backed (ADR 0016): the loud
// whole-screen identity is preserved, but dark mode swaps the pale light tints for deep same-hue
// tones instead of letting them glare on the dark canvas. The achievement TIER medallions stay
// LITERAL hex — they are self-contained and theme-invariant by design. `feedback.scrim` is the one
// modal backdrop opacity and is likewise constant.
const withAlpha = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                brand: {
                    DEFAULT: withAlpha('--brand'),
                    hover: withAlpha('--brand-hover'),
                    soft: withAlpha('--brand-soft'),
                    ring: withAlpha('--brand-ring'),
                },
                surface: {
                    base: withAlpha('--surface-base'),
                    card: withAlpha('--surface-card'),
                    sunken: withAlpha('--surface-sunken'),
                },
                ink: {
                    strong: withAlpha('--ink-strong'),
                    DEFAULT: withAlpha('--ink'),
                    muted: withAlpha('--ink-muted'),
                },
                line: withAlpha('--line'),
                // Make the DEFAULT border color theme-aware too: Tailwind's preflight pins bare
                // `border` (no color class) to a literal gray-200, which would stay light in dark
                // mode. Routing it through --line keeps light identical and fixes any uncolored
                // border in dark. Explicit border-line / border-feedback-* still work (from colors).
                // Session colors (closed set, §4) — the loud full-screen state identity. NOW
                // theme-REACTIVE (ADR 0016): the light palette is byte-identical to the old literal
                // hex, but each token is CSS-variable-backed so the dark theme can swap the pale
                // light tints (which glared on the dark canvas) for deep, same-hue tones that still
                // read as red/blue/amber/green. `accent` keeps ONE fill-safe value in both themes
                // (white text rides on it) and lightens only as FOREGROUND text via a `[data-theme=
                // "dark"] .text-session-*-accent` override in index.css — the same fill-vs-foreground
                // decoupling used for `feedback`/`brand`. `soft` is the session-tinted BORDER/RING
                // tint for secondary controls. Channel values live in src/index.css.
                session: {
                    quickWork: {
                        shell: withAlpha('--session-quickwork-shell'),
                        surface: withAlpha('--session-quickwork-surface'),
                        accent: withAlpha('--session-quickwork-accent'),
                        soft: withAlpha('--session-quickwork-soft'),
                    },
                    call: {
                        shell: withAlpha('--session-call-shell'),
                        surface: withAlpha('--session-call-surface'),
                        accent: withAlpha('--session-call-accent'),
                        soft: withAlpha('--session-call-soft'),
                    },
                    break: {
                        shell: withAlpha('--session-break-shell'),
                        surface: withAlpha('--session-break-surface'),
                        accent: withAlpha('--session-break-accent'),
                        soft: withAlpha('--session-break-soft'),
                    },
                    task: {
                        shell: withAlpha('--session-task-shell'),
                        surface: withAlpha('--session-task-surface'),
                        accent: withAlpha('--session-task-accent'),
                        soft: withAlpha('--session-task-soft'),
                    },
                },
                // Achievement tiers (closed set) — calm surface + AA-passing accent text + a
                // metallic ring. Self-contained medallions; theme-invariant literal hex (a light
                // medallion reads fine on a dark card). See tokens.md §1.
                tier: {
                    bronze: { surface: '#F3E4D3', accent: '#7A4A21', ring: '#C28E5A' },
                    silver: { surface: '#E8EAED', accent: '#4B5563', ring: '#B6BCC4' },
                    gold: { surface: '#FBEFC6', accent: '#8A6500', ring: '#DCBB4A' },
                    platinum: { surface: '#E6ECF2', accent: '#334155', ring: '#9FB2C6' },
                },
                // Feedback (messages & validation — never decorative). Each color carries a tint
                // TRIAD because the app consumes colored states as soft bg + border + accent text:
                //   DEFAULT  solid fill / on-white foreground icon (pairs with text-white)
                //   soft     tinted background (was bg-*-50)
                //   border   tint border       (was border-*-200)
                //   text     accent text on a tint/white (was text-*-700, AA on soft)
                //   hover    solid-button hover (was hover:bg-*-700)
                // `.text-feedback-*` DEFAULT also gets a dark foreground override in index.css so a
                // solid accent stays legible directly on the dark canvas.
                feedback: {
                    success: {
                        DEFAULT: withAlpha('--fb-success'),
                        soft: withAlpha('--fb-success-soft'),
                        border: withAlpha('--fb-success-border'),
                        text: withAlpha('--fb-success-text'),
                        hover: withAlpha('--fb-success-hover'),
                    },
                    warning: {
                        DEFAULT: withAlpha('--fb-warning'),
                        soft: withAlpha('--fb-warning-soft'),
                        border: withAlpha('--fb-warning-border'),
                        text: withAlpha('--fb-warning-text'),
                        hover: withAlpha('--fb-warning-hover'),
                    },
                    danger: {
                        DEFAULT: withAlpha('--fb-danger'),
                        soft: withAlpha('--fb-danger-soft'),
                        border: withAlpha('--fb-danger-border'),
                        text: withAlpha('--fb-danger-text'),
                        hover: withAlpha('--fb-danger-hover'),
                    },
                    info: {
                        DEFAULT: withAlpha('--fb-info'),
                        soft: withAlpha('--fb-info-soft'),
                        border: withAlpha('--fb-info-border'),
                        text: withAlpha('--fb-info-text'),
                        hover: withAlpha('--fb-info-hover'),
                    },
                    offline: withAlpha('--fb-offline'),
                    scrim: 'rgb(0 0 0 / 0.5)',
                },
            },
            // The DEFAULT border color (used by a bare `border` with no color class) is themed via
            // --line so uncolored hairlines don't stay light in dark mode (see note in colors.line).
            borderColor: { DEFAULT: withAlpha('--line') },
            fontSize: {
                caption: ['12px', '16px'],
                body: ['14px', '20px'],
                'body-lg': ['16px', '24px'],
                h3: ['18px', '24px'],
                h2: ['20px', '28px'],
                h1: ['24px', '32px'],
                display: ['30px', '36px'],
            },
            // Semantic radii — deliberately NOT named sm/lg/xl so Tailwind defaults stay intact.
            borderRadius: { input: '6px', control: '8px', card: '12px', modal: '16px' },
            zIndex: { header: '20', nav: '30', backdrop: '40', modal: '50', toast: '60', top: '70' },
            transitionDuration: { fast: '150', base: '200', slow: '300' },
            spacing: { navclear: '8rem', 'navclear-lg': '9rem' },
            minHeight: { touch: '44px' },
            minWidth: { touch: '44px' },
        },
    },
    plugins: [],
}
