# WORKZ — Design Tokens

> The canonical, machine-facing values behind [`DESIGN_SYSTEM.md`](./DESIGN_SYSTEM.md).
> These are the **source of truth**. The end state is that `tailwind.config.js`
> `theme.extend` implements this table and components reference token names — not raw
> Tailwind utilities with arbitrary values.

**Status:** Active — wired in `tailwind.config.js` · See [ADR 0001](../adr/0001-visual-design-system.md).

Values are expressed as Tailwind palette references where possible (so the migration is
mechanical) with the resolved hex in parentheses.

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

| Token | Value |
|---|---|
| `duration.fast` | 150 ms |
| `duration.base` | 200 ms |
| `duration.slow` | 300 ms (shell color transition) |

`index.css` must add:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
```

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
