<!--
COPY of the Work-Tools UX Standard. Do not edit here: the canonical copy lives in the
owner's Octopus repository (docs/ux-standard/work-tools-ux-standard.md). Changes arrive
as a separate refresh PR in this repository.
-->

> **Copy record (Gildija)**
>
> | Field | Value |
> |---|---|
> | Standard version and date copied | 1.0, copied 2026-10-26 (canonical commit `f9ca449`) |
> | Local exceptions | §10 "Gildija" below; plus the local binding design documents `docs/design/DESIGN_SYSTEM.md` and `docs/design/tokens.md` |
> | Precedence | `DESIGN_SYSTEM.md`, `tokens.md` and the protected contracts (the timer and the full-screen session view, `SESSION_COLORS`) win over this standard. A conflict is recorded as a proposed exception for the owner (§10), never resolved silently. |
> | Activation | Active for agents in this repository through the pointers in `CLAUDE.md` and `AGENTS.md` (step 2c). |
# Work-Tools UX Standard

| | |
|---|---|
| **Standard version** | 1.0 |
| **Date** | 2026-10-26 |
| **Status** | Approved by the owner 2026-10-26. Active for agents in the Octopus repository through the pointer in CLAUDE.md (step 2a). Copies in other repositories are activated with their own pointer when they are made. |
| **This part** | Common rules. Publication-safe: it may be copied into other repositories, public ones included. App-specific exceptions live in each app's local part. |
| **Colour reference** | Gildija colour file at commit `f70abbb` (2026-10-21), read 2026-10-24 (see Sources) |

Marker used in this standard:

- **OPEN** — the owner has not decided this item yet. The rule around it stands; the item is settled later by the owner.
- Two traces also appear. „(S#, decided 2026-10-26)“ marks a rule the owner decided. „Recommendation applied (not separately chosen)“ marks an item approved with the standard without its own choice. The decisions are listed at the end.

## How copies work

- **One canonical copy.** It lives in the Octopus repository: it is private, its changes are reviewed, it is the largest user, and the training app would start there. Every other repository holds a copy.
- **Every copy records three things at its top:**

  | Field | Example |
  |---|---|
  | Standard version and date copied | 1.0, 2026-10-26 |
  | Local exceptions | the list, or a pointer to the local exceptions section |
  | Precedence | the local binding design document and protected contracts (e.g. Gildija's timer) win over this standard |

- **Conflicts are recorded, never resolved silently.** When this standard and a local binding rule disagree, the agent follows the local rule and records the conflict as a proposed exception for the owner (§10); it is registered only once the owner approves.
- **Only the canonical copy is edited.** Other copies are refreshed by a separate PR in their own repository.
- **Timing.** Copies go to Gildija and to the Kostiumoteka staff system only in phase 2. The Gildija maintainer approved Gildija's inclusion (S5, decided 2026-10-26).

## Scope

| In scope: internal work tools | Out of scope |
|---|---|
| Octopus apps (five apps and the shared sign-in page) | Marketing sites. They have their own brand standards and share only the quality floor (§2). |
| Gildija | Medievalita and the VšĮ site: kept as business-card sites, quality floor only (S6, decided 2026-10-26) |
| Kostiumoteka staff system | Marketing call-to-action words (S4) belong to the brand standards |
| A future training app (§13) | |

The standard sets **behaviour and meaning, not pixels**: what red means, how "are you sure?" is asked, where the menu sits, which words name actions, and how connection and saving are reported. Each app stays recognisable by its own mark.

## 1. Principles and safeguards

1. **Same logic, own mark.** Buttons, words, menu position and colour meanings are shared. Each app keeps its own name, icon and established brand colour.
2. **Finger first.** Almost all overlap between these tools happens on phones and tablets: in workshops, at events, at the counter. Aligning desktop menus is low value for now.
3. **Gildija is the default reference.** Its users are trained (the worker guide „Meistro vadovas“ and a training video), so other apps move towards Gildija by default. This is a default direction, not blind copying. Where a Gildija habit itself causes a known problem (e.g. the double meaning of „Atšaukti“, S1), the owner decides.
4. **Guard by the cost of a mistake** (Gildija's rule), not by the shape of the control:

   | Cost of a mistake | Guard | Examples |
   |---|---|---|
   | Hard to undo | Confirmation first. It repeats the consequence in its own words. | deleting; crediting work time; confirming a money entry; changing access; a statement another person will rely on (e.g. „gavau 50,00 €“) |
   | Easily reversed, one tap | Done at once; the notice offers a quick undo („Atšaukti veiksmą“, §6). Only where the system truly has a reverse action. | Gildija: approving a task, snoozing a task |
   | Timer controls and small marks | No guard. A mistake is fixed by tapping again. | timer start / pause |

5. **Cancelling or voiding something that already happened** (a booking, an issued invoice, a confirmed money entry) is a separate action named for what it does („Atšaukti užsakymą“, „Anuliuoti sąskaitą“). It is never the quick undo of a notice.
6. **A window or sheet that already holds typed input does not close on an accidental tap beside it** (Gildija's rule). It closes only deliberately: with its back-out button (the word for its level, §6), the X, or Escape. A deliberate close drops the input without an extra question, as in Gildija. The standard does not require a discard-changes prompt.
7. **The standard does not change who may do what, or who approves what.**
8. **Small steps.** No large repaint at once, and visual changes are not mixed with logic changes. Every visual change is checked with before/after screenshots. A screenshot proves appearance only; behaviour (was it saved, where is focus, how does it recover) needs an observed run.

## 2. Quality floor

Applies to the work tools and to the marketing sites.

| Topic | Rule |
|---|---|
| Target | **WCAG 2.2 AA**, as a design target, not a legal conclusion. It contains all of 2.1 AA, so nothing is weakened. Documents that still say 2.1 are updated together with their copy of this standard. |
| Touch targets | Where operated by finger (phone, tablet): **at least 44 px**. This is our rule, stricter than AA. Everywhere else: **at least 24 px** (the AA floor). Dense desktop tables are allowed. An app's stricter rule wins (Gildija: 44 px everywhere). |
| Focus | Visible, and not hidden by a bottom bar or a sticky header. |
| Status messages | „Išsaugota“, errors and quick-undo notices are passed to screen readers, not only shown. |
| Quick undo | Reachable long enough, or the reverse action stays on the record itself (Gildija: „Priimti“ ↔ „Atnaujinti“). Reference: Gildija keeps undo 6 s by default (approving, accepting, snoozing) and 90 s after a worker finishes a task. (Gildija's current values, quoted for information; not a requirement.) |
| Sign-in fields | Pasting a password and using a password manager must work (WCAG 2.2 SC 3.3.8). |
| Phone inputs | Input text is 16 px on phones, so the phone does not zoom in. A comfort rule, not an accessibility check. |
| Motion | Reduced when the person asks for it. |
| Colour | Never the only signal: a word, icon or shape always accompanies it. Status badges always carry their word (§7). |
| Skip link | A „Pereiti prie turinio“ link exists. |
| Formats in internal tools | Money „1 234,50 €“; Lithuanian dates („2026-10-24“); Europe/Vilnius time; 24-hour clock. A registered language exception covers the interface language only: money, dates and times in such an app follow this row (S3, decided 2026-10-26). |
| Formats on public sites | Numbers and dates follow the page language. Currency and price follow the price zone, as today. |
| Date without time | A calendar day. It is never shifted by time zone. A timestamp is shown in Vilnius time. |

## 3. Colour — three layers

### 3.1 Layer 1 — brand accent (recognition, not meaning)

Used for the primary action, the active menu section and the focus ring.

| Apps | Accent | Values |
|---|---|---|
| Octopus apps, Gildija | indigo | fill #4F46E5, hover #4338CA, soft #EEF2FF, text on fill #FFFFFF; focus ring #4F46E5 (light) / #A5B4FC (dark) |
| Kostiumoteka staff system | deep green | #253C34, hover #38574B, text on fill #FFFFFF (from its public stylesheet; screens unseen); focus ring #253C34 under this rule (its current focus style was not seen) |

Brand colours are not part of the shared-role comparison.

### 3.2 Layer 2 — shared roles, the same everywhere

| Role | Meaning | Built as |
|---|---|---|
| Danger (red) | danger / error / negative ending („Atmesta“, „Anuliuota“) (S7, decided 2026-10-26) | colour family |
| Warning (amber) | attention / paused | colour family |
| Success (green) | in progress / succeeded | colour family |
| Info (indigo) | information | colour family. A separate role from the brand accent even where both are indigo; Gildija already keeps them apart. |
| Neutral | no longer relevant / closed | Gildija's grey surface, text and line tones. No family of its own. |

A **colour family** is: fill, fill hover, soft background, border, text, and dark-theme values. The reference values are Gildija's.

**Light theme**

| Role | Fill | Fill hover | Soft bg | Border | Text | Text on fill |
|---|---|---|---|---|---|---|
| Danger | #DC2626 | #B91C1C | #FEF2F2 | #FECACA | #B91C1C | #FFFFFF |
| Warning | #F59E0B | #D97706 | #FFFBEB | #FDE68A | #B45309 | none: no text on this fill |
| Success | #15803D | #166534 | #F0FDF4 | #BBF7D0 | #15803D | #FFFFFF |
| Info | #4F46E5 | #4338CA | #EEF2FF | #C7D2FE | #4338CA | #FFFFFF |

**Dark theme** (the fills are the same as in light, by design)

| Role | Fill | Fill hover | Soft bg | Border | Text | Text on fill |
|---|---|---|---|---|---|---|
| Danger | #DC2626 | #B91C1C | #3A1518 | #5A1F22 | #F87171 | #FFFFFF |
| Warning | #F59E0B | #D97706 | #2E2410 | #4A3A12 | #FBBF24 | none: no text on this fill |
| Success | #15803D | #166534 | #0E2A1A | #1B4D33 | #4ADE80 | #FFFFFF |
| Info | #4F46E5 | #4338CA | #1E1B4B | #312E81 | #A5B4FC | #FFFFFF |

**Neutral — grey tones**

| Tone | Light | Dark |
|---|---|---|
| Surface base | #F9FAFB | #0E1117 |
| Surface card | #FFFFFF | #171C26 |
| Surface sunken | #F3F4F6 | #222936 |
| Ink strong | #111827 | #F3F5F7 |
| Ink | #374151 | #C8CED7 |
| Ink muted | #4B5563 | #9AA3B2 |
| Line | #E5E7EB | #2F3846 |

Gildija builds its neutral badges from these: "neutral" = sunken surface + ink; "done" = sunken surface + muted ink. Muted ink is the gray-600 shade, not gray-500, because gray-500 measured 4.39:1 on the sunken surface.

**„Nėra interneto ryšio“ banner — slate**

| | Light | Dark |
|---|---|---|
| Banner fill | #1E293B | #334155 |
| Banner text | #FFFFFF | #FFFFFF |

Information only: not amber, not red. Gildija's design document gives only the light value; the dark value comes from its stylesheet.

### 3.3 Colour rules

1. **No white text on the amber fill.** It measures 2.15:1 and fails AA. Amber is shown as a soft background with dark amber text (#B45309 light / #FBBF24 dark), as in Gildija's status pills.
2. **Domain states keep their own words.** An app keeps its exact status word („Pateikta“, „Patvirtinta“, „Apmokėta“, „Renginys įvyko“) and maps it to one shared role (§7). Statuses are never merged into one „Baigta“.
3. **Connection colours.** „Nėra interneto ryšio“ is slate (information only). „Neišsaugota“, „Nežinoma, ar išsaugota“ and „Reikia prisijungti iš naujo“ are amber (attention).
4. **Count badges: one shared rule for all apps** — the brand fill with white text (Gildija's default; 6.29:1 on indigo), which follows each app's brand colour (decided 2026-10-26).
5. **A constructive primary action is never danger-coloured** („Išsaugoti“, „Sukurti užsakymą“). A red button appears only as the final button of a dangerous action inside a confirmation (e.g. „Atmesti kvietimą“).
6. **Brand close to a role.** Where the brand accent is close to a role colour (Kostiumoteka green to success green; indigo to info indigo), a button differs from a status or a notice by shape and word, not by hue alone. In a green-branded app the positive-confirm button („Priimti“, „Patvirtinti“) stays in the brand colour. There is no second, success-green button there.
7. **Positive-confirm button colour:** the brand colour, like the primary action (S8, decided 2026-10-26). Gildija's green confirm button stays a registered exception (§10) until it is changed in phase 2.
8. **Dark theme.** Fills are identical in both themes. Only the soft background, border and text change, and text uses the lighter shade.
9. **Thin margins.** Success and warning text on the light soft and base surfaces measure 4.79–4.84:1, and on the light sunken surface 4.56:1: a pass with no margin. Re-measure on any other tint.

## 4. Navigation

| Topic | Rule |
|---|---|
| Phone bottom bar | At most **5 positions, „Daugiau“ included** (e.g. 4 sections and „Daugiau“, or 5 sections without it). It respects the screen edges. |
| „Daugiau“ | Shown only when there are more sections than fit. Whether it opens as a sheet from the bottom or as a window in the middle of the screen is not fixed. |
| Labels | At least 12 px. |
| Which sections | Chosen by the role's most frequent jobs. Their order is fixed; the current section is always visible. The number and names of sections may differ by role; only the place and the behaviour are the same. |
| Back from a detail | Filters and search are kept. The scroll position is not promised: that would need code. |
| Action bars | Action bars (e.g. Gildija's timer bar or a save bar) are never put into the menu bar. |
| Desktop | For now two variants are allowed: a top row or a side menu. |

## 5. App identity

Every app has:

- a **Lithuanian name** in the header, in the browser tab and on the phone home screen;
- its own **mark**;
- its own **icon colour**.

Octopus app names: Expenses keeps its name „Expenses“ (S2, decided 2026-10-26; registered with its English interface in the Octopus part). The Lithuanian names of the other Octopus apps are OPEN (S2): the owner picks them later. Gildija meets this rule in the browser tab, on the home screen and in the desktop side rail; on a phone its header shows only the mark.

## 6. Lexicon

General rules:

- „Prisijungti“ is used only for the **account**. For the internet the word is **„ryšys“**.
- „Sesija“ is used only in Gildija's sense: **work time**.
- **A button always names the action.** A bare „Taip“ names nothing.

| Concept | Word (LT) | Rule | Status |
|---|---|---|---|
| Loading | „Kraunama…“ | Data is being loaded. Gildija mostly uses „Kraunama…“ for loading and „Įkeliama…“ for a file upload (one loading placeholder, the session list, still says „Įkeliama…“); the two stay apart. | Gildija default |
| Retry | „Bandyti dar kartą“ | Button after a failure. When the outcome is unknown, §8 state 4 applies instead. | Used by both systems |
| Approve | „Patvirtinti“ | Approving something (e.g. a time record, a money entry). | |
| Leave an unconfirmed step | „Grįžti“ | In a window or row, instead of „Atšaukti“ and „Ne“. | S1 |
| Close | „Uždaryti“ | Close a viewer, the result of a finished action, or the X. | S1 |
| Quick undo in a notice | „Atšaukti veiksmą“ | Undoes what was just done. Not „Grąžinti“: in Gildija that means returning a task to the worker. | S1 |
| Cancel a record | „Atšaukti <ką>“ | The booking or invitation stays in history as „Atšaukta“. | S1 |
| Void | „Anuliuoti <ką>“ | Irreversible. The document or entry stays as „Anuliuota“. | S1 |
| Delete | „Ištrinti <ką>“ | Nothing remains. | S1 |
| Remove a part of a record | „Pašalinti <ką>“ | Removes a part (e.g. a photo from a report); the record itself stays. As in Gildija. | S1 sub-question: recommendation applied (not separately chosen) |
| Reject | „Atmesti“ | Answering no to another person's invitation or request. | |
| Sign in again | „Reikia prisijungti iš naujo“ | The account sign-in has expired (§8). Never „Sesija baigėsi“. | |
| Required field | „(privaloma)“ | A word after the field label, as Gildija writes it. | Gildija default |
| Money | „1 234,50 €“ | As in the example: grouped thousands, decimal comma, two decimals, € after the number. | |
| Dates | „2026-10-24“ | The Lithuanian date format. A date without time is a calendar day (§2). | |
| Time | „14:30“ | Europe/Vilnius, 24-hour clock. | |

S1 (decided 2026-10-26): **one word per level, and the button always names the action.** Gildija changes its words only together with its training video and guide, in phase 2; until then its current use is a registered exception (§10).

## 7. Status vocabulary

- **Rule:** every status has an exact Lithuanian word and exactly one shared role (§3.2).
- The colour is fixed once per status word. It does not depend on whether someone still has to act; amber exists for that (S7, decided 2026-10-26).
- The standard gives the rule and a few examples, not a shared list. Each app builds its full status list in phase 2. Statuses shared between apps are set only together with the integration that needs them.

| Status word | Role | Note |
|---|---|---|
| „Pateikta“, „Patvirtinta“, „Apmokėta“, „Renginys įvyko“ | set by the app in phase 2 | the exact words stay |
| „Atmesta“, „Anuliuota“ | Danger | S7, decided 2026-10-26 |
| „Atšaukta“, „Nebegalioja“ | Neutral | S7, decided 2026-10-26 |

Reference, Gildija today: pending → amber soft; running → green soft; done → neutral (sunken surface and muted ink); info → indigo soft; danger → red soft.

## 8. Connection and save states

Five separate states, each with its own word:

| # | State (exact word) | When | The message must say | Colour |
|---|---|---|---|---|
| 1 | „Nėra interneto ryšio“ | the device is offline | what this app shows without a connection, and whether actions wait or are not sent. A section the app does not keep offline says so calmly — „Ši skiltis veikia tik su interneto ryšiu“ — and does not show a red server error. | slate |
| 2 | „Išsaugota telefone, laukia išsiuntimo“ | only where the app really stores the action on the device. Today only Gildija does; its „Neišsiųsta“ marker means exactly this state. | If the server later rejects a waiting action, a separate, clear notice that the person confirms after reading it (Gildija: „Kai kurie laikmačio veiksmai neįvyko“ with „Supratau“). | not set by the standard |
| 3 | „Neišsaugota“ (word decided 2026-10-26) | typed input exists only on the screen and is saved nowhere | what to do next. Not „Neišsiųsta“: in Gildija that word marks an entry already saved on the phone. | amber |
| 4 | „Nežinoma, ar išsaugota“ | no answer, or an unreadable answer | whether it is safe to try again, i.e. whether a duplicate could appear (templates below) | amber |
| 5 | „Reikia prisijungti iš naujo“ | the account sign-in has expired | whether unsent input will be lost. The app moves to sign-in only when the person taps. The word „sesija“ is not used. | amber |

**Two retry templates for state 4:**

| Template | Use | Text |
|---|---|---|
| A — safe to repeat | only on a form that is truly protected against duplicates (each app lists its protected forms in its local part) | „Spauskite dar kartą — dublikato nebus“ |
| B — check first | everywhere else | refresh and check first whether the record already appeared, e.g. „Serveris laiku neatsakė — veiksmas galėjo būti įvykdytas. Atnaujinkite puslapį ir patikrinkite prieš kartodami.“ |

General rules:

- **„Išsaugota“ is shown only after the server confirms**, never on the button press.
- **The standard adds no offline storage** to any app. It requires telling the truth about what the app does now.
- **The „Nėra interneto ryšio“ banner is mandatory** for apps used on a phone in the field: today Atlikėjai and Expenses (Octopus) and Gildija. Whether the Kostiumoteka staff system needs it is decided in phase 2, after seeing where and how it is used. Other apps report the connection in the error message.
- An app whose interface is in English uses the same five states in English (its local part).
- If an app cannot meet a state today, an agent proposes it as an exception under §10; the owner approves it.

## 9. Required elements — described as behaviour, not code

| Element | Required behaviour |
|---|---|
| Buttons | **Primary:** brand fill, the constructive main action. **Danger:** red fill with white text, only as the final button of a dangerous action in a confirmation. **Positive confirm:** brand colour (S8). **Back-out buttons** name their level („Grįžti“, „Uždaryti“; S1). Every button names its action. |
| Confirmation window or sheet | The body repeats the consequence in its own words. The final button names the action (§6). The safe choice backs out („Grįžti“, §6). A window holding typed input closes only deliberately (§1.6). A forced-acknowledge notice follows the app's local rule. Focus returns to what opened it (checked per §12). |
| Notice with quick undo | The action is already done. The notice offers the undo („Atšaukti veiksmą“, §6) for long enough (§2), is passed to screen readers, and appears only where a real reverse action exists. |
| Status badge | The exact status word on its role's soft background with the role's text colour. The word is always present (§7). |
| Empty, loading and error states | Loading says „Kraunama…“. An error says what failed and offers „Bandyti dar kartą“; when the outcome is unknown, state 4 of §8 applies. An empty state says there is nothing yet and, where the role can act, offers the one next action (Gildija's pattern). A section not kept offline says „Ši skiltis veikia tik su interneto ryšiu“. |
| Connection and save notices | The five states of §8, in the colours of §3.3. |

## 10. Registered exceptions

Allowed only for the app named. A registered exception is not a defect to fix on sight.

**Gildija**

The Gildija maintainer approved Gildija's inclusion (S5, decided 2026-10-26). Its copy of this standard still arrives only in phase 2 (How copies work). The exceptions below, except the reserved timer and full-screen session view, stay until they are changed in phase 2 together with its training material.

| Exception | Treatment |
|---|---|
| Timer and full-screen session view | Reserved, and not touched. The view is reserved, not its hues: Gildija's session colours coincide with its danger and success colours. Its behaviour came from incidents, tests are pinned to exact class names, and every merge goes live at once. |
| Offline banner „Jūs esate neprisijungęs. …“ | Stays until its words change in phase 2, together with the training material. (It uses „prisijungti“ for the internet.) |
| Timer error sentences „Prisijunkite prie interneto ir bandykite dar kartą.“ | Same conflict as the banner, and the banner's treatment — recommendation applied (not separately chosen). |
| „Atšaukti“ both closes a window and undoes in a notice | Stays until changed in phase 2 together with the training video and guide (S1). |
| Green positive-confirm button („Priimti“, „Patvirtinti“) | Stays until changed in phase 2 together with the training material (S8). |

Gildija notes, not exceptions:

| Note | Treatment |
|---|---|
| 44 px touch targets everywhere | Gildija's stricter rule wins over the 24 px floor (§2). |
| „Neišsiųsta“ marker | Means exactly §8 state 2. It is not the „Neišsaugota“ state. |
| WCAG 2.1 AA in its documents | Updated to 2.2 together with its copy of this standard (§2). |
| What it keeps offline | Actions on the phone (§8 state 2). |
| Amber fill #F59E0B as an icon colour (toast and notification icons) and once as text (a calendar label) on light surfaces, 2.15:1 | OPEN: a phase-2 check candidate for Gildija. |

**Kostiumoteka staff system**

| Exception | Treatment |
|---|---|
| Green brand accent | Stays. Not repainted to indigo. |
| Offline behaviour | Unverified. What it keeps offline is still to be checked; whether it needs the „Nėra interneto ryšio“ banner is decided in phase 2. |
| Colour values | Taken from the public stylesheet; the signed-in screens were not seen. |

**How a new exception is created**

1. An agent proposes it (e.g. when the bottom bar gets in the way of work), with the reason and a before/after image.
2. The owner approves it.
3. Without the owner's approval there is no exception.

## 11. „Kaip pradėti“ — one-page template

One page per app, in the same shape for every app, modelled on Gildija's worker guide („Meistro vadovas“):

| Section | Content |
|---|---|
| Install | how to add the app to the phone (only if the app supports it) |
| Sign in | how to sign in |
| Your sections | the main sections for this role |
| Colours | what the colours mean (§3.2) |
| Help | whom to call |

## 12. How agents use this standard

- **Only after activation.** Agents read only the agent-instruction files at the repository root; a design skill may also read a root product and design brief. Any other file is read only when those instructions point to it. A standard kept outside the repository is invisible to agents working elsewhere. Activation therefore means a pointer in each repository's agent instructions (every instruction file, where a repository has more than one), and that pointer states that this standard takes precedence over a design skill's general "make every project different" guidance. Until then a copy is recorded but not active. In the Octopus repository the standard is active: its pointer is in CLAUDE.md (step 2a).
- **New and changed screens only.** Existing screens are not changed because of this standard without a separate approval.
- **A conflict with a local rule is recorded as a proposed exception** (§10), never resolved silently; the owner approves it.
- **No existing screen has been checked against the quality floor yet.** When a screen is changed (phase 2), check:
  1. keyboard use and focus return;
  2. errors shown at the fields;
  3. enlarged text;
  4. real contrast in both themes.

## 13. Training app

If it is built, it is born in this standard, with the shared Octopus frame. No separate alignment project is needed. Its own work (registration, the trainer's and the trainee's paths, accessibility, onboarding) is still substantial.

## What this standard does not do

- **No large repaint at once.** Appearance changes are not mixed with logic changes.
- **No shared component library now.** It is technically possible but does not pay off yet: separate repositories with different owners and different tools (Vite 7 and 8, JavaScript and TypeScript, npm and pnpm).
- **Marketing sites are not unified.**
- **Gildija's timer and session view are not touched** (§10).
- **No move to Tailwind v4.** Gildija supports iOS 14; v4 needs Safari 16.4.
- **The Kostiumoteka staff system is not repainted to indigo.**
- **No offline storage is added,** and who approves what does not change.
- **No discard-changes prompt is required** when a window closes, and no sign-in code is changed. Either would be code work, decided separately.
- **No integration is implied.** Sign-ins and data stay separate. Gildija is a model of habits, not a shared entrance. There is no shared app launcher, and work is not handed from one app to another. Any link between apps says clearly which app it leads to.

## Contrast results

Method: WCAG 2.x relative luminance, (L1 + 0.05) / (L2 + 0.05), rounded to two decimals. AA asks 4.5:1 for normal text, 3:1 for large text and for non-text.

**Text on fills** (the fills are the same in both themes)

| Pair | Ratio | Result |
|---|---|---|
| White on brand / info fill #4F46E5 | 6.29 | pass |
| White on brand / info hover #4338CA | 7.90 | pass |
| White on success fill #15803D | 5.02 | pass |
| White on success hover #166534 | 7.13 | pass |
| White on danger fill #DC2626 | 4.83 | pass |
| White on danger hover #B91C1C | 6.47 | pass |
| White on offline banner #1E293B (light) / #334155 (dark) | 14.63 / 10.35 | pass |
| White on Kostiumoteka brand #253C34 / hover #38574B | 11.83 / 7.98 | pass |
| White on warning fill #F59E0B | 2.15 | FAIL — not used |
| White on warning hover #D97706 | 3.19 | FAIL for normal text — not used |
| Warning fill #F59E0B as an icon on white | 2.15 | FAIL (below 3:1) — still used by Gildija (toast and notification icons, one calendar label); see §10 |

**Role text** (light: soft / card / base; dark: soft / card / base)

| Role text | Light | Dark | Result |
|---|---|---|---|
| Success | 4.79 / 5.02 / 4.80 | 8.83 / 9.79 / 10.85 | pass (thin margin in light) |
| Warning | 4.84 / 5.02 / 4.81 | 9.14 / 10.22 / 11.32 | pass (thin margin in light) |
| Danger | 5.91 / 6.47 / 6.19 | 5.84 / 6.17 / 6.83 | pass |
| Info | 7.07 / 7.90 / 7.56 | 8.02 / 8.56 / 9.48 | pass |
| Success / warning on light sunken #F3F4F6 | 4.56 / 4.56 | — | pass (thin margin) |

**Neutral and brand** (light: card / base / sunken; dark: card / base / sunken)

| Pair | Light | Dark | Result |
|---|---|---|---|
| Ink strong | 17.74 / 16.98 / 16.12 | 15.62 / 17.29 / 13.36 | pass |
| Ink | 10.31 / 9.86 / 9.37 | 10.78 / 11.94 / 9.22 | pass |
| Ink muted | 7.56 / 7.23 / 6.87 | 6.71 / 7.43 / 5.74 | pass |
| Focus ring (card / sunken) | 6.29 / 5.71 | 8.56 / 7.32 | pass |
| Kostiumoteka focus ring #253C34 on #FFFEFA / #F5F3ED / #EDECE4 | 11.73 / 10.66 / 9.99 | — | pass |
| Brand text on brand soft | 5.62 (#4F46E5), 7.07 (#4338CA) | 8.02 (#A5B4FC) | pass |
| Brand link on card | 6.29 | — | pass |
| Line, dividers only | 1.24 | 1.44 | decorative: never text, never a control's only boundary |

## Owner decisions (2026-10-26)

| # | Question | Decision | Used in |
|---|---|---|---|
| Approval | Recording this standard | approved: the standard is recorded as documents. Activation for agents (2a) is a separate, later step | header, §12 |
| S1 | Words for backing out and cancelling | option A, one word per level: Grįžti (leave an unconfirmed step; replaces „Atšaukti“ and „Ne“) / Uždaryti (close a viewer, a finished result or the X) / Atšaukti veiksmą (quick undo in a notice) / Atšaukti <ką> (cancel a record; it stays as „Atšaukta“) / Anuliuoti <ką> (irreversible void; stays as „Anuliuota“) / Ištrinti <ką> (delete, nothing remains). The button always names the action. Gildija changes its words only together with its training video and guide. Sub-question: „Pašalinti <ką>“ stays for removing a part of a record, as in Gildija — recommendation applied (not separately chosen) | §1, §6, §9, §10 |
| S2 | Octopus app names | Expenses keeps its name „Expenses“. The rule that every app has a Lithuanian name stands; the Lithuanian names of the other Octopus apps are OPEN (the owner picks them later) | §5 |
| S3 | Expenses language, money and dates | the interface stays English; money „1 234,50 €“ everywhere, Expenses included; Expenses dates follow the other apps („2026-10-24“) | §2 |
| S5 | Including Gildija | included; the Gildija maintainer approved. Gildija's registered exceptions, except the reserved timer and session view, stay until they are changed in phase 2 together with its training material | How copies work, §10 |
| S6 | Medievalita and the VšĮ site | option A: kept as business-card sites, quality floor only | Scope |
| S7 | Colour of negative endings | option A: „Atmesta“, „Anuliuota“ red (the danger role means danger / error / negative ending); „Atšaukta“, „Nebegalioja“ neutral | §3.2, §7 |
| S8 | Positive-confirm button colour | option A: the brand colour, like the primary action; Gildija's green confirm button stays a registered exception until changed in phase 2 | §3.3, §9, §10 |
| — | Count-badge colour | the brand fill with white text, in every app | §3.3 |
| — | Word for typed input saved nowhere | „Neišsaugota“ | §8 |

**Applied with the approval, not separately chosen**

| Item | Rule applied | Used in |
|---|---|---|
| „Pašalinti <ką>“ (S1 sub-question) | kept for removing a part of a record | §6 |
| Gildija timer error sentences | an exception with the offline banner's treatment | §10 |

**Still open**

| Item | Used in |
|---|---|
| Lithuanian names of the other Octopus apps (S2) | §5 |
| Gildija's amber fill as icon / text colour: a phase-2 check | §10 |

S4 (call-to-action words for the marketing brands) is outside this standard. Its words go into the brand standards only together with the site-text change in phase 2.

## Sources

Gildija (public repository), commit `f70abbb` (2026-10-21); paths relative to its root:

- `src/index.css:155-265` (light tokens), `:267-358` (dark tokens), `:388-393` (dark text overrides), `:213` and `:312` (offline banner), `:177-182` (muted ink rationale)
- `tailwind.config.js:25-41`, `:94-134` (token wiring)
- `docs/design/tokens.md:46-68` (brand), `:73-83` (neutrals), `:144-153` (feedback, offline)
- `docs/design/DESIGN_SYSTEM.md:229-234` (backdrop rule for forms with typed input)
- `src/components/ui/Button.jsx:17-20` (text on fills); `src/components/ui/StatusPill.jsx:10-17` (status tones); `src/components/ui/Modal.jsx:124` („Uždaryti“ on the X)
- `src/context/ToastContext.jsx:28`, `src/components/ManagerNotifications.jsx:1479`, `src/components/CalendarChangeHistory.jsx:196` (amber fill as icon / text colour)
- `src/components/ui/ConfirmDialog.jsx:18`, `docs/design/DESIGN_SYSTEM.md:229-234` (default title, forced-acknowledge case); `docs/onboarding/` („Meistro vadovas“)
- `src/components/Layout.jsx:108-129` (offline banner and its texts)
- `src/components/TimerSyncNotice.jsx:63-68`, `:192-216`, `:237-258` (waiting and rejected-later notices)
- `src/components/WorkPlanner.jsx:1184`, `:1241-1247` („Neišsiųsta“)
- `src/hooks/useUndoableAction.js:50-54` (undo, 6 s); `src/components/taskTimerSafety.js:21` (90 s); `src/utils/taskActionVisibility.js:116-131` („Priimti“ ↔ „Atnaujinti“)
- `src/components/AppHeader.jsx:125-131`, `src/components/SideRail.jsx:97` (header mark, side-rail name); `src/components/TaskDetailsModals.jsx:425` („Įkeliama…“)
- `src/utils/formatters.js:32-70` (money, Vilnius time)

Kostiumoteka staff system: its public stylesheet, read 2026-10-24. The signed-in screens were not seen.

Octopus: private repository. Its evidence is listed in its local part, which is not copied.

Owner's phase-1 plan, revision 3, 2026-10-25, and the owner's decisions of 2026-10-26 (private, not copied). WCAG 2.2.
