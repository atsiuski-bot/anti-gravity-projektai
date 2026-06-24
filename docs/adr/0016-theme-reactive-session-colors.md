# ADR 0016 — Theme-reactive session colors (dark-mode tones)

- **Date:** 2026-06-24
- **Status:** Accepted
- **Supersedes:** the "session shells stay theme-INVARIANT" decision in [ADR 0008](./0008-user-selectable-theme.md) (for the four session colors only; tier medallions and the modal scrim remain invariant).

## Context

ADR 0008 introduced a user-selectable light/dark theme by splitting the **calm canvas** (which
inverts with the theme) from the **loud session color** (which it deliberately froze as the
product's identity). The four session colors were therefore kept as literal, theme-invariant hex:

| Session | Light shell |
|---|---|
| Quick work | red-500 `#EF4444` (saturated) |
| Call | blue-100 `#DBEAFE` (pale tint) |
| Break | amber-100 `#FEF3C7` (pale tint) |
| Task running | green-200 `#BBF7D0` (pale tint) |

Freezing the **hue** is correct — it is the identity. But freezing the **tone** is not: three of
the four shells are pale, high-luminance tints chosen to read on a *white* canvas. On the near-black
dark canvas (`#0E1117`) those same tints become bright, glaring full-screen washes that fight the
rest of the dark UI instead of belonging to it. The founder's report: the session colors "look very
ugly in dark mode."

The rest of the palette already solved exactly this problem. `brand`, `feedback`, and the priority
ramp are CSS-variable-backed and swap per `data-theme`; `feedback`/`brand` additionally decouple a
**fill** value (constant, white text rides on it) from a lightened **foreground-text** value via a
`[data-theme="dark"] .text-*` override. The session colors were the one family left out.

## Decision

Make the session colors **theme-reactive** using the same mechanism as `brand`/`feedback`:

1. **Variable-backed tokens.** Each session token (`shell`, `surface`, `accent`, `soft`) moves from
   literal hex in `tailwind.config.js` to `rgb(var(--session-<type>-<slot>) / <alpha-value>)`. The
   **light** channel values are byte-identical to the old hex — a behaviour-neutral migration for the
   light theme.

2. **Deep same-hue dark tones.** The dark block keeps the four hues but as deep `*-900` tones, so the
   loud whole-screen shell still reads unmistakably as red / blue / amber / green without glaring:

   | Session | Dark shell | Dark surface | Dark soft (border) |
   |---|---|---|---|
   | Quick work | red-900 `#7F1D1D` | `#3A1518` | `#5A1F22` |
   | Call | blue-900 `#1E3A8A` | `#15233D` | `#1E3A66` |
   | Break | amber-900 `#78350F` | `#3A2C0C` | `#5A4413` |
   | Task running | green-900 `#14532D` | `#102A1A` | `#1B4D33` |

3. **Fill-vs-foreground split for `accent`.** `accent` is used both as a fill (white text rides on it
   — toggle buttons, progress bars) and as foreground text (timer/icon/label). Its token value is
   **unchanged** across themes (so the fills keep passing), and only `accent`-as-text lightens to the
   `*-400` shade via `[data-theme="dark"] .text-session-*-accent` overrides — exactly the pattern
   already used for `.text-feedback-*` and `.text-brand`.

4. **On-shell text goes white in dark.** All four dark shells are deep tones, so on-shell text
   (`.wz-on-shell`) is forced white in dark regardless of shell kind, overriding the light-theme rule
   that paints dark text on the (light-mode) pale shells. White on every dark shell clears ≥7:1.

## Alternatives considered

- **Keep the shells invariant (status quo).** Rejected — it is the reported defect; pale tints on a
  black canvas glare.
- **Dim the whole shell with an opacity overlay in dark.** Rejected — muddies the hue, weakens the
  "loud state" identity, and interacts badly with the cards layered above.
- **A single mid-tone per hue for both themes.** Rejected — a tone that reads on white is wrong on
  black and vice-versa; the canvas-relative tone is the whole point.

## Consequences

- The dark theme's session shells now belong to the dark palette while staying recognizable; every
  session-aware surface (full-screen shell, `AppHeader` pill, `ActiveSessionReadout`, the running
  task card, the four timers, stat bars) themes automatically because they all read the one map.
- ADR 0008's blanket "session colors are theme-invariant" statement is narrowed: the **hue** is the
  invariant identity; the **tone** follows the canvas. Tier medallions and `feedback.scrim` remain
  fully theme-invariant.
- **No `firestore.rules`, functions, or index change** — purely client styling. No deploy required;
  ships via the normal Cloudflare push-to-main.
- Docs updated: `tokens.md` (dark session table), `DESIGN_SYSTEM.md` §4 rule E, and the inline
  comments in `tailwind.config.js` / `src/index.css` / `src/utils/sessionColors.js`.
