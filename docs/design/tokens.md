# WORKZ — Design Tokens

> The canonical, machine-facing values behind [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md).
> These are the **source of truth**. The end state is that `tailwind.config.js`
> `theme.extend` implements this table and components reference token names — not raw
> Tailwind utilities with arbitrary values.

**Status:** Active — wired in `tailwind.config.js` · See [ADR 0001](../adr/0001-visual-design-system.md).

Values are expressed as Tailwind palette references where possible (so the migration is
mechanical) with the resolved hex in parentheses.

---

## 0. Theming — light / dark ([ADR 0008](../adr/0008-user-selectable-theme.md))

The **calm-canvas/chrome** token groups — `brand`, `surface`, `ink`, `line`, `feedback` — are
**CSS-variable-backed**: `tailwind.config.js` defines each as `rgb(var(--x) / <alpha-value>)`
(channel form, so opacity utilities like `bg-surface-card/50` still work), and the actual
channel values for **both themes** live in `src/index.css` under `:root` (light) and
`[data-theme="dark"]`. A single `data-theme` attribute on `<html>` (set before first paint by a
boot script in `index.html`, owned at runtime by `ThemeProvider`) swaps the whole palette. The
light values below are unchanged; the table is the LIGHT source of truth, `index.css` is the dark
override.

**Theme-INVARIANT (literal hex in the config, no dark variant):** the **session** colors (§ below
— the loud whole-screen identity), the **tier** medallions, and `feedback.scrim`. The loud
time-warning / time-limit popups are likewise kept vivid in both themes.

**Feedback gained a tint triad.** Each of `feedback.{success,warning,danger,info}` now carries
sub-tokens — `DEFAULT` (solid fill / on-white icon), `soft` (tinted bg, was `*-50`), `border`
(was `*-200`), `text` (accent text on a tint, was `*-700`), `hover` (solid-button hover) — because
the app consumes colored states as `bg-50` / `border-200` / `text-700` triads. `.text-feedback-*`
DEFAULT and `.text-brand` also get a `[data-theme="dark"]` foreground override so a fill-tuned
accent stays legible as text on the dark canvas.

