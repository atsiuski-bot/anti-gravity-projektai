# WORKZ — Design System

> The single source of truth for how WORKZ looks, feels, and behaves.
> Any agent or contributor changing the UI **must** conform to this document and to
> [`tokens.md`](./tokens.md). Decisions here are ratified in
> [ADR 0001](../adr/0001-visual-design-system.md).

**Status:** Active · **Last decided:** 2026-06-20 · **Owner:** Founder (Karol)

---

## 0. Reading order

1. This file — principles, visual language, components, accessibility, copy.
2. [`tokens.md`](./tokens.md) — the machine-facing token tables + the
   `tailwind.config.js` block that implements them (now wired and active).
3. [ADR 0001](../adr/0001-visual-design-system.md) — why these choices were made.

When this document and the current code disagree, **this document wins** and the code
is the thing to fix. The codebase today (June 2026) predates this system; treat existing
hardcoded values as legacy to be migrated, not as precedent.

---

## 1. Product context (design it for these people)

- **Workers** — blue-collar / field staff, often older, frequently **outdoors in bright
  light, sometimes wearing gloves, on a phone with a flaky connection.** They live on the
  phone. Their loop is: *see my tasks → start work → stop / finish.* Speed and legibility
  beat density.
- **Managers / admins** — oversight: who is working, approvals, reports, user management.
  Often on a **desktop or wide screen**, tolerant of denser data.

**One sentence to hold in your head:** *a calm, quiet tool with one loud, meaningful signal.*

---

## 2. Design principles

1. **Calm canvas, loud state.** The interface is neutral and quiet by default. The **one**
   place WORKZ shouts is the whole-screen session color (see §4). Everything else —
   typography, chrome, controls — stays out of the way.
2. **Legible before dense.** Field legibility is non-negotiable. We never trade the
   12 px floor (§5) or the 44 px touch target (§7) for fitting more on screen. Managers may
   get *more* density on wide screens, never *less* legibility.
3. **One way to do a thing.** A button, a card, a modal, a status pill, an empty state —
   each has exactly one canonical component (§8). No re-inventing shells per screen.
4. **Tokens, not magic numbers.** Every color, size, radius, and z-index comes from
   [`tokens.md`](./tokens.md). A raw hex or an arbitrary `text-[9px]` in a component is a bug.
5. **Color is never the only signal.** Because state is encoded in color (§4), every
   stateful surface also carries **text and/or an icon** (WCAG 1.4.1).
6. **Accessibility is a gate, not a nicety.** WCAG 2.1 **AA is mandatory** (§7). A change
   that regresses contrast, target size, focus, or text size is not "done".

---

## 3. Brand

- **Name:** **WORKZ.** This is the only product name. The legacy "Viduramžiai.LT" name has
  been retired — it must not appear in code, titles, manifests, comments, or copy. If you
  find it, remove it.
- **Wordmark:** a typographic wordmark set in the system font, weight 800, tight tracking:
  **`WORKZ`**. No separate logo asset is required yet; a dedicated logo is a future task.
- **Where it shows:** the login screen (today it has no brand at all), the PWA manifest /
  install prompt, and the document title.
- **Accent color:** **indigo** (`brand` token, §tokens). Deliberately *not* blue, because
  blue is the "call" session state (§4) — keeping the brand accent distinct from a session
  color prevents users from reading a button as a state.

---

## 4. The signature: whole-screen session color

WORKZ's defining trait is that **the entire app background changes color to reflect the
active session.** We are **keeping this bold, full-saturation system** — it is the product's
identity and its best glanceable signal from arm's length. We are **not** muting it.

| Session | Shell background | Meaning | **Required text label** |
|---|---|---|---|
| Quick work | saturated red (`session.quickWork`) | unplanned work running | **"Greitas darbas"** |
| Call | light blue (`session.call`) | phone call running | **"Skambutis"** |
| Break | light amber (`session.break`) | on a break | **"Pertrauka"** |
| Task running | light green (`session.task`) | a task timer is running | **"Vyksta darbas"** |
| (none) | white / `surface.base` | idle | — |

