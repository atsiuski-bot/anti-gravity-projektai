# ADR 0001: Visual design system & tokens

- **Date**: 2026-06-20
- **Status**: Accepted
- **Decision-maker**: Founder (Karol)
- **AI assistant during decision**: claude-opus-4-8

## Context

WORKZ is a mobile-first PWA for work-time tracking (workers + managers). A whole-app design
critique (June 2026) found the product **functionally mature but visually inconsistent**, with
problems that repeat on every screen because there is **no design-system infrastructure**:
`tailwind.config` `theme.extend` is empty, so every color, font size, radius, and z-index is a
hardcoded utility string copy-pasted per component ("consistent by discipline, not by
construction").

Systemic findings driving this ADR:
- ~150 uses of sub-12 px text (`text-[8–11px]`) for **real data**, unreadable for field
  workers outdoors.
- Pervasive touch targets under 44 px (`p-1.5` ~28 px icon buttons, `p-0.5` ~20 px arrows).
- Desktop tables shoved onto phones with horizontal scroll instead of mobile cards.
- Color semantics clash: saturated red = "quick work" (red usually means stop/error), the
  offline banner reuses that same red, and the "call" state is `blue` in some places and
  `sky` in others.
- ~10 hand-rolled modal shells, ~14 duplicated primary buttons, 4 different "cancel" looks,
  six scrim opacities, an unmanaged z-index ladder (`z-50`…`z-[10000]`), and the magic
  `#3b82f6` hardcoded in 9 places.
- English leakage and the legacy "Viduramžiai.LT" brand mixed into a Lithuanian UI.

The product is also expanding beyond its original "Viduramžiai.LT" framing into a standalone
tool named **WORKZ**.

## Alternatives considered

### Visual direction
- **Tame / mute the signature whole-screen color system** — ❌ rejected. The founder wants to
  **keep the bold, full-saturation color shell** as the product's identity and best
  arm's-length signal. Accessibility is reconciled by *adding* persistent text labels, not by
  reducing saturation.
- **Replace whole-screen color with a subtle accent strip** — ❌ rejected for the same reason.

### Density
- **Uniformly mobile-first everywhere** / **dense data everywhere** — ❌ rejected in favor of
  **dual density**: workers get spacious mobile-first cards; managers may get denser tables on
  wide screens. Each audience gets the layout that fits its context and device.

### Accessibility posture
- **AA as a soft goal** / **basic hygiene only** — ❌ rejected. **WCAG 2.1 AA is a mandatory
  gate.** This is what stops the 9 px / 28 px problems from returning, and it is what makes the
  bold color system safe (color never the sole signal).

### Theme / typography
- **Dark mode now** — deferred; light-only first (a second theme means a second session-color
  set). **Web font** — rejected; the **system font stack** keeps the PWA light on weak field
  connections.

## Decision

Adopt a token-driven design system, documented in
[`docs/design/DESIGN_SYSTEM.md`](../design/DESIGN_SYSTEM.md) and
[`docs/design/tokens.md`](../design/tokens.md).

**Ratified parameters:**
- **Identity:** "calm canvas, loud state." Keep the saturated whole-screen session colors;
  pair every state with a **persistent text label + icon** and a single `SESSION_COLORS`
  source of truth. Saturated red is reserved for quick-work; the offline banner moves to a
  neutral slate.
- **Brand:** name is **WORKZ** only ("Viduramžiai.LT" retired everywhere). Accent color is
  **indigo** (distinct from the call-state blue). Typographic wordmark; no logo asset yet.
- **Typography:** system font stack; type scale with a **hard 12 px floor** for content.
- **Accessibility:** **WCAG 2.1 AA mandatory** — ≥12 px text, ≥44 px targets, ≥4.5:1 contrast,
  visible focus, reduced-motion support, accessible names.
- **Density:** dual; responsive by CSS breakpoint; phones get cards, not scrolling tables.
- **Components:** a canonical set — `Button`, `IconButton`, `Card`, `Modal`, `ConfirmDialog`,
  `StatusPill`, `EmptyState`, `Loading`. `window.confirm`/`alert` banned in UI flows.
- **Gestures:** keep swipe / double-tap as power shortcuts **but** add a visible affordance and
  require confirmation on irreversible/silent ones.
- **Copy:** Lithuanian, formal "Jūs"; no English leakage; never render raw `err.message`.
- **Tokens:** color / type / spacing / radius / shadow / z-index live in `tokens.md` and will
  be wired into `tailwind.config.js theme.extend`.

## Consequences

### Positive
- The same fix applies once and propagates (fixing tokens fixes dozens of screens).
- The bold identity is preserved *and* becomes accessible.
- New screens start from a consistent kit instead of re-deriving styles.
- Any agent has an unambiguous, testable rule set.

### Negative / risks
- A real migration cost: ~150 text-size sites, dozens of buttons/modals/tables to refactor.
- Until the Tailwind config is wired, components and tokens can drift; the doc leads, the code
  lags.
- Dual density requires discipline to not let manager-table density leak into worker views.

### Mitigation
- Migrate in priority order (see follow-ups), not in one big bang.
- Add the token block to `tailwind.config.js` early so new code can consume token names.
- Encode the AA gate into review (the checklist in `DESIGN_SYSTEM.md` §11).

## Follow-ups (implementation roadmap, priority order)

1. **Foundations:** wire `tokens.md` into `tailwind.config.js`; add the `prefers-reduced-motion`
   block to `index.css`; ship `IconButton` + the 12 px floor.
2. **Tables → mobile cards** for `UserManagement`, `Reports`, `TaskHistory`, `MonthlyHours`,
   calendar history; drive card/table off `md:`.
3. **Calendar mobilization:** `day` default on phones; horizontal event text with time.
4. **Primary-action hierarchy** in task card + modals; visible gesture affordances + confirms.
5. **Copy pass:** Lithuanian everywhere (Login, ErrorBoundary, InstallPrompt); friendly error
   mapping; no raw `err.message`.
6. **Component extraction:** `Modal`, `Button`, `Card`, `ConfirmDialog`, `StatusPill`,
   `EmptyState`/`Loading`; unify scrim, radius, z-index; `SESSION_COLORS`; replace `#3b82f6`.
7. **Color fixes:** priority `MEDIUM` contrast; offline banner → slate; `sky`→`blue` for call.