**Priority is theme-reactive** (JS-driven inline styles can't theme via Tailwind): the ramp reads
`--priority-<slug>-bg/-text` from `index.css` and **inverts** in dark (bright urgent → faint
very-low) so "more urgent = louder against the canvas" holds without glare.

---

## 1. Color

### Brand (the only interactive accent — indigo)

| Token | Value | Use |
|---|---|---|
| `brand.DEFAULT` | indigo-600 (`#4F46E5`) | primary buttons, active tab, links |
| `brand.hover` | indigo-700 (`#4338CA`) | hover/pressed |
| `brand.soft` | indigo-50 (`#EEF2FF`) | subtle brand bg (selected tab, chips) |
| `brand.softText` | indigo-700 (`#4338CA`) | text on `brand.soft` (7.0:1 ✓) |
| `brand.ring` | indigo-400 (`#818CF8`) | focus ring |

> Replaces the inconsistent `blue-500`-vs-`blue-600` primary and separates the accent from
> the **call** session blue.

### Neutrals (the calm canvas)

| Token | Value | Use |
|---|---|---|
| `surface.base` | gray-50 (`#F9FAFB`) | app background (idle) |
| `surface.card` | white (`#FFFFFF`) | cards, sheets, rows |
| `surface.sunken` | gray-100 (`#F3F4F6`) | insets, secondary fills |
| `border.default` | gray-200 (`#E5E7EB`) | card/control borders, dividers |
| `text.strong` | gray-900 (`#111827`) | headings, primary numbers |
| `text.default` | gray-700 (`#374151`) | body |
| `text.muted` | gray-500 (`#6B7280`) | meta — **only on white** (4.83:1 ✓); never on a colored shell |

### Session colors (closed set — §4 of the design system)

Each session has a `shell` (full-screen bg), a `surface` (the running card), and an `accent`
(timer/icon/label). **All session-aware code reads this one map.**

| Session | `shell` | `surface` | `accent` | Label (LT) |
|---|---|---|---|---|
| `session.quickWork` | red-500 (`#EF4444`) | red-50 (`#FEF2F2`) | red-700 (`#B91C1C`) | "Greitas darbas" |
| `session.call` | blue-100 (`#DBEAFE`) | blue-50 (`#EFF6FF`) | blue-600 (`#2563EB`) | "Skambutis" |
| `session.break` | amber-100 (`#FEF3C7`) | amber-50 (`#FFFBEB`) | amber-700 (`#B45309`) | "Pertrauka" |
| `session.task` | green-200 (`#BBF7D0`) | green-100 (`#DCFCE7`) | green-700 (`#15803D`) | "Vyksta darbas" |

> **call** is `blue`, never `sky` — unify `CallTimer` onto this. Saturated red is **only**
> `session.quickWork`.
>
> **Accent contrast note:** the `quickWork` accent (`#B91C1C`) and `break` accent (`#B45309`)
> were darkened from red-600/amber-600 to red-700/amber-700 so the timer/icon/label text clears
> ≥4.5:1 against the session `surface` tint (WCAG 1.4.3).

### Achievement tiers (closed set — badges only, never the session shell)

Each tier is a calm `surface` (the badge medallion fill), an `accent` (icon + tier text), and a
metallic `ring` (the border that carries the metal identity). Every badge pairs the color with a
text tier label **and** 1–4 pips, so color is never the sole signal (§5). `silver` is a warm gray
and `platinum` a cool blue-slate, so the contrast-risk pair reads as two distinct hues.

| Tier | `surface` | `accent` (text/icon) | `ring` | Label (LT) | accent-on-surface |
|---|---|---|---|---|---|
| `tier.bronze` | `#F3E4D3` | `#7A4A21` | `#C28E5A` | "Bronza" | ~6.0:1 ✓ |
| `tier.silver` | `#E8EAED` | `#4B5563` | `#B6BCC4` | "Sidabras" | ~6.5:1 ✓ |
| `tier.gold` | `#FBEFC6` | `#8A6500` | `#DCBB4A` | "Auksas" | ~5.0:1 ✓ |
| `tier.platinum` | `#E6ECF2` | `#334155` | `#9FB2C6` | "Platina" | ~8.5:1 ✓ |

> Classes: `bg-tier-gold-surface`, `text-tier-gold-accent`, `ring-tier-gold-ring`. Rendered by the
> `<Badge>` primitive (trophy tile) and as inline `StatusPill` tier tones. Achievements are
> server-awarded only (a worker can write its own user doc) — stored in a `write:if false`
> subcollection, granted by a Cloud Function.

### Feedback (messages & validation — never decorative)

| Token | Value | Use |
|---|---|---|
| `feedback.success` | green-600 (`#16A34A`) | success text/icon (on white; on tint use green-700 for ≥4.5:1) |
| `feedback.warning` | amber-500 (`#F59E0B`) | warnings |
| `feedback.danger` | red-600 (`#DC2626`) | inline errors, destructive |
| `feedback.info` | indigo-600 (`#4F46E5`) | informational |
| `feedback.offline` | slate-800 (`#1E293B`) | **offline banner** (NOT red — must not collide with quick-work) |
| `feedback.scrim` | black @ 50% (`rgb(0 0 0 / 0.5)`) | the **one** modal backdrop opacity |

> Replaces six different scrim opacities (`/40 /50 /60 /70 /95`) and two syntaxes.

### Priority (grayscale ramp — keep, with the contrast fix)

Source: `src/utils/priority.js`. Keep the ramp; **fix the text color** so white never sits on
a light gray.

| Priority | bg | text | Note |
|---|---|---|---|
| URGENT | `#000000` | white | 21:1 ✓ |
| HIGH | `#666666` | white | 5.74:1 ✓ |
| **MEDIUM (default)** | `#A3A3A3` | **dark `#111111`** | **white was 2.52:1 FAIL → fixed; now uses dark** |
| LOW | `#E0E0E0` | dark `#111111` | ✓ |
| VERY_LOW | `#FAFAFA` | dark `#111111` | ✓ |

> Concretely: remove the explicit `textColor: '#FFFFFF'` on `MEDIUM` so
> `getContrastingTextColor` (which already returns dark for `#A3A3A3`) takes over; or raise the
> ramp so any white-text chip uses a bg ≤ `#767676`.

### Worker color fallback

| Token | Value | Use |
|---|---|---|
| `worker.fallback` | `brand.DEFAULT` (`#4F46E5`) | default worker color |

> Replaces the magic `#3b82f6` hardcoded in **9** places.

---

## 2. Typography

System stack; see `DESIGN_SYSTEM.md` §5. 12 px is the floor for content.

| Token | px / line-height | weight |
|---|---|---|
| `display` | 30 / 36 | 700 |
| `h1` | 24 / 32 | 700 |
| `h2` | 20 / 28 | 700 |
| `h3` | 18 / 24 | 600 |
| `body-lg` | 16 / 24 | 400–600 (form inputs) |
| `body` | 14 / 20 | 400–600 |
| `caption` | 12 / 16 | 500 (floor) |

Banned for content: `text-[8px]`, `text-[9px]`, `text-[10px]`, `text-[11px]`.

---

## 3. Spacing (4 px base — Tailwind default scale)

| Use | Token / value |
|---|---|
| Inline gap (chips, icon+label) | `2` (8 px) |
| Control padding (button) | `x-4 y-2.5` (min-h 44) |
| Card padding (mobile / desktop) | `4` (16) / `5`–`6` (20–24) |
| Section gap | `4` (16) |
| Modal body padding | `6` (24) |
| Bottom content clearance | `pb-navclear` (8rem) / `pb-navclear-lg` (9rem) — names the bottom-nav clearance; replaces raw `pb-32`/`pb-36` |

---

## 4. Radius (one per concept)

Semantic names that do **not** override Tailwind's default `rounded-sm/lg/xl` (so existing
markup keeps working during migration).