**Rules that make the bold system safe and coherent:**

- **A) Always pair color with a persistent text label + icon.** The colored shell alone is
  not enough (color-blindness, sunlight). A small, legible label naming the state must be
  visible while the state is active. This is how we keep the saturated palette *and* pass AA.
- **B) One source of truth.** The shell background, the timer pill, and the running task
  card all read the **same** `SESSION_COLORS` token map. They must never drift (today the
  call state is `blue` in some places and `sky` in others — that is a bug to fix).
- **C) Saturated red is reserved for the quick-work state.** Do **not** reuse full-saturation
  red for anything else. In particular the **offline banner must not be red** (it currently
  is, and collides with quick-work) — it uses a neutral dark slate (`feedback.offline`) with
  a wifi-off icon.
- **D) Content rides on cards, not bare color.** Body text and controls sit on white
  `surface` cards layered above the colored shell, so text contrast is judged against the
  card, not the saturated background. Any text placed *directly* on a colored shell must meet
  §7 contrast or be moved onto a chip/card.

---

## 5. Typography

**Font:** the **system font stack** (no web-font download). Fast first paint, native feel,
lighter PWA — all of which matter on a weak field connection.

```
-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif
```

**Type scale** (names map to tokens; **12 px is the hard floor for anything a user reads**):

| Token | Size / line | Weight | Use |
|---|---|---|---|
| `display` | 30 / 36 | 700 | hero metric (e.g. month total hours) |
| `h1` | 24 / 32 | 700 | screen / big number |
| `h2` | 20 / 28 | 700 | dialog title, card section title |
| `h3` | 18 / 24 | 600 | sub-section |
| `body-lg` | 16 / 24 | 400–600 | **all form inputs** (prevents iOS zoom-on-focus) |
| `body` | 14 / 20 | 400–600 | default body, list rows |
| `caption` | 12 / 16 | 500 | meta, pills, secondary labels — **the floor** |

**Hard rules:**
- **No `text-[8px]/[9px]/[10px]/[11px]` for content.** They are banned. The ~150 existing
  uses are legacy debt to migrate up. Sub-12 px is permitted *only* for purely decorative
  glyphs that carry no information — and even then, avoid it.
- Primary figures users come to read (hours, timers, spent/planned time) are `body` or
  larger, never `caption`.
- The live timer readout — the most important glanceable number — is **at least `body-lg`**.

---

## 6. Color & elevation (summary; exact values in `tokens.md`)

- **Neutrals** carry the calm canvas: `surface.base` (app bg), `surface.card` (white),
  `border.default`, and a text ramp (`text.strong` / `text.default` / `text.muted`).
- **Brand (indigo)** is the *only* interactive accent: primary buttons, links, active tab,
  focus rings.
- **Session colors** (§4) are a closed set, used *only* for session state.
- **Feedback** colors (success / warning / danger / info / offline) are for messages and
  validation, never decorative.
- **Priority** uses a grayscale ramp (existing). **Fix required:** the default `MEDIUM`
  chip is white-on-`#A3A3A3` = **2.52:1 (fails)**. Rule: any priority background lighter than
  ~`#767676` uses **dark** text. Concretely, drop the explicit white `textColor` on `MEDIUM`
  (and any light-gray priority) so the contrast helper picks dark text.

**Elevation:** one shadow scale (`sm` cards → `md` raised → `lg`/`xl` modals & the floating
work pill). **Radius:** one value per concept — inputs `sm`, buttons & pills `md`/full,
cards `lg`, modals/sheets `xl`. `rounded-3xl` is retired.

**Z-index** is a managed ladder (no more `z-[9999]`): content `0–10` → sticky header `20`
→ bottom nav & work pill `30` → modal backdrop `40` → modal `50` → toast `60` → image
viewer / topmost `70`.

---

## 7. Accessibility — WCAG 2.1 AA (mandatory gate)

