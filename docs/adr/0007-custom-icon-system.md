# 0007 — Custom symbol / icon system

- **Date:** 2026-06-23
- **Status:** Accepted (rolling out in phases)
- **Supersedes / relates to:** extends [ADR 0001](./0001-visual-design-system.md) (visual design
  system); consumes the motion utilities from the 2026-06-22 motion-system decision.

## Context

WORKZ leans on borrowed `lucide-react` glyphs across ~54 files. A whole-app audit found three
recurring failures that cost orientation time for the two audiences the product is built for — a
**gloved field worker glancing at a phone in sunlight** and a **manager scanning a dense desktop
table**:

1. **Glyph collisions / overloads.** The same `History` icon marks both "Ataskaitos" and
   "Kom. ataskaitos"; `Users` means both the team calendar and "Vartotojai"; personal-vs-team is
   carried only by the Lithuanian "Kom." prefix.
2. **State carried by color alone or by text alone.** Six of seven task statuses had no glyph;
   "Vyksta" and "Patvirtinta" were near-identical greens; the priority mid-band is three adjacent
   grays indistinguishable in sun; the calendar change digest differentiates added/edited/cancelled
   only by a colored `+ / ~ / -` (a live WCAG 1.4.1 failure).
3. **One event wearing different glyphs on different surfaces** (bell vs toast vs OS push), because
   glyphs are hand-placed inline per component instead of sourced from one map.

## Decision

Build **one custom glyph system** — coherent pictogram families with a shared visual grammar —
that sharpens glanceability while staying inside the existing design system (the bold whole-screen
session color remains the only "loud" signal; every glyph is quiet and **always paired with its
Lithuanian text label**, never the sole signal).

**Drawing canon.** 24px grid; ~2px stroke (1.75px for smaller emblems) to sit alongside lucide
without a weight clash; rounded joins/caps; **monochrome `currentColor` by default** so a glyph
never introduces a new saturated color. Reserved color sets stay closed: saturated session
red/blue/amber/green mean only "a timer is live"; tier metals mean only "earned rank"; indigo =
brand; slate = offline.

**Grammar of modifiers — three orthogonal channels that never interfere:**

1. **WHICH** → a deliberately unique base **silhouette** (clipboard = tasks, grid = calendar,
   doc+bars = reports, …).
2. **WHOSE / scope** → one reusable **two-overlapping-heads "team" badge** in the corner, applied
   identically to every "Komanda" destination and nothing else. People-as-subject (Vartotojai) uses
   full-scale heads, never the corner badge.
3. **STATE / rank / severity** → a **countable or fill** channel, never color alone: lifecycle =
   interior fill grows; approval = a ring property; priority = a 1..4 bar meter; role = a 0/1/2
   chevron ladder; metric = a time-bar fill state.

**Source of truth.** Each family is one keyed map (mirroring `SESSION_COLORS`) under
`src/components/icons/`; all consumers read the map; no glyph is hand-placed twice. Glyph files stay
components-only and the maps live in sibling constants modules (React Fast Refresh).

### Founder scoping decisions (review, 2026-06-23)

The design was reviewed across four iterations; the binding outcomes:

- **Status circle** — *completed / awaiting confirmation* = thin green ring + green check;
  *confirmed* = green fill + white check; *running* = a green play wedge with **no enclosing ring**.
- **Sessions are NOT re-iconified** — quick-work / call / break / "Vyksta darbas" keep their current
  app glyphs and colors. (An earlier crossed-tools idea for "Vyksta darbas" was reverted.)
- **Calendar** — no "on-site / Dirbtuvėse" glyph at all: on-site is the default (no icon); only
  deviations (from-home, vacation) and change-deltas get a mark.
- **Recognition crests are dropped** — the existing badge glyphs and tier look are kept as-is.
- **Admin role insignia** = shield only (no chevrons).
- **Notifications** — *extended* and *declined* reuse the *time-up* hourglass at the same shape/size,
  adding only a small corner mark (green `+` / red `×`) and a color-filled interior.

### Phased rollout

- **Phase 0 — Foundations.** `src/components/icons/` kit + the shared modifiers + the
  one-map-per-family rule.
- **Phase 1 — Highest leverage (this change).** Status-circle family wired through the single
  `deriveTaskStatus`, and the priority signal-strength meter in `PriorityBadge`.
- **Phase 2 — Nav wayfinding + live WCAG fixes.** Nav base silhouettes + team badge; calendar
  change-delta glyphs.
- **Phase 3 — Notification + request consistency, role insignia.**
- **Phase 4 — Reports metric time-bar + empty-state spot-icons + connection feedback.**

## Alternatives considered

- **Keep swapping individual lucide glyphs.** Rejected: fixes a symptom at a time and re-creates
  drift; the wins (personal/team, status, priority) only become *learnable* as a system with shared
  modifiers.
- **A full bespoke brand icon font / asset pipeline.** Rejected as over-engineering for a PWA on weak
  connections; inline React SVG components driven by `currentColor` + Tailwind `fill-*/stroke-*`
  utilities need no build step and theme for free.
- **Iconify everything.** Explicitly rejected (see Consequences) — a glyph earns its place only when
  it fixes a verified collision, a color-only signal, or an icon-less surface.

## Consequences

- **Positive.** Status and priority become shape-readable on every surface for one wiring cost each
  (single `deriveTaskStatus` / single `PriorityBadge`); the worst look-alikes (running vs confirmed;
  three mid-band grays) are resolved; the system is additive and reduced-motion-safe; lint/build stay
  green.
- **Cost / risk.** Over-iconification is the main risk; guardrails: no glyph on a clearly-labelled
  control, no per-cell report glyphs, no merit glyph on every avatar; every meaningful glyph keeps its
  text label and clears 3:1 non-text contrast at its rendered size; sub-12px is allowed only for a
  decorative modifier riding on an already-labelled control.
- **No backend impact.** Pure client/presentation; no Firestore rules, indexes, or functions change.

## Follow-ups

- Phases 2–4 (nav, notifications/roles, reports/empty-states/connection).
- Verify thin-stroke glyphs on a 360px viewport in sunlight before each phase ships.