| Token | Value | Class | Use |
|---|---|---|---|
| `radius.input` | 6 px | `rounded-input` | inputs, small controls |
| `radius.control` | 8 px | `rounded-control` | buttons |
| `radius.card` | 12 px | `rounded-card` | cards, panels |
| `radius.modal` | 16 px | `rounded-modal` | modals, sheets |
| `radius.full` | 9999 px | `rounded-full` | pills, avatars |

> Retire `rounded-3xl`. Pick the concept's value; don't choose per file.

---

## 5. Elevation (shadow)

| Token | Use |
|---|---|
| `shadow.sm` | cards, rows |
| `shadow.md` | raised / hover |
| `shadow.lg` | floating work pill, popovers |
| `shadow.xl` | modals |

---

## 6. Z-index (managed ladder — replaces z-50…z-[10000] chaos)

| Token | Value | Layer |
|---|---|---|
| `z.base` | 0–10 | content |
| `z.header` | 20 | sticky header |
| `z.nav` | 30 | bottom nav + floating work pill |
| `z.backdrop` | 40 | modal backdrop |
| `z.modal` | 50 | modal/dialog |
| `z.toast` | 60 | toasts / transient alerts |
| `z.top` | 70 | image viewer / forced-acknowledge popups |

---

## 7. Motion

> Full rationale + where each effect is applied: [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md) §12.
> This table is the machine-facing catalog. The whole system lives in `src/index.css`
> (hand-rolled, **no animation dependency**) and is wired in `tailwind.config.js`
> (`transitionDuration: { fast, base, slow }`).

### Duration & easing

| Token / value | Use |
|---|---|
| `duration.fast` = 150 ms | quick feedback (press, toggle, hover color) |
| `duration.base` = 200 ms | default — entrances, state changes, most transitions |
| `duration.slow` = 300 ms | the whole-screen **shell color** crossfade |
| ease-out-expo `cubic-bezier(0.16, 1, 0.3, 1)` | all entrances + the completion pop (decelerate, no overshoot) |

**Banned curves:** bounce / elastic (`cubic-bezier` overshoots), and any `transition: all` /
`transition-*` on a **layout** property (width, height, top, left, margin). Animate only
`transform`, `opacity`, and (sparingly, one-shot) `box-shadow`. Use Tailwind's bare
`transition` utility (curated GPU-safe set) — not `transition-all`.

### Composable ENTER utilities (`src/index.css`)

`.animate-in` is the base (runs the `wz-enter` keyframe, 200 ms, ease-out-expo, `fill: both`).
Each modifier only sets one CSS variable, so they compose:

| Class | Effect |
|---|---|
| `animate-in` | required base; everything below is a no-op without it |
| `fade-in` | opacity 0 → 1 |
| `zoom-in-95` / `zoom-in` | scale 0.95 → 1 (both kept subtle; never a 0-scale pop) |
| `slide-in-from-top-2` / `-top-4` | translateY −0.5rem / −1rem → 0 |
| `slide-in-from-bottom-2` / `-bottom-4` | translateY +0.5rem / +1rem → 0 |
| `duration-150/200/300/500` | bridges Tailwind's `duration-*` onto the entrance duration |