Every UI change is held to these. CI/review should reject regressions.

- **Text size:** ≥ 12 px for any readable content; ≥ 14 px for primary content (§5).
- **Touch targets:** **≥ 44 × 44 px** hit area for every interactive control. The icon may be
  drawn smaller; the *tappable* area is ≥ 44. Use the `IconButton` component (§8) which
  enforces this. Today's `p-1.5` (~28 px) icon buttons and `p-0.5` (~20 px) reorder arrows
  are violations.
- **Contrast:** ≥ 4.5:1 for normal text, ≥ 3:1 for large text (≥ 18.66 px bold / 24 px) and
  for meaningful UI/graphics. Known fails to fix: priority `MEDIUM` chip (2.52:1), 8 px
  comment timestamp `gray-400` (2.54:1), `gray-500` meta on the green/amber shells.
- **Focus:** every interactive element has a **visible focus ring** (`focus-visible:ring`,
  brand color). Nav tabs, timer buttons, logout, and icon buttons currently have none.
- **Color is never the sole signal** (§4-A): pair with text/icon.
- **Motion:** honor `prefers-reduced-motion`. `index.css` includes a reduce-motion media query
  that neutralises every animation (animation/transition duration → ~0). The full motion system
  — what to animate, with which utility, and where — is **§12**.
- **Accessible names:** icon-only buttons need an accessible name (`aria-label` or `sr-only`
  text), not just `title=` (which does not work on touch).
- **Language:** `<html lang="lt">`; never render raw `err.message`; no English leakage in
  user-facing copy (§10).

---

## 8. Components (the canonical set)

These are the only approved building blocks. Build them once; consume them everywhere.
Each replaces a cluster of today's copy-pasted variants (see
[ADR 0001](../adr/0001-visual-design-system.md) for the migration list).

### `Button`
- **Variants:** `primary` (brand-filled), `secondary` (neutral outline/soft), `danger`
  (red-filled), `ghost` (text-only).
- **Sizes:** `md` (default, min-h 44), `lg` (primary mobile CTAs, near-full-width).
- **Rule:** the primary action is always visually dominant. Never render the primary action
  at the same size/weight as a destructive or secondary action beside it (today
  `Pradėti` == `Užbaigti`, and `Išsaugoti` is shrunk under a template button — both wrong).

### `IconButton`
- Icon-only control with a **guaranteed ≥ 44 px** hit area and a required `aria-label`.
- Replaces all `p-1.5`/`p-0.5` icon buttons.

### `Card` / `Panel`
- `surface.card` bg, `radius.lg`, `shadow.sm`, `border.default`. The one wrapper for every
  panel. Replaces the `rounded-lg`-vs-`rounded-xl` split across summary/stat/table files.

### `Modal` / `Dialog`
- One shell: backdrop (`z.backdrop`, scrim `feedback.scrim`), centered card (`radius.xl`),
  standard padding, a `≥44px` close `IconButton`, `role="dialog"` + `aria-modal` +
  `aria-labelledby`, focus moved to the primary action on open, backdrop-tap to dismiss for
  non-destructive dialogs, `Escape` to close. Replaces ~10 hand-rolled modal scaffolds.
- **Presentation rule (binding):** the scrim dims the **whole** viewport and the dialog is a
  content-sized card **centred over it** — including on phones, where a pop-up must appear
  centred over the full screen, **never anchored to a trigger, corner or some fixed spot**.
  The card keeps its natural size (capped at `max-h-[90vh]`, body scrolls); it is *not*
  stretched edge-to-edge. This is the single rule for **all** pop-ups; route new overlays
  through `Modal` rather than hand-rolling a `fixed inset-0` scrim.
- Two escape hatches keep specialised pop-ups on the same shell instead of forking it:
  `bare` (caller supplies its own full-bleed chrome — e.g. the coloured time-warning /
  time-limit headers — laid out as `flex-shrink-0` header, `flex-1 overflow-y-auto` body,
  `flex-shrink-0` footer) and `level="top"` (raise above any other open modal, for the forced
  time-limit alarm). The amber `TaskTimeWarningPopup` and red `TaskTimeLimitPopup` use both.

