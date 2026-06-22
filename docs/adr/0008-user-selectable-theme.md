# ADR 0008 — User-selectable light / dark theme

**Status:** Accepted · **Date:** 2026-06-23 · **Supersedes (in part):** the dark-mode deferral noted in [ADR 0001](./0001-visual-design-system.md)

## Context

[ADR 0001](./0001-visual-design-system.md) established the token system but **deferred dark
mode**, citing the "second session color problem": the product's signature is a loud
whole-screen session color (§4), and it was unclear how a dark canvas would coexist with those
saturated shells without either dimming the signal or breaking contrast.

The founder asked for a theme the user can switch from their profile. Re-examining the deferral:
the tension dissolves once we separate **the calm canvas** (which should invert with the theme)
from **the loud session state** (which is the identity and must stay loud regardless of theme).
The session shell is a *self-contained* surface — its contrast is judged against itself, not the
canvas — so it can stay theme-invariant while everything around it inverts.

The blocker was therefore mechanical, not conceptual: every color was a static hex baked into
`tailwind.config.js`, so nothing could swap at runtime.

## Decision

Ship a **3-state theme** — `Sistema` (follow the OS, default) · `Šviesi` · `Tamsi` — switchable
from the profile page.

1. **CSS-variable-backed tokens.** The calm-canvas/chrome token groups (`brand`, `surface`,
   `ink`, `line`, `feedback`) move to the `rgb(var(--x) / <alpha-value>)` channel form in
   `tailwind.config.js`. The light + dark channel values live in `src/index.css` under `:root`
   and `[data-theme="dark"]`. Because every component already consumes these as token classes,
   flipping one `data-theme` attribute on `<html>` re-paints the whole app — and Tailwind opacity
   utilities (`bg-surface-card/50`) keep working because of the channel form.

2. **Theme-invariant by design** (literal hex, no dark override): the **session** colors (the
   loud whole-screen shells — the product's identity), the achievement **tier** medallions
   (self-contained metallic tiles), the modal **scrim**, and the **loud time-warning / time-limit
   popups**. These stay vivid in both themes.

3. **Feedback gains a tint triad.** `feedback.{success,warning,danger,info}` each grow
   `soft` / `border` / `text` / `hover` sub-tokens, because the app consumes colored states as
   `bg-*-50` / `border-*-200` / `text-*-700` triads that a single solid hex could not model. The
   solid `DEFAULT` stays fill-safe (white text keeps AA in both themes); a small set of
   `[data-theme="dark"] .text-*` overrides lightens the *foreground* accent so the same token used
   as text stays legible on the dark canvas.

4. **The priority ramp is theme-reactive.** Its grayscale chips are JS-driven inline styles, so
   they cannot theme via Tailwind. The ramp now reads `--priority-<slug>-bg/-text` CSS variables;
   in dark it **inverts** (bright urgent → faint very-low) so "more urgent = louder against the
   canvas" still holds and no chip glares.

5. **Persistence + no flash.** A synchronous boot script in `index.html` sets `data-theme` from
   `localStorage` (resolving `system` via `matchMedia`) **before first paint**, so the dark canvas
   never flashes light. `ThemeProvider` (mounted **above** `AuthProvider`, so the theme is live
   pre-login and during the auth spinner) owns the runtime state and re-asserts the attribute.
   The choice persists to `localStorage` (offline / logged-out fallback) **and** to the Firestore
   user doc (`themePreference`) for cross-device sync; `ThemeSync` adopts the doc value inside the
   authed tree.

## Alternatives considered

- **Tailwind `dark:` variant (class strategy).** Rejected: would require a `dark:` prefix on
  hundreds of utilities across ~40 files — far more churn and a permanent two-class tax on every
  future component. The variable-backed-token approach themes existing token markup for free.
- **Dark-adapting the session shells.** Rejected: dimming the loud signal contradicts the §4
  identity and risks the validated on-shell contrast. Kept invariant instead.
- **Binary light/dark only.** Rejected in favor of including `Sistema` (OS-follow) as the default
  — the modern norm; respects the device with zero user action.
- **localStorage-only (no Firestore).** Rejected: the user explicitly wanted it on the profile,
  and cross-device sync matches the existing `notificationsEnabled` preference pattern.

## Consequences

- **No `firestore.rules` change.** The `users/{uid}` update rule has no field allow-list (it only
  freezes `role`/`isDisabled`/`teamManagerIds`/`scopedManager` for non-privileged callers), so the
  owner writing `themePreference` is already permitted — exactly like `notificationsEnabled`.
- **Light mode is unchanged** by construction: every token's light value equals the hex it
  replaced, and the raw-color → token migration was light-equivalent.
- A broad one-time **raw-color → token migration** across the components was required (the tokens
  only theme markup that *uses* them); raw palette utilities were the dark-mode gaps.
- The PWA `theme-color` meta now tracks the theme so the mobile status bar matches.

## Follow-ups

- Dark-adapting the achievement **tier** medallions is deliberately left invariant for now (a
  light medallion reads fine on a dark card); revisit if it looks off in practice.
- The image-viewer scrims (`bg-black/95`) remain outside theme scope (correct over a photo in any
  theme); the single-scrim cleanup from earlier reviews is still an open item.
- `firestore.rules` / Storage deploys are unaffected; **deploy stays human-initiated** (CLAUDE.md).