> These class names mirror the `tailwindcss-animate` vocabulary the codebase already
> referenced (the plugin was never installed, so they were dead until defined locally).
> `duration-*` alone sets only `transition-duration`; the bridge classes also set
> `--wz-enter-duration` so `animate-in … duration-300` actually runs at 300 ms.
>
> The `-2` (0.5rem) reveals are the default; the `-4` (1rem) variants are reserved for larger
> sheet/dialog entrances (e.g. the WorkPlanner reason dialog), per DESIGN_SYSTEM §12.1.

### Purpose-built effects (`src/index.css`)

| Class | Motion | Lifetime | Applied to |
|---|---|---|---|
| `wz-pulse-soft` | opacity 1 → 0.6 → 1 (2.4 s) | **infinite** | the "alive" session indicator while a timer runs |
| `wz-pop` | scale 0.85 → 1 + fade (320 ms) | one-shot | the StatusPill at the moment a task completes |
| `wz-flash-success` | green `box-shadow` halo blooms + fades (1.1 s) | one-shot | the task card the moment it completes |
| `wz-shake` | translateX ≤ 4 px (400 ms) | one-shot | a validation-error alert when it appears |
| `wz-float` | translateY −5 px (4 s) | **infinite** | the EmptyState icon (idle breathing) |

**At most one infinite loop per visible region**, and it must stay barely-there.

### Reduced motion (mandatory gate — already in `src/index.css`)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; scroll-behavior: auto !important; }
}
```

Because this guard neutralises **every** animation above (each one's resting state is its
natural state), no call site needs a `motion-safe:` prefix — just use the class.

---

## 8. Active `tailwind.config.js` (`theme.extend`)

Wired per [ADR 0001](../adr/0001-visual-design-system.md) follow-up #1.

**Class-name keys are collision-safe** — they do not override Tailwind defaults or clash with
existing utilities (which is why text color is `ink`, border color is `line`, and radii use
semantic names instead of `sm/md/lg/xl`). Examples: `bg-brand`, `text-ink-muted`,
`border-line`, `bg-surface-base`, `bg-session-task-shell`, `rounded-card`, `min-h-touch`.

```js
// tailwind.config.js — theme.extend
extend: {
  colors: {
    brand:   { DEFAULT: '#4F46E5', hover: '#4338CA', soft: '#EEF2FF', ring: '#818CF8' },
    surface: { base: '#F9FAFB', card: '#FFFFFF', sunken: '#F3F4F6' },
    ink:     { strong: '#111827', DEFAULT: '#374151', muted: '#6B7280' }, // text-ink, -strong, -muted
    line:    '#E5E7EB',                                                   // border-line
    session: {
      quickWork: { shell: '#EF4444', surface: '#FEF2F2', accent: '#B91C1C' },
      call:      { shell: '#DBEAFE', surface: '#EFF6FF', accent: '#2563EB' },
      break:     { shell: '#FEF3C7', surface: '#FFFBEB', accent: '#B45309' },
      task:      { shell: '#BBF7D0', surface: '#DCFCE7', accent: '#15803D' },
    },
    tier: { // achievement badges — surface + AA accent text + metallic ring; never a session shell
      bronze:   { surface: '#F3E4D3', accent: '#7A4A21', ring: '#C28E5A' },
      silver:   { surface: '#E8EAED', accent: '#4B5563', ring: '#B6BCC4' },
      gold:     { surface: '#FBEFC6', accent: '#8A6500', ring: '#DCBB4A' },
      platinum: { surface: '#E6ECF2', accent: '#334155', ring: '#9FB2C6' },
    },
    feedback: { success: '#16A34A', warning: '#F59E0B', danger: '#DC2626', info: '#4F46E5', offline: '#1E293B', scrim: 'rgb(0 0 0 / 0.5)' },
  },
  fontSize: {
    caption: ['12px', '16px'], body: ['14px', '20px'], 'body-lg': ['16px', '24px'],
    h3: ['18px', '24px'], h2: ['20px', '28px'], h1: ['24px', '32px'], display: ['30px', '36px'],
  },
  // semantic radii — do NOT override Tailwind's default rounded-sm/lg/xl
  borderRadius: { input: '6px', control: '8px', card: '12px', modal: '16px' },
  zIndex: { header: '20', nav: '30', backdrop: '40', modal: '50', toast: '60', top: '70' },
  transitionDuration: { fast: '150', base: '200', slow: '300' },
  minHeight: { touch: '44px' }, minWidth: { touch: '44px' },
}
```