### `ConfirmDialog`
- The **only** way to confirm a destructive/consequential action. **`window.confirm` /
  `window.alert` are banned** in UI flows. Mirrors today's good `DeleteConfirmationModal`:
  full-width stacked buttons, color-coded intent, explicit irreversibility warning.

### `Select` / `Dropdown`
- The **one** single-choice control — replaces every native `<select>`. A native select is
  drawn by the browser at a width and position we cannot control, and its first row cannot be
  kept from echoing the field label, so it fails all three of our pop-up rules. Import
  [`Select`](../../src/components/ui/Select.jsx); **never** ship a raw `<select>` or hand-roll
  an anchored options menu.
- **Two presentations, one behaviour** (the same rule as `Modal` / `InfoPopover`):
  - **Anchored panel** — on a normal page the options open in a panel **exactly the width of
    the trigger**, directly beneath it. This is the default and the preferred form.
  - **Centred full-screen sheet** — when the trigger lives inside a scrollable modal or table
    where an anchored panel would clip (pass `alwaysSheet`), or on a phone (`<640px`,
    automatic), the options open as a centred sheet through the canonical `Modal` (with
    `level="top"` so it stacks correctly above a parent dialog). This is the *"if anchoring is
    impossible, show it full-screen"* fallback — never a cramped box clipped by its container.
- **The category name is a heading, never an option.** The field label rides on the trigger and
  the panel header (`label`); the trigger shows the current choice or a `placeholder` prompt.
  The list holds **real choices only** — a "Visi…" reset is a real choice, but a disabled row
  that merely repeats the field name (`<option disabled>Šablonai</option>`) is banned.
- **Accessible listbox** (§7): `aria-haspopup="listbox"`, `aria-activedescendant`, full keyboard
  (↑/↓/Home/End/Enter/Esc), ≥44px option targets, a visible focus ring, and focus restored to
  the trigger on close.
- **Filter rows** lay their triggers out in a responsive grid: on a phone the classifiers pack
  two-per-row (e.g. Komandos darbai — `[Vykdytojas | Rūšiavimas]` over `[Prioritetas | Žyma]`),
  collapsing to one inline row from `lg+`.

### `StatusPill` / `Badge`
- One pill: `radius.full`, `caption` text, consistent padding. **Color-coded by state**
  (pending / running / done / waiting), not a single neutral gray for everything. Status
  labels are short (`Pradėtas`, not a sentence).

### `EmptyState` and `Loading`
- `EmptyState`: icon + one line of what's there + one **actionable** next step (e.g.
  "Užduočių dar nėra — paspauskite *Sukurti* arba pradėkite *Greitą darbą*").
- `Loading`: one consistent treatment (skeleton rows for tables, spinner for blocks). No more
  bare "Kraunami duomenys..." strings duplicated per screen.

### `DatePicker`
- The **only** way to pick a date. **Native `<input type="date">` is banned** in UI flows:
  its drop-down calendar renders month/weekday names in the *browser's* UI language, not the
  page's, so on an English-language browser every date field showed English months regardless
  of `lang="lt"`. `DatePicker` draws the whole calendar through `date-fns` + the `lt` locale,
  so months are always Lithuanian on every machine.
- Monday-first grid (Lithuanian convention), `yyyy-MM-dd` value contract (drop-in for the
  native input), `min`/`max` to disable out-of-range days, ≥44 px day targets, full keyboard
  navigation (arrows / Home·End / PageUp·PageDown / Enter / Escape), roving tabindex, a
  `dialog`-role popover dismissed on outside-click or `Escape`.

### Session controls (timers)
- The primary work action has the strongest resting affordance; Call/Break are secondary.
- Idle compact timers keep their fixed-height placeholder (good, prevents layout jump) but
  are labeled by function, not a transparent `00:00`.

---

