# Accessibility audit — WCAG 2.1 AA, mobile-first

**Scope:** the whole Gildija PWA, phone viewports (320–430 px), both themes, browser and installed-PWA modes
**Standard:** WCAG 2.1 AA (plus the binding project rules in `docs/design/DESIGN_SYSTEM.md` §7/§11)
**Date:** 2026-07-31 · **Commit audited:** `4755b3a`
**Method:** live instrumented run of `npm run dev` at 320/360 px in Chromium, signed in with the dev
test account (ADR 0014), plus a static pass over `src/`. Every ratio below is a measured
computed-style value, not an estimate.

---

> **Remediation status (same day):** 14 of 15 findings are **fixed and re-verified live** — every
> one except **A11Y-05** (headings), which the founder chose to defer. One extra contrast failure
> found while verifying (A11Y-15) was fixed too. See [Remediation](#remediation) at the end.

## Summary

**Findings:** 15 · **Critical:** 0 · **Major:** 5 · **Minor:** 10

The app is in unusually good accessibility shape for the things automated tooling normally
catches. Across ten screens and every modal exercised, the instrumented sweep found **zero**
unnamed interactive controls, **zero** touch targets under 44 px, **zero** sub-12 px text, no
horizontal overflow at 320 px, and — outside the one badge defect below — **zero** contrast
failures in 1 200+ evaluated text nodes.

What is left is systemic rather than scattered. Four of the five Major findings are *one token
decision each*, repeated everywhere: the focus-ring colour, the tier-label colour, the bottom
clearance constant, and the absence of headings. Fixing four tokens/values closes most of the gap.

### Health by dimension

| Dimension | Verdict | Note |
|---|---|---|
| Colour contrast (text) | **Pass**, one exception | 1 202 nodes swept; only `Badge` tier label fails, dark only |
| Non-text contrast (focus) | **Fail** | Focus ring is invisible on selected tabs, and <3:1 app-wide in dark |
| Touch targets | **Pass** | 0 visible controls below 44×44 on any screen or modal |
| Accessible names | **Pass** | 0 unnamed controls, live sweep + static scan of 29 files |
| Keyboard operability | **Pass** with gaps | Every action reachable; ARIA patterns lack arrow keys |
| Structure / headings | **Fail** | Worker home, team list and Vartotojai have no headings at all |
| Reflow / zoom | **Pass** | No 2-D scrolling at 320 px; pinch-zoom not blocked |
| Motion | **Pass** | Global `prefers-reduced-motion` guard neutralises every animation |
| Installed-PWA specifics | **Fail** | Bottom clearance does not account for the home-indicator inset |

---

## Findings

### Perceivable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| A11Y-03 | Achievement **tier label** uses the tier accent colour directly on the themed card. Measured in dark: bronze **2.30:1**, silver **2.26:1**, gold **3.20:1**, platinum **1.65:1** (need 4.5:1). Light passes. | 1.4.3 Contrast | 🔴 Major | [`Badge.jsx:116`](../../../src/components/ui/Badge.jsx) — the tier accents are theme-invariant by design (`tokens.md` §1) and are only AA *on their own medallion surface*. Give `tierText` a themed token (or render the label on the medallion tint), keeping `medallion` as-is. |
| A11Y-02 | **Focus ring fails 3:1 in dark theme, app-wide.** `ring-brand` = `#4F46E5` measured **2.71:1** on `surface-card`, **2.32:1** on `surface-sunken`, **3.01:1** on `surface-base`. 181 occurrences of `focus-visible:ring-brand`; the `brand.ring` token — which *is* correctly brightened for dark (**8.56:1**) — is used **0 times**. | 1.4.11 Non-text Contrast | 🔴 Major | Route every focus ring through a dedicated token and fix its values: `--brand-ring` = indigo-600 in light (6.29:1), indigo-300 in dark (8.56:1). Note `tokens.md` currently documents `brand.ring` as indigo-400, which measures **2.98:1 in light** — using it as documented would itself fail, so the token needs updating, not just adopting. |
| A11Y-12 | `--tw-ring-offset-color` stays Tailwind's default `#fff` in dark mode. 73 `focus-visible:ring-offset-*` sites therefore paint a **white halo** around focused controls on the dark canvas. Only one site (`focus-visible:ring-offset-surface-card`) overrides it. | 1.4.11 / visual defect | 🟢 Minor | Set `--tw-ring-offset-color: rgb(var(--surface-card))` in the `[data-theme="dark"]` block of `src/index.css`, or standardise on `ring-offset-surface-card`. |
| A11Y-05 | **No heading structure on the primary screens.** Measured: worker home = **0** headings (the "Dienos tikslas" / "Savaitės tikslas" section titles are `<span>`), team task list = **0** headings across 1 202 text nodes and ~130 cards, Vartotojai = **0**. Ataskaitos renders **H3 before H2**. No page has an `<h1>` except ProfilePage. No skip link. | 1.3.1 Info and Relationships · 2.4.6 Headings and Labels | 🔴 Major | A VoiceOver/TalkBack user's heading rotor returns nothing on the app's most-used screen. Give each tab an `<h1>`, promote card/section titles to real headings, and fix the H3→H2 inversion in Reports. Landmarks (`banner`/`main`/`nav`) already exist, so a skip link is optional once headings land. |
| A11Y-14 | The service-worker offline document is hard-coded light (`background:#ffffff`), so a dark-mode user gets a full-white flash when the app fails to boot. | 1.4.8 (AAA) / consistency | 🟢 Minor | [`sw.js:42`](../../../src/sw.js) — add a `prefers-color-scheme: dark` block. |

### Operable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| A11Y-01 | **Focus indicator is completely invisible on every selected segmented tab.** The pattern `focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand` is applied to a control whose selected state is `bg-brand`. Measured live: selected tab background `rgb(79,70,229)` — byte-identical to the ring colour → **1:1**. With `outline-none` there is no fallback indicator. Affects **21 sites in 6 files**, i.e. every segmented tab strip in the app, in **both** themes. | 2.4.7 Focus Visible (**Level A**) · 1.4.11 | 🔴 Major | `ManagerView.jsx:324,342,360,392,409,426,739,753,767` · `Reports.jsx:556,570,584` · `UserProfileModal.jsx:512,527,542` · `TaskHistory.jsx:872,885` · `WorkPlanner.jsx:107,119` · `ManagerNotifications.jsx:932,958`. Switch the ring to `ring-white` on the selected state, or drop `ring-inset` and use an offset ring so it lands outside the fill. |
| A11Y-04 | **Bottom-dock clearance ignores `env(safe-area-inset-bottom)`.** Measured at 360 px: the fixed dock (bottom nav + floating work pill) occupies **150 px**; the content reserve is a constant **160 px** (`pb-navclear` 8 rem + `main`'s `pb-8`) → only 10 px of slack. The dock's own offset *does* add the inset (`bottom: calc(64px + env(...))`), the reserve does not. Simulating a 34 px home-indicator inset: dock grows to **184 px**, `main` overlaps the pill by **56 px**, of which **~24 px is real content**, and two content elements were measured intersecting the dock. | 2.4.11 Focus Not Obscured (WCAG **2.2**) · practical mobile defect | 🔴 Major | [`Layout.jsx:94`](../../../src/components/Layout.jsx), [`tailwind.config.js:148`](../../../tailwind.config.js), [`Modal.jsx:77`](../../../src/components/ui/Modal.jsx). Make the clearance `calc(8rem + env(safe-area-inset-bottom))` (and the `-lg` variant likewise), so the reserve tracks the dock it exists to clear. Hits the **installed PWA on iOS** hardest; also intermittent in iOS Safari as the toolbar auto-hides. |
| A11Y-07 | **ARIA patterns declared but not implemented.** Every `role="tablist"` (4 of them) and the `role="radiogroup"` theme picker put **all** children at `tabindex=0` with **no arrow-key handling and no roving tabindex** — a screen reader announces "tab, 1 of 6" but arrows do nothing. In `ManagerView` the tabs are also not direct children of the tablist (an `overflow-x-auto` div sits between), which breaks the required ownership relation. | 4.1.2 Name, Role, Value (expectation mismatch; not a hard AA failure — Tab still reaches every control) | 🟢 Minor | Add the APG keyboard pattern (arrows + Home/End, single tab stop) or move the tabs to be direct tablist children with `aria-owns`. `Select.jsx` and `DatePicker.jsx` already implement their patterns correctly and are good internal references. |
| A11Y-11 | The admin colour sliders are **8 px tall** (`h-2`), so the pointer/touch hit area of `<input type="range">` is 8 px on the cross axis even though the drawn thumb is 20 px. | 2.5.5 (AAA) · **binding DESIGN_SYSTEM §7 rule** | 🟢 Minor | [`UserManagement.jsx:632`](../../../src/components/UserManagement.jsx) — pad the input to a 44 px box and keep the 8 px track as a visual-only element. Admin-only surface, low reach. |
| A11Y-13 | No `scroll-margin-top` anywhere, under a 48 px `sticky` header (and, on team screens, a sticky sub-tab strip). Keyboard focus moving to an element near the fold can land underneath the header. | 2.4.11 (WCAG **2.2**) | 🟢 Minor | Add `scroll-mt-16` (or a `scroll-padding-top` on the scroll root) to focusable content containers. |
| A11Y-10 | Two remaining bare `vh` units in scroll caps: the mobile Select sheet's option list and the team calendar card. On mobile `vh` resolves to the URL-bar-hidden (largest) viewport, so the box can exceed what is actually visible. | 1.4.10 Reflow (risk) | 🟢 Minor | [`Select.jsx:210`](../../../src/components/ui/Select.jsx) `max-h-[60vh]`, [`AllUsersCalendar.jsx:226`](../../../src/components/AllUsersCalendar.jsx) `h-[70vh]` → `dvh`. In the Select case the parent Modal's `dvh` cap currently contains the damage, so this is consistency hardening rather than a live break. (`UserProfileModal` is already fixed — the `92vh` there is only in an explanatory comment.) |

### Understandable

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| A11Y-06 | **Drag-and-drop screen-reader text is English inside a `lang="lt"` document.** Measured `#DndDescribedBy-5` = *"To pick up a draggable item, press the space bar. While dragging, use the arrow keys…"*, wired via `aria-describedby` onto **all 132** draggable task cards; the live region emits English announcements during a drag. Three surfaces use dnd-kit defaults. | 3.1.2 Language of Parts | 🟢 Minor | Pass `accessibility={{ screenReaderInstructions, announcements }}` in Lithuanian to `DndContext` in `SortableTaskCardList.jsx`, `board/PriorityBoard.jsx` and `task/ChecklistEditorList.jsx`. |
| A11Y-08 | **Placeholder-as-label in the task form.** Every control in the create/edit modal is named only by `aria-label` with an identical `placeholder`; no persistent visible label, so the field's purpose disappears the moment it is filled. Separately, on a failed submit the error is a proper Lithuanian `role="alert"` ("Įveskite pavadinimą.") but the offending input gets **no `aria-invalid` and no `aria-describedby`**, and focus is not moved to it. | 3.3.2 Labels or Instructions · 3.3.1 Error Identification (partial) | 🟢 Minor | Screen-reader users are fine (the `aria-label` carries the name); sighted and cognitively-loaded users lose it. Add visible labels (or a float-label), and wire `aria-invalid` + `aria-describedby` to the alert. |

### Robust

| # | Issue | WCAG | Severity | Recommendation |
|---|---|---|---|---|
| A11Y-09 | `<tr role="button">` on the desktop worker-stats table overrides the row's `row` role, collapsing the table's grid semantics for screen readers. (The mobile `<li role="button">` sibling is correct.) | 1.3.1 Info and Relationships | 🟢 Minor | [`DailyStatistics.jsx:1510`](../../../src/components/DailyStatistics.jsx) — keep the `<tr>` semantic and put the button on a cell, or make the whole row a `<button>` inside the first cell. |

---

## Measured evidence

### Colour contrast

| Element | Foreground | Background | Ratio | Required | Pass |
|---|---|---|---|---|---|
| Body/meta text, both themes (1 202 nodes swept) | tokens | tokens | ≥4.83:1 | 4.5:1 | ✅ |
| Priority chip "Vidutinis" (dark) | `#FFFFFF` | `#6B7280` | 4.83:1 | 4.5:1 | ✅ |
| Tier label "Bronza" (dark) | `#7A4A21` | `#171C26` | **2.30:1** | 4.5:1 | ❌ |
| Tier label "Sidabras" (dark) | `#4B5563` | `#171C26` | **2.26:1** | 4.5:1 | ❌ |
| Tier label "Auksas" (dark) | `#8A6500` | `#171C26` | **3.20:1** | 4.5:1 | ❌ |
| Tier label "Platina" (dark) | `#334155` | `#171C26` | **1.65:1** | 4.5:1 | ❌ |
| Tier accent on its own medallion | tier accent | tier surface | 4.63–8.70:1 | 4.5:1 | ✅ |
| Focus ring on card (light) | `#4F46E5` | `#FFFFFF` | 6.29:1 | 3:1 | ✅ |
| Focus ring on card (dark) | `#4F46E5` | `#171C26` | **2.71:1** | 3:1 | ❌ |
| Focus ring on sunken (dark) | `#4F46E5` | `#222936` | **2.32:1** | 3:1 | ❌ |
| Focus ring on base (dark) | `#4F46E5` | `#0E1117` | 3.01:1 | 3:1 | ⚠️ borderline |
| Focus ring on **selected** tab (both themes) | `#4F46E5` | `#4F46E5` | **1.00:1** | 3:1 | ❌ |
| `brand.ring` token if adopted as-is (light) | `#818CF8` | `#FFFFFF` | **2.98:1** | 3:1 | ❌ |
| `brand.ring` token (dark) | `#A5B4FC` | `#171C26` | 8.56:1 | 3:1 | ✅ |

### Touch targets

Every visible interactive element was measured on ten screens plus five modals. **Zero** below
44×44 CSS px. Spot values: header controls 44×44, bottom-nav items 69×60, sub-tabs 44 tall,
task-form controls 44–50 tall, the 20 px "create as template" checkbox sits inside a **296×44**
`<label>`. The one exception is the admin colour slider (A11Y-11).

> Methodological note: an early pass read 42×42 for modal controls. That was an artifact — the
> preview renderer is occluded (`document.visibilityState === "hidden"`), so CSS animations never
> advance and the modal's `zoom-in-95` entrance stayed pinned at `scale(0.95)`. All measurements
> in this report were taken after force-finishing animations; the real value is 44×44.

### Keyboard

| Surface | Reachable | Activation | Escape | Arrows |
|---|---|---|---|---|
| Modals (shared `Modal` + `useModalA11y`) | ✅ focus moves in, restores on close | ✅ | ✅ + correct stacking | n/a |
| `Select` (mobile sheet) | ✅ | ✅ | ✅ | ✅ ↑↓ Home/End |
| `DatePicker` | ✅ | ✅ | ✅ | ✅ full grid |
| Photo viewer | ✅ | ✅ | ✅ | ✅ ←→ |
| Drag-to-reorder (3 surfaces) | ✅ `KeyboardSensor` present | ✅ Space | ✅ | ✅ — but instructions are in English (A11Y-06) |
| Calendar time-grid selection | drag-only, **but** "Pridėti rankiniu būdu" is an equivalent keyboard path | ✅ | — | — |
| Segmented tabs / theme radios | ✅ Tab reaches all | ✅ | — | ❌ no arrow support (A11Y-07) |

### Cross-browser and installed-PWA

| Item | State |
|---|---|
| Pinch-zoom | ✅ allowed — no `maximum-scale` / `user-scalable=no` (1.4.4 satisfied by zoom) |
| iOS focus-zoom on inputs | ✅ prevented — `:root input/textarea/select { font-size:16px }` under 640 px; measured 16 px on all modal inputs |
| Reflow at 320 px | ✅ no page-level horizontal scroll; the only overflow is the intentional sub-tab swipe strip |
| `viewport-fit=cover` + side insets | ✅ Layout pads left/right; nav pads all three |
| Bottom inset | ❌ A11Y-04 |
| Reduced motion | ✅ global guard neutralises all animations incl. the two infinite loops |
| Firefox/Gecko range thumb | ✅ both `::-webkit-slider-thumb` and `::-moz-range-thumb` defined |
| Sub-ES-module browsers | ✅ `nomodule` upgrade prompt, Lithuanian, adequate contrast |
| Manifest | ✅ `lang: lt`, `id`/`scope`/`start_url` pinned, maskable icons, standalone |
| Font scaling | ⚠️ type tokens are px, so iOS Dynamic Type / Android font-size settings have no effect; zoom is the only route |

---

## What was verified as passing

Recorded so a future sweep does not re-flag them: accessible names (0 unnamed controls across a
live sweep of ten screens and a static scan of 29 files); the shared dialog behaviour
(`useModalA11y` — focus in, focus restore only when the trigger still exists, Escape gated on
`dismissible`, Tab trap, module-level stack so only the topmost dialog reacts); `aria-modal` on
every dialog with a real `<h2>` or `aria-label` name; live regions for offline state, session
readout, form errors and toasts; colour never the sole signal (session pill = colour + icon +
label; tiers = colour + label + pips; deadline tone + self-describing text); the `.wz-on-shell`
fixed-colour rule for text riding on a session shell (all four shells measured clean);
`aria-current="page"` on nav; `aria-hidden` on every decorative icon; `role="radiogroup"` +
`aria-checked` on the theme picker.

---

## Suggested order of work

1. **A11Y-01** — one class change per selected-tab state; removes a Level-A failure in 21 places.
2. **A11Y-02 + A11Y-12** — fix `--brand-ring` in both themes, adopt it for `focus-visible:ring-*`,
   and theme the ring offset. One token pass, 181 call sites.
3. **A11Y-04** — add `env(safe-area-inset-bottom)` to the two clearance values.
4. **A11Y-03** — themed token for the tier label.
5. **A11Y-05** — headings on WorkerView, ManagerView and UserManagement; fix the Reports inversion.
6. Minors as capacity allows; **A11Y-06** is cheap and disproportionately improves the Lithuanian
   screen-reader experience.

---

## Remediation

Applied and re-measured in the same live harness the audit used. Every "after" number below is an
observed computed-style value, not a prediction.

| # | Fix | Evidence (after) |
|---|---|---|
| A11Y-01 | Ring colour moved out of the shared base string and into each branch: selected → `ring-white`, unselected → `ring-brand-ring`. 21 sites, 6 files. Branch-local so it resolves identically under plain `clsx` and under `cn`. | White ring on the brand fill = **6.29:1** (was 1.00:1). Verified on the live tab strip: selected carries `focus-visible:ring-white`, unselected `focus-visible:ring-brand-ring`. |
| A11Y-02 | `--brand-ring` re-valued (light indigo-600, dark indigo-300) and adopted by all **192** focus-indicator classes (`focus-visible:` / `focus-within:` / `focus:` / `has-[:focus-visible]:`). | Light **6.29 / 6.02 / 5.71:1**, dark **8.56 / 9.48 / 7.32:1** on card / base / sunken. All ≥3:1. |
| A11Y-12 | `--tw-ring-offset-color` themed for dark. | Dark offset now `rgb(23 28 38)` (surface-card), was `#fff`. Light unchanged. |
| A11Y-03 | New theme-reactive `tier.*.label` token; `Badge`'s caption uses it. Medallion untouched. | Live "Bronza" caption **5.94:1** (was 2.30:1). Tokens measure 5.3–10.4:1 light, 5.9–9.1:1 dark. |
| A11Y-04 | `navclear` / `navclear-lg` and the Modal cap now carry `env(safe-area-inset-bottom)`. | Emulating a 34 px home indicator: dock 184 px, reserve grows to 162 px, content **still clears by 11 px** and **0** elements intersect the dock (was a 56 px overlap with 2 clipped elements). |
| A11Y-05 | **Deferred by the founder.** Not addressed. | — |
| A11Y-06 | Lithuanian `screenReaderInstructions` + `announcements` in `src/utils/dndA11y.js`, wired into all 4 `DndContext`s; `a11yName` in each sortable's `data` so announcements say the task title, not a Firestore id. | Live `#DndDescribedBy` now reads *"Norėdami paimti elementą, paspauskite tarpo klavišą…"*. |
| A11Y-07 | New `useRovingFocus` hook (APG roving tabindex + arrows/Home/End with follow-focus activation) on 5 tablists and 7 radiogroups; `role="tablist"` moved onto the strip so the tabs are its own children. | Live: tabs are direct children; only the selected tab has `tabIndex=0` (five siblings at `-1`); a dispatched `ArrowRight` moved focus and selection from "Sąrašas" to "Laukia". Theme radios likewise. |
| A11Y-08 | Persistent `<label>` for the task title and description (placeholder keeps only the prompt); `aria-invalid` + `aria-describedby` on the title and focus moved to it on a failed submit. | Live after an empty submit: `aria-invalid="true"`, `aria-describedby="task-form-error"`, focus on the title, accessible name "Pavadinimas". |
| A11Y-09 | `role="button"` off the `<tr>`; the name cell carries a real `<button>`. Row keeps its mouse click. | Table row semantics restored; keyboard path is the cell button. |
| A11Y-10 | `Select` sheet cap and the team-calendar card → `dvh`. | — |
| A11Y-11 | Slider input stretched to a 44 px box over a separately-drawn 8 px track (native track/thumb pinned in `index.css`). | Live input box **280×44**, visible track still 8 px. |
| A11Y-13 | `html { scroll-padding-top: 7rem }`. | Computed `112px`. |
| A11Y-14 | Offline service-worker page follows `prefers-color-scheme` and uses `dvh`. | — |
| **A11Y-15** *(new — found while verifying)* | RGB slider labels used raw `text-red-600` / `text-green-600` / `text-blue-600`, measuring **3.53 / 3.30:1** on the dark card. Now the themed ink token; the channel is still named in words and re-stated by the coloured track. | Screen re-swept: **0** contrast failures. |

**Regression sweep after the fixes** — worker home and the ~130-card team list, both themes:
0 contrast failures across 1 180 evaluated text nodes, 0 targets under 44 px, 0 unnamed controls,
no horizontal overflow. `npm run lint` clean, `npm run build` succeeds, 1 185 tests pass.

**Not visually confirmed:** the colour slider's thumb centring (A11Y-11) is the one change whose
result is geometric rather than measurable from the DOM — the box and track sizes are verified, but
the browser pane was not compositing, so no screenshot could confirm the thumb sits on the track's
centre line. It follows the standard fixed-track-height + negative-thumb-margin recipe and is
worth one glance on the admin colour editor.

## Limitations

- Ratios, sizes and geometry are measured from live computed styles in Chromium at 320/360 px.
  **No physical iOS or Android device was tested.** A11Y-04's magnitude is derived from the CSS
  and confirmed by injecting the exact offsets `env(safe-area-inset-bottom)` would produce; the
  10 px-slack-at-zero-inset figure is directly measured.
- No screen-reader run (VoiceOver / NVDA / TalkBack). Findings about announcements are read from
  the accessibility tree and the actual DOM text, not from listening.
- Screenshots were unavailable — the preview pane was not compositing — so this audit is
  measurement-based rather than visual. The heading, contrast, target and geometry findings do not
  depend on that; purely aesthetic issues would not have been caught.
- Screens not exercised live: Auditas dashboard, Pridavimas/Istorija sub-tabs, recurring-tasks
  panel, the loud session states with a real running timer (the four session shells were instead
  applied to the live DOM and measured, which covers contrast but not session-specific content).