## 9. Layout, navigation & density

- **Dual density (responsive):** workers get a **mobile-first, spacious, card-based**
  layout with 44 px targets. Managers may get **denser tables on `md+` / desktop**. Drive the
  card-vs-table choice off a **CSS breakpoint (`md:`)**, never a JS width flag, and **never
  show a dense data table to `role="worker"` on a touch device** — workers get cards.
- **Tables → cards on phones.** `UserManagement`, the multi-user `Reports` tables,
  `TaskHistory`, `MonthlyHours`, and the calendar-history table must each have a mobile card
  fallback (the pattern `DailyStatistics` already uses). Horizontal-scrolling tables on a
  phone are a violation.
- **Bottom navigation:** the manager bar must not cram 7 tabs at 9 px on a phone. Reduce to
  **≤ 5 primary destinations + a "Daugiau" overflow sheet**, labels ≥ 11–12 px, each target
  ≥ 44 px wide without horizontal scroll. Consider a personal/team segmented control.
- **The two stacked bottom bars** (work pill + tab bar) must: (a) include
  `env(safe-area-inset-bottom)` so they move together on notched phones, (b) keep a visible
  gap, and (c) reserve content padding from a **shared nav-height token**, not the hand-tuned
  `pb-32`/`pb-36` magic numbers. Prefer merging into one docked surface.

---

## 10. Voice & UX copy

- **Language:** Lithuanian, **formal "Jūs"** (consistent with existing copy). Plain,
  concrete words for non-technical field workers. No dev jargon in the UI — retire
  "(Active Sessions)", "(Timestamp)", "Timeline", "(D+P)" without explanation.
- **No English in the UI.** Translate the login screen, `ErrorBoundary`, `InstallPrompt`,
  and the logout label. The one allowed exception is the literal "Google" brand in
  "Prisijungti su Google".
- **Errors are human, never raw.** Map known error codes (e.g. `auth/popup-blocked`,
  network) to friendly Lithuanian sentences. **Never render `err.message`.** Default:
  "Nepavyko… Bandykite dar kartą."
- **Dates/numbers:** Lithuanian locale (`lt`). Use `format(date, 'MMMM d', { locale: lt })`
  + "d." (gives "birželio 20 d."), not the `do` token (which emits the English "20th").
  Tabular times use a fixed-width `HH:MM` so right-aligned columns line up.

---

## 11. How to apply this (checklist for any UI change)

- [ ] Every color/size/radius/z-index comes from a token, not a literal.
- [ ] No text below 12 px; primary figures ≥ 14 px.
- [ ] Every interactive control ≥ 44 px and has a visible focus ring + accessible name.
- [ ] Any stateful color is paired with text/icon.
- [ ] Destructive/confirm flows use `ConfirmDialog`, not `window.confirm`/`alert`.
- [ ] On a phone, data is cards — not a horizontally-scrolling table.
- [ ] Copy is Lithuanian, formal "Jūs", no raw error text, no English leakage.
- [ ] Reused the canonical component (§8) instead of a new bespoke shell.
- [ ] Single-choice controls use `Select` (§8), never a raw `<select>` or a hand-rolled menu;
  the field/category label is the panel heading, not the first option.
- [ ] Motion (if any) uses a §12 utility, animates only `transform`/`opacity`, and is covered by
  the reduced-motion guard. No bounce/elastic, no animated layout properties, no new ambient loop
  where one already exists in that region.

---

## 12. Motion

> The catalog of class names, durations and easings lives in
> [`tokens.md`](./tokens.md) §7. This section is the **why and the where**. The whole system is
> hand-rolled in `src/index.css` — **no animation library** — so timings track the motion tokens
> and stay under our control.

### 12.1 Principles

1. **Calm canvas, loud state — in motion too.** Motion is quiet by default and exists to
   *convey state* (feedback, reveal, transition, "alive"), never to decorate. If an animation
   doesn't help the user understand what just happened or where to look, it doesn't belong.
2. **Product register: short and out of the way.** 150–250 ms on virtually everything; the one
   slower beat is the 300 ms whole-screen shell crossfade (§4). No page-load choreography —
   workers are mid-task and won't wait for a show.
3. **Subtle over showy.** Small distances (0.5rem slides for inline reveals, up to 1rem for
   sheet/dialog entrances; 0.95 scales), gentle opacity. A field worker in bright sun should
   *feel* the response, not be distracted by it.
4. **GPU-only.** Animate `transform` and `opacity` (and, one-shot, `box-shadow`). **Never**
   animate layout properties (width, height, top, left, margin) — they cause reflow and jank on
   low-end phones. Use the bare `transition` utility, not `transition-all`.
5. **Ease out, never bounce.** All entrances and the completion pop use ease-out-expo
   (`cubic-bezier(0.16, 1, 0.3, 1)`). Bounce/elastic curves are banned (they draw attention to
   the animation itself).
6. **Reduced motion is a gate, not a setting.** The `prefers-reduced-motion` guard in
   `index.css` zeroes every animation here; because each effect's resting state is its natural
   state, nothing breaks when it's disabled. Never add motion that hides information with no
   static equivalent — color is still never the sole signal (§5).

### 12.2 The four layers (where motion is applied)

**A. Signature / emotional moments** — the few places the tool should *feel* responsive:

- **Session change.** The whole-screen shell crossfades (300 ms); the session label (`Layout`)
  re-keys and slides in with it, and its icon carries a soft `wz-pulse-soft` "alive" breath.
  The floating live-time pill (`ActiveSessionReadout`) slides in and pulses the same way.
- **Task completion.** The single celebration in the app: the card flashes a soft green halo
  (`wz-flash-success`) and the StatusPill pops (`wz-pop`) to a green check — once, only on a
  live not-done → done transition (never when a finished card mounts in history). No confetti;
  this is a work tool.

**B. Feedback** — acknowledge an action:

- **Press.** `Button` / `IconButton` scale down slightly on `:active`.
- **Modal / sheet entry.** The canonical `Modal` fades its scrim and settles the card
  (`fade-in zoom-in-95`); this covers every dialog and the bottom-nav "Daugiau" sheet.
- **Toasts & inline alerts.** Slide in from the top (`animate-in fade-in slide-in-from-top-2`).
- **Validation error.** A one-shot `wz-shake` points the eye at the failed field/alert.

**C. State reveal** — smooth an otherwise abrupt change:

- **Lists.** Cards ease up on mount (`fade-in slide-in-from-bottom-2`); the wrapper is keyed so a
  reused card never re-plays (only a genuinely new/filtered-in card animates).
- **Accordions / expanders.** Revealed content fades + slides (`slide-in-from-top-2`) — we
  animate opacity/transform, **not** height. Used across the summaries (`MonthlyHours`,
  `CombinedHoursSummary`, `ActiveWorkSessions`) and the `Reports` day/period expanders.
- **Status changes.** `StatusPill` tweens its tone color (`transition-colors`).

**D. Ambient** — the only *looping* motion, kept barely perceptible:

- **"Alive" pulse** (`wz-pulse-soft`) on the active-session indicator while a timer runs.
- **Idle float** (`wz-float`) on EmptyState icons so a dead-end screen breathes.
- **Rule: at most one ambient loop per visible region**, and always low-amplitude.

### 12.3 Adding new motion

- Reach for an existing §12 / `tokens.md` §7 utility before inventing a keyframe. New keyframes
  go in `src/index.css` (so the reduced-motion guard and token timings apply), never inline.
- Match the layer: entrance → `animate-in …`; press → `:active` scale; reveal → `fade-in
  slide-in-from-*`; one-shot acknowledgement → a `wz-*` one-shot. Don't add an ambient loop to a
  region that already has one.
- On a table, animate an inner `div`, not `<tr>`/`<td>` (cross-browser transform is unreliable).
- Verify on a ~360 px viewport **and** with "reduce motion" enabled before declaring done.
