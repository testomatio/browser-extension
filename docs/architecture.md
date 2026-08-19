# Architecture — the map before your first change

Chrome MV3 side-panel extension for running Testomat.io **manual runs** next to
the site under test. This file describes the code as it ships in this
repository.

Companion docs — read across, they are not repeated here:

| Doc | What it is for |
|---|---|
| [`docs/user-guide.md`](user-guide.md) | The tester-facing guide: what every button does and where the limits are. Read it once — it is the fastest way to learn the product. |
| [`PRIVACY.md`](../PRIVACY.md) | What the extension collects, where it goes, and every off switch. |

---

## 0. Ground rules that shape everything

1. **Zero build.** No bundler, no npm dependency, no compile step. `extension/`
   runs exactly as it is checked in. Third-party code is vendored as committed
   single files under `extension/vendor/` (`showdown.min.js`, `overtype.min.js`).
2. **The module system is `<script>` tags.** Every panel/editor file is a
   classic script: no ES modules, no namespacing. Each file wraps its innards
   in an IIFE and assigns **one global** (`TestomatAPI`, `SiteTab`,
   `SiteAccess`, `CaptureAnnotate`, `HtmlSanitize`, `TestomatParams`,
   `PriorityIcons`, `Annotate`,
   `OfflineQueue`, `Onboarding`), or — for the screen files — declares bare
   top-level `function`s into one shared scope. **Load order is the dependency
   graph.** See *Rakes*, §9.
3. **Single egress, no exceptions.** At runtime the extension talks only to the
   configured Testomat instance. No CDN, no analytics, no other host. The one
   exception this file used to record — the opt-in AI step polish to
   `api.anthropic.com` — is gone: the polish that exists today (#23) asks the
   configured instance's own `/prompts` endpoint, so the rule is absolute again.
   A change that would add a third-party host is not a normal change: it
   needs the maintainers' agreement first.
4. **No invented endpoints.** Every API call is verified against the product's
   own source and curl-smoked before any UI code depends on it.

---

## 1. Module map

Four JavaScript realms. They share files but **not** memory — everything
crossing a realm boundary goes through `chrome.runtime` messages or
`chrome.storage`.

```
              ┌──────────────────────────── service worker ───────────────────────────┐
              │ extension/background.js                                               │
 toolbar ───► │   action.onClicked  → sidePanel.open                                  │
  click       │   captureTab        → captureShot (captureVisibleTab | debugger)      │
              │   STEPREC_*         → step-recorder state in storage.session          │
              │ importScripts: shared/site-tab.js, evidence/recorder.js               │
              │   evidence/recorder.js → EVIDENCE_* + the chrome.webRequest backbone  │
              └───────────▲─────────────────────────────────▲────────────────────────┘
                          │ runtime messages                │ executeScript / register
      ┌───────────────────┴───────────────┐   ┌─────────────┴──────────────────────┐
      │ side panel (sidepanel/index.html) │   │ injected into the tab under test   │
      │   core/   state, storage, views,  │   │   content/step-recorder.js         │
      │           env-info               │   │   overlay/annotate-overlay.js      │
      │   screens/ runs-list, run-view,   │   │     + shared/annotate-core.js      │
      │           test-view, tc-studio,   │   │   evidence/relay.js     ISOLATED   │
      │           evidence, attachments,  │   │   evidence/page-hook.js   MAIN     │
      │           hotkeys, livesync,      │   └────────────────────────────────────┘
      │           offline-queue,          │
      │           onboarding, settings    │
      │   app.js  (loaded LAST)           │   ┌────────────────────────────────────┐
      └───────────────────────────────────┘   │ test page (editor/editor.html)     │
                          │                   │   ?test= view | ?suite= create     │
                          │                   │   ?annotate=<key> → annotate.js    │
                          │                   └────────────────────────────────────┘
                          └──── shared/ (loaded by BOTH panel and editor) ──────────┘
```

### 1.1 Service worker — `extension/background.js` (485 lines)

Owns three unrelated things, because all three need a context that outlives the
panel:

- **Panel behavior**, and WHICH SURFACE the click opens. The
  remembered choice lives in `chrome.storage.local.viewMode`
  (`shared/view-mode.js`) and is mirrored onto
  `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick})` — the one piece
  of this state Chrome holds across the worker sleeping, which matters because
  `sidePanel.open()` may only be called before the first `await` and a worker
  woken BY the click cannot have read storage yet. So side-panel mode is served
  by Chrome itself and `action.onClicked` → `openPreferredSurface()` is what runs
  in window mode, where `windows.create({type:'popup'})` needs no gesture. The
  same handler still opens the panel if Chrome ever fires it in side-panel mode.
  The click carries nothing else — host access is held from install,
  so there is no grant to broadcast and nothing to resume.
- **Which window the site is in**: `windows.onFocusChanged` records the
  last focused NORMAL window into `chrome.storage.session`, because a panel
  living in its own popup cannot work that out for itself (§4.1). Popups are
  ignored — ours is one.
- **Tab capture** — `captureShot()` plus the `dbg*` helpers above it. A viewport
  shot is `chrome.tabs.captureVisibleTab` (allowed by `<all_urls>`, no attach);
  full page is `chrome.debugger` + `Page.captureScreenshot`, a temporary attach →
  shot → detach, and the **only** `chrome.debugger` user left.
- **The step recorder's canonical state** (the `STEPREC_*` handler included), in
  `chrome.storage.session` under `stepRec`.

`importScripts('shared/view-mode.js', 'shared/site-tab.js', 'evidence/recorder.js')`
pulls in the surface preference, the tab resolver and the evidence recorder — the latter registers its own
`chrome.webRequest` and `chrome.runtime.onMessage` listeners at load.

### 1.2 Side panel — `extension/sidepanel/`

`index.html` is the whole DOM: every view is a `<section id="view-…">` toggled
by `show()`. The 35 `<script>` tags at the foot of `index.html` (one vendored
`showdown.min.js`, the rest ours) are the module system.

**Design tokens — `extension/shared/tokens.css`.** One stylesheet, `<link>`ed
before the page's own CSS by both the panel and the editor, holding every colour,
space, size, radius, shadow, depth and duration the extension uses. Three layers:
a **palette** — the system's two complete ramps, tailwind `neutral` and tailwind
`indigo` (50 → 950 each), plus the product's own notify/dark/kind hexes; indigo
is the only blue the chrome may use, while the product's semantic colours
(run kinds, priority, status) and the annotator's fixed red stay on their own
hues on purpose —, **scales** (`--space-*` on tailwind's 0.25rem base, a strict
4px grid with no half steps, plus `--gutter` for the page's side inset,
`--text-*`, `--radius-*`, `--shadow-*` named by role,
`--z-*`, `--dur-*`), and the **semantic** layer components actually consume
(`--bg`, `--accent`, `--passed`). Only the semantic layer changes between light
and dark, and it says both schemes on ONE line: every semantic token is a
`light-dark(light, dark)` pair resolved against the root's `color-scheme:
light dark`. That replaced a second, mirrored copy of the whole layer inside
`@media (prefers-color-scheme: dark)` — which is how the two drifted, and why a
new token routinely shipped light-only. It also means a page can PIN a scheme by
setting `color-scheme` on `<html>`, which is the entire implementation of the
styleguide's OS / Light / Dark switch. Components ask for a token and nothing
else — a raw value in `style.css` / `editor.css` is a bug or a missing token. This retired the editor's
hand-kept copy of the panel's hexes (its header used to say "values are COPIED
from sidepanel/style.css").

**Components — `extension/shared/components.css`.** The layer above the tokens,
`<link>`ed between `tokens.css` and each page's own stylesheet: the controls that
are identical on every surface — buttons, icon buttons, link buttons, inputs,
selects, textareas. Markup composes an intent, a size and a shape:
`class="btn primary"`, `class="input size-sm"`. Three sizes
(`--control-h-xs|sm|md` = 24 / 28 / 32px, all spacing steps; md is the default
AND the ceiling — the system has no taller control, so a primary action is made
to stand out by its fill and `.block`, never by height), four intents (`.primary` / `.secondary` / `.tertiary` plus the
`.passed|.failed|.skipped|.neutral` status family, with `.danger`, `.solid` and
`.outline` as modifiers) and they compose freely — every intent exists at every
size. Two decisions carry the file:

- **A `<button>` is reset to a bare, inheriting element.** The skin is a class.
  That is what lets a tab, a chip or a status circle draw itself from scratch;
  the panel used to keep a growing opt-out list of controls undoing a base
  `background`/`box-shadow` they never asked for.
- **Each component's default size is written with `:where()`** — zero
  specificity — so a `.size-*` class always wins wherever the cascade sees it,
  with no `!important` anywhere.
- **A leading icon takes a rung off that side** (`--control-px-lead`: 12 → 8, and
  8 → 4 at `xs`). A glyph never fills its 16px box, so the same padding that
  reads right beside a capital letter reads wide beside an icon and `+ New run`
  comes out left-heavy; a `:has(> icon:first-child)` rule on `.btn` and
  `.segment` puts the optical edge back. The one thing it asks of markup: a
  TRAILING icon needs its label in a `<span>` (`<span>Next test</span>↗`),
  because `:first-child` counts elements only — a bare text node before the icon
  is invisible to the selector and the icon would read as the first child.
- **A create button says the whole errand, and the ROW gives the first word up.**
  `+ New run` on Runs, `+ New test` on both Tests screens: same plus, same
  primary fill, same sentence, because they do the same kind of thing. Where a
  toolbar is too tight for it — the Tests tree bar carries two glyph creates as
  well — the button ships both forms (`.fit-label` with `.label-long` /
  `.label-short`) and `.is-short` picks the second. Which one a row wears is
  MEASURED, not a breakpoint (`fitActionLabels`, sidepanel/core/views.js): the
  measurement is the SEARCH FIELD beside it, the only thing in these rows that
  shrinks, and 144px — what its own placeholder needs — is the floor under which
  the word goes. The full errand stays on as the accessible name. It is measured
  for the same reason the `.filters` row one line down is (`fitFilterChips`, which
  moves its overflow into a `⋯` menu): a side pane is dragged, and its width has
  nothing to do with the viewport's.

`.segmented` + `.segment` is the same vocabulary assembled rather than extended:
one light `--segment-track` fill under the whole group, no dividers and no inset,
a segment at rest the tertiary button and the chosen one the secondary button
riding on it. Nothing pads the group, so the `.size-*` height IS the control's
height and the switch lines up with the button next to it. The one value it could
not borrow is the chosen chip's fill: on dark `--card` is the page under 5% white,
the same step the track takes, so `--segment-chip` takes the next step of that
white scale (on light it is the card itself). Everything else — border, lift,
type, radius — is the button's.

`.checkbox` / `.radio` / `.switch` + `.choice` are the CHOICE controls — the ones
that answer a question with their own state instead of doing something, and the
last hole in this file: they used to be `accent-color` and nothing else, which
left the box itself to the operating system (a different shape, a different
corner and a different blue from every control above them, and on dark it was
Chrome's idea of dark rather than this file's). The native box is switched off
(`appearance: none`) and all three are drawn from the tokens, shadcn's geometry
on this system's ramp. They have ONE size each and no `.size-*` — the ladder just
ends: 32 · 28 · 24 · **20 · 16**, the switch's track being the counter's 20 laid
on its side (36 wide, so a 16 knob travels exactly its own width) and the
checkbox and radio its 16, which is also `--control-icon`, because a tick is an
icon. Markup makes one decision, and it is about WHEN the answer takes effect:
`.checkbox` is a value in a form that nothing acts on until it is submitted
(the settings rows, committed by Save & validate), `.switch` is a setting that
applies the moment it is flipped and has no Save to belong to (Full page, which
writes itself on change). `.radio` is one of N and never fills — ring plus dot,
so a column of radios cannot be misread as a column of checkboxes. The component
is really the `<label>`: `.choice` is what is clicked, what is read out and what
the hit area is, and it lines the control up with the FIRST line of a label that
wraps, off a nudge computed from the type tokens rather than typed in. As with
the fields, each rule is written twice — the class, and a `:where()` fallback on
the bare element — so every checkbox already in the extension (a step tick, a
rendered markdown task list) gets the skin without being found first.

Beyond the controls, the file holds every other piece both pages share:
`.badge` (the passive pill — the status vocabulary again, so a badge and the
button beside it agree), `.card`, `.banner`, `.dialog`, `.toast`, `.tabs`/`.tab`
(underlined and folder-tab looks), `.disclosure`, `.menu`, `.toolbar`,
`.progress`, `.kv`, `.notice`, `.hint`, `.status-line`, `.empty`, `.kbd`,
`.list-caption` (the line above a list: the noun its rows are, the `.counter`
saying how many are on screen, and a `.caption-action` pushed to the far end —
indented by the row's own padding so the word starts on the titles' column),
`.tooltip`, `.bar` (the
page-chrome row that ran across both pages five times), `.code`, `.markdown`
(rendered user prose, in the two readings both hosts had kept a copy of: an
**article** by default — real headings on the 1.375/1.25/1.125em prose scale, what
a body being written wants — or `.markdown.sections`, where a heading is a muted
uppercase LABEL because the blob is embedded in a screen whose own title is the
heading; without it a test's `### Steps` printed bigger and heavier than the title
of the test it belongs to) and
`.spin` (one keyframe where there were two identical ones). Each existed
at least twice before — a panel copy and an editor copy of the toast, the guard
dialog, the tab bar, the popup and the message shell; three hand-written dismiss
buttons; two identical key/value grids; a dozen places that re-declared "muted,
12px" for a line of text.

**Empty states — `extension/shared/empty-state.js` + the `.empty` component.**
The skeleton's twin: that one draws content that has not **arrived**, this one
content that is not **there**, and until it existed both were answered the same
way — a muted 12px line ("No runs in this project yet.", "No reported steps")
left alone in a container the size of the whole screen. Nine screens had written
that line nine different ways, three of them with a hand-rolled
title/hint/actions stack of their own.

The shape lives in the EMPTY section of `components.css` — a `.empty-mark` (an
icon in a soft 48px box, one step past the control ceiling so it reads as an
illustration and not as something to press), an `.empty-title`, an `.empty-text`
capped at ~34ch, and `.empty-actions`, because a screen with no rows is a dead
end unless something on it is clickable. Two shapes: the block for a whole view
that came back empty, `.compact` for a nothing inside a screen that is otherwise
full (an unopened folder, the errors-only log, a filtered menu). The mark is
always muted — the accent belongs to the way out under the sentence, not to the
picture of the thing that is missing.

`EmptyState.build({icon, title, text, actions, compact, tag, live})`
assembles it; `tag: 'li'` is what lets one be the single child of a `<ul>`
without a `<div>` inside a list, and `live` sets `role="status"` on the states
that took an `aria-live` status line's job over (the filtered-empty runs list
and run checklist now say it in the list itself, with a Clear search / Show all
button under it, rather than in a line below the fold). Every one of the
panel's fourteen carries a **different** Material Symbol — `search_off` vs
`filter_alt_off` vs `find_in_page` vs `manage_search`, `folder_off` vs
`create_new_folder` — so two different nothings never look like the same
nothing.

**Tooltips — `extension/shared/tooltip.js` + the `.tooltip` component.** The
extension draws its own, and the browser's `title` attribute is gone from every
surface it reaches. The box is shadcn/ui's `tooltip` in this system's tokens
(inverted surface — `--tooltip-bg`/`--tooltip-fg`, near-black on light and
near-white on dark, exactly how shadcn's own `primary`/`primary-foreground` pair
resolves —, `--radius-sm`, 12px type, a rotated-square arrow, fade +
`zoom-in-95`); the engine is one `.tooltip` node in the document, moved and
rewritten per trigger. Markup asks with `data-tip` (plus optional
`data-tip-side="top|bottom|left|right"`, flipped when the side does not fit);
JS asks with `Tooltip.set(el, text)` and clears with `''`. The side is
**inherited from the nearest ancestor that names one**, so a row states it once
for everything it holds — both header bars do (`#context-bar`, `.tc-bar`:
`bottom`), because a label above a header covers Back and the trail, and the fit
test will not catch it on its own: a header a little down the page leaves just
enough room above for a two-line tip to "fit" straight over the row. An ancestor
that names the side is also the box the tip is **measured off and left whole**:
these headers are two lines tall around a 32px Back button, so 8px under the
*button* is still inside the row, and the label came out over the trail wearing
the row's own fill. It clears the block and stays centred on the control across
the gap (the arrow with it), which is what still ties the two together.

Three things in it are load-bearing:

- It **hit-tests the pointer** (`elementFromPoint` on `pointermove`) instead of
  listening for `pointerover` on a trigger, because a **disabled** control
  dispatches no pointer events at all — and half the tips in this panel are
  precisely a gate's reason on a disabled control (`recordWriteLock`, the
  assignee gate, the degraded Finish run).
- While one is open a rAF loop **follows** its trigger and closes the tip the
  moment that trigger leaves the DOM, is hidden, or gives up its text — the run
  view repaints rows under the pointer on every poll tick.
- A tip is a **description, never a name**: it sets `aria-describedby` while
  open (and only when the trigger has none of its own), so anything that used to
  be *named* by its `title` carries an `aria-label` instead.

No `title` survives anywhere in the product. The annotator toolbar injected
**into the page** was the last one — it lives in a shadow root, and from the
document `elementFromPoint` answers with the shadow HOST, so the hit test could
never see the button under the pointer. `Tooltip.mount(root)` moves the layer and
the hit test INTO that root (and `unmount()` hands them back on teardown, because
the injected world outlives the overlay); `tooltip.js` is injected with the core,
and `aria-describedby` works because the label now lives in the same tree as its
trigger. `shared/annotate-core.js` still chooses per realm — `Tooltip` present →
`data-tip`, absent → `title` — but the absent branch is a last resort for an
injection that lost a file, not a surface we ship. The assignee
dropdown used to be the other one — an `<option>` inside a native select popup
— until it became a custom listbox (`test-view.js`, same reasoning as the
project switcher's #126) so a row could carry a monogram and the popup a
type-to-filter box; its tips now go through `Tooltip` like everything else. The
vendored markdown toolbar writes `title` too; the editor moves those over with
`Tooltip.adopt()` right after the mount rather than patching vendored code.

`.list` is the third component and works the same way one level up: it owns the
row frame — the single bottom rule, the grey `--row-hover` wash, the light-blue
`--row-active` selection (product house style: a list is rows on one surface, not
a stack of bordered cards) — while the screen owns what a row contains. It
retired the panel's card rows and, with them, the four places that had to undo
that card again for a nested, child, section or load-more row.

One thing a row contains is owned too, because every list in the panel had it:
the TAIL. `.row-count` is the figure a row ends on — a suite's test count, a
rungroup's run count, a run section's done/total — plain muted text at the
trailing edge rather than the boxed `.counter` the trees used to draw, which put
a column of chips down the right of a tree and made a number that only qualifies
its title read as a control. `.counter` stays for a number riding inside a
control (a tab, a filter chip, a segment, a list caption), where the box is the
host's. `.row-actions` is the cell beside it, and `.row-actions.on-hover` is the
one that matters: the hover actions are laid OVER the trailing edge, on their own
copy of the row's wash, and the count fades out under them — one slot at the end
of a row, so crossing a list with the pointer never reflows a row.

Fields are declared twice in one selector list: `.input` / `.select` /
`.textarea` at class specificity, and `:where(input)` / `:where(select)` /
`:where(textarea)` at zero, so a plain field anywhere already looks right and any
per-screen rule still beats it. `.field` wraps one when an ornament belongs
inside its border — `.field-icon` (the search magnifier, pointer-transparent, a
label rather than a control) and `.field-clear` (an `.icon-btn` parked in the
right end). The three searches — runs, run and TC list — used to put that × in
the flex row NEXT to the input, which read as a second control competing for the
width; the wrapper made them one control again. This retired four hand-written copies of the same
button (the panel's `button` base, the editor's `.tc-btn`, the annotator's
`.annot-btn`, the editor's `.tc-tool`) and three of the same input. A control
that only makes sense inside one section keeps its rules in that section's
stylesheet — but takes its height from a `--control-h-*` token.

**Icons — `extension/shared/icons.js`.** The extension has exactly ONE
icon set: **Material Symbols Rounded, weight 400, grade 0, fill 0, optical size
24** (fonts.google.com/icons). Path data is vendored verbatim from
`google/material-design-icons`, file
`symbols/web/<name>/materialsymbolsrounded/<name>_24px.svg` (Apache-2.0), and the
keys of `Icons.PATHS` **are** the upstream names, so any icon in the panel can be
traced back to the site by searching its key. This replaced the old `@mdi/js`
paths — one set, one line weight. Three things follow from it:

- Material Symbols draw on a 960-unit em box with the baseline at y=0, so the
  viewBox is `0 -960 960 960`, **not** mdi's `0 0 24 24`. A path pasted from the
  wrong box renders as a blank square.
- No icon carries a colour. Every one is `fill="currentColor"` under
  `class="md-icon"`, so it inherits whatever it sits in; where severity used to
  ride an emoji's own colour (the evidence log's ⛔/🌐/⚠️) the *container* is
  coloured by a `data-*` attribute instead.
- A `::before` cannot hold an `<svg>`. The three that need a mark
  (`--icon-check`, `--icon-chevron-right`, `--icon-attach-file` in `tokens.css`)
  inline the same geometry as a **mask** painted in `currentColor` — never a
  coloured background image.

What is NOT Material, and why: the `type_*`, `status_*` and `tree_*` blocks at
the foot of `PATHS` are the design library's own — the type-of-test squares, the
run-status marks, and the folder/suite a tree row leads with — for things
Material has no equivalent of. They are drawn on their own frames, so each names
a viewBox in `BOXES`, and the folders are two-tone: a value there may be an array
of `[d, fill-opacity]` layers instead of one path string, which is the only way a
single-colour glyph can carry an outline over a lighter body. Beside them sits
`Icons.emoji(value, cls)`: Testomat lets a project replace a suite's, a folder's
or a test's icon with an emoji, and where it did, the panel draws that emoji in
the same 20px square the glyph would have used (`.tree-icon.emoji`,
`.type-mark.emoji`) — the mark the project chose, read off the API's `emoji`
field, not a glyph chosen here.

Deliberately NOT icons, and left as text: the keyboard names in the hotkey legend
(`⌘ ⏎ ↑ ↓ ← →`) and the `✓` that ends a status line ("Connected ✓") — the e2e
reads that one.

The vendored markdown toolbar is drawn from this set too. OverType ships an SVG
per button, which is a second icon set inside a product that has one — but the
buttons are handed to it as **data**, so `filteredToolbarButtons()` maps each one
onto a `TOOLBAR_ICONS` name (`bold` → `format_bold`, `quote` → `format_quote`, …)
and replaces its `icon`, on a copy: the vendored array is never mutated, `name`
is untouched (it is what the toolbar writes as `data-button` and what the e2e
reads back), and a button with no name in the map keeps its own glyph.

**Icons — `extension/shared/icons.js`.** One set: Material Symbols Rounded,
weight 400, path data vendored verbatim (Apache-2.0), keyed by the upstream icon
name so any glyph traces back to fonts.google.com/icons. `Icons.el()` builds an
`<svg>`, `Icons.markup()` the string form for the few `innerHTML` call sites, and
`Icons.hydrate()` fills the static chrome: markup writes
`<span class="md-icon disc-caret" data-icon="chevron_right">`, never a path.
That placeholder is the rule — before it, `index.html` carried 23 inline `<svg>`s
with the close path pasted six times, so fixing a glyph left stale copies behind.
The one hand-drawn `<svg>` left in the markup is the connect hero's illustration,
which is art, not an icon. Priority glyphs go through `shared/priority-icons.js`,
and the type-of-test squares through `shared/test-type.js`, both drawing from the
same set.

The set has ONE exception, and it names itself: the nine `type_*` glyphs are the
product's own type-of-test marks (◇ UI app library → Type of test), which
Material has no equivalent for. They are drawn on the library's own 13.3333-unit
box rather than Material's 960 one — the paths are the Figma export verbatim,
translated to that origin — so each declares its own viewBox in `Icons.BOXES` and
`Icons.boxOf(name)` is what `el()`/`markup()` ask. An icon absent from that map
is on the Material box, which is every other glyph in the file. Because the box
is the drawing's own, `size` means the drawing for these too: `.type-mark` asks
for 12 and gets 12px of glyph in its 20px square.

**Header layout.** Three rows above `<main>`, in DOM order:

```
                       ── on a tab ROOT ──
#project-bar  | Project: Extension Demo ▾  ⟳  ↗  ⬜ |  every tab, hidden until known
#header-top   | Tests   Runs   Settings      ● Rec |  #tabbar + #rec-slot
#context-bar  |                                    |  hidden

                  ── immersed (non-root view) ──
#project-bar  |                                    |  folded away
#header-top   |                                    |  folded away
#context-bar  | ←  Runs / Manual tests…    ● Rec   |  the whole chrome
              |    Verify user can transfer funds  |
```

- `#project-bar` carries three controls at its right end, in that order:
  `#btn-refresh`, `#project-open` and `#view-switch` (side panel ↔ its own
  window — `core/view-switch.js`). Refresh is **panel-wide** — `refreshAll()`
  (`core/views.js`) re-pulls the project list, the open view's own data
  (`refreshCurrentView()` dispatches on `state.view` and re-runs that screen's
  opener; the runs list refreshes in place, keeping its filter and expanded
  groups) and both tab counts (`refreshTabCounts()`, which skips the Tests count
  when the suite tree it is derived from was just redrawn; the Runs count is a
  server total no view derives, so it is always re-read). It owns the button's
  disabled + spinning state,
  set before the first `await`, and blocks re-entry. The degraded banner's
  Refresh is the same call. `#project-open` is an `<a>` wearing the icon-button
  skin, pointed at `<active host>/projects/<slug>` by `renderProjectOpenLink()`
  (`core/project-switcher.js`) and hidden when either half is unknown — the same
  deal "New run" makes. Both fold away with the strip when immersed.
- On a tab root `#header-top` is the **only** sticky row (`z-index: 2`) — the
  project strip above it scrolls away, the tabs pin. `#project-bar` must stay
  unpositioned and z-index-free or its dropdown is trapped (the stacking-context rake); since
  the strip sits above the sticky row, that `z-index: 30` popup is also what lets
  the menu open straight across the tabs.
- **Immersive drill-down.** Outside a root, `setImmersive()` writes
  `<body data-immersive="true">` and CSS folds the two rows above away:
  `#context-bar` becomes the whole chrome and the sticky row, and the screen gets
  the panel's full height — the deal `editor.html` already makes in its own tab.
  Neither folded row is usable during a drill-down anyway (the project is fixed
  for its duration, the tabs are unreachable until Back), and in a side panel the
  vertical is the scarce axis. `applyReadonlyBlock()` clears the flag with the
  row: under the lockout the project switcher IS the way out.
- The trail itself is the shared `.crumbs` / `.crumb` component
  (`shared/components.css`), because the test page's title bar wears the same one
  (§1.3) — the panel only adds the column it stacks with the title in. The name
  printed under it is shared too: `.context-title` is the one size a drill-down
  prints what is open at (`--fs-title`, the section-heading size), so this row
  and the test page's `.tc-view-title` read as one header instead of two levels
  of heading. The component carries type only — the three-line clamp and the
  tooltip on a cut title stay here, with the row that measures them.
- `#context-bar` holds three things: `#btn-back` (unmoved — Back only ever
  navigates within the active tab, so the row and the arrow share a lifetime),
  `#context-crumbs` (the path down to the open view, **ancestors only**) and
  `#context-title` (the view's own name — the last crumb, printed rather than
  linked). `updateContextBar()` (`core/views.js`) paints all three; it is shown
  iff the view is **not** in `ROOT_VIEWS`. Trails come from `CONTEXT_TRAILS`:
  `run` → *Runs*, `test` → *Runs / ‹run›*, `tclist` / `promote` → *Tests*. Every
  crumb opens the same destination `goBack()` walks to, so the trail and the
  arrow can never disagree about "up". A title that settles after the view opened
  (a run detail landing late) repaints through `refreshContextBar()`.
- `#context-open` is the row's fourth thing and the way **out** of the panel for
  whatever the row names: an `.icon-btn` anchor (new tab, `rel=noopener`) to that
  view's own page in the web app — `tclist` → `/projects/<slug>/suite/<uid>`,
  `run` → `/projects/<slug>/runs/<id>`, `test` →
  `/projects/<slug>/runs/<id>/test/<testrun uid>` (the Ember
  `runs.show.test` route — the record's page **inside the run report**, which is
  what the test view shows; the test CASE page, the singular `test` route of
  §1.3, is the fallback for a record with no run around it). Built by
  `renderContextOpenLink()` from `CONTEXT_WEB_TARGET` on every
  `updateContextBar()`, so a late-settling id or a project switch repoints it,
  and its tooltip/`aria-label` name the noun ("Open this run in Testomat") since
  one control serves three views. It **hides** — rather than point at a 404 —
  with no id, on the suite picker, on a read-only project, or when either half of
  the settings is missing, the same deal `#project-open` and "New run" make.
- `#rec-slot` is one container holding the Rec chip and the recorded-tab label.
  `renderEvidenceToggle()` (`screens/evidence.js`) hides the slot with the toggle
  so an absent chip costs the row no width. Because the chip is a *global*
  recording indicator, `homeRecSlot()` re-parents the container into whichever
  chrome row is on screen — `#header-top` on a root, `#context-bar` while
  immersed — so it never leaves with the row it happened to sit in.
- The test view no longer prints its own `<h2>` title (it carries `hidden`): the
  header row names the open test, and the h2 stays in the DOM only as the one
  element the title is written into. It rides in `#test-state-row`, the MARKS row
  of the test's summary card (the verdict chip, the custom status, the `queued`
  marker), which collapses whole — `:not(:has(> :not([hidden])))` — when the test
  carries none. That is why the title is hidden by attribute and not by
  `display: none`: the row has to be able to see that there is nothing in it.
- `contextTitleMarks(view)` (`core/views.js`) puts the open thing's marks at the
  head of that name: a suite's glyph, or — for a test — its **priority** and then
  its **type mark**, the same two a list row opens with, in the same order.
  Priority comes from the JSON:API detail (`state.testrunDetail`) or the record,
  and an absent or unknown one IS `normal` — the builder's own fallback and the
  rule every list here already follows, so the pair never loses half of itself
  between one test and the next. It lands one round trip after the row is first
  painted, so `renderPriority()` in the test view clears
  `state.testDetailPending` and calls `refreshContextBar()`; while that flag is
  up the slot is held by a skeleton disc in the same 20px `.prio` box. Paging
  through a run is what made the alternative visible: a mark that appears when
  the read lands steps the whole title 24px sideways.
- There is no root title element any more; the panel's identity is the tab bar.
- `#boot-skeleton` sits above all three rows and, while `<body data-booting>` is
  set (written into the markup, so it holds from the first paint), it IS the
  panel: `#header-top` is taken out for the duration — the strip and every view
  are already hidden at that point — and `Skeleton.bootDone()` (`core/skeleton.js`)
  removes both the flag and the container on the first view that can be painted.

**First-run connect screen.** With nothing saved (`!state.settings`) the Settings
view renders as a one-field connect screen — a hero (`#connect-hero`) plus the
Connection block — and the header goes with it. It is the SAME form: same ids,
same `saveSettings()`, so one place validates a token. `applyConnectMode()`
(`screens/settings.js`) is called from `show()` on every view change and flips
two presentational flags: `data-mode="connect"` on `#view-settings` and
`data-connect="true"` on `<body>`. The CSS is a **whitelist** — every direct child
of the section is hidden, then the few that belong are re-shown with an explicit
`order` — so a settings row added later stays off the first screen unless someone
puts it there. Keyed on `state.settings`, not `isConfigured()`: a saved config
whose project failed to resolve gets the full form, where Disconnect / Forget
instance / Sign out live.

**The full form has no token field.** Connected, the Connection section is a card
(`#connection-card`): the instance host, and **Disconnect** —
`disconnectInstance()`, which is `forgetInstance()` aimed at the host in
`state.settings` whatever the Instance field in Advanced is showing, and which
therefore ends on the connect screen. `#set-token` stays in the DOM (one form,
one `saveSettings()`) but is `display: none` until `syncTokenField()` sets
`data-token="on"` on the section — the one case being an Instance the panel holds
no token for, i.e. a new self-hosted host being added. Each erase writes to the
status line next to it: `#connection-status`, `#settings-forget-status` (inside
Advanced) and `#signout-status`.

**`core/`** — infrastructure every screen uses:

| File | Owns |
|---|---|
| `core/state.js` | The single `state` object; `$()`; `recordFor()`; `isConfigured()`; the `capabilities.jwt` gate and `applyCapabilities()`; the project-info and project-users caches and the `resetProjectScopedState()` that drops them; the `projectEpoch` / `staleProject()` guard that strands a container load a project switch has outrun; `handleApiError()`. |
| `core/storage.js` | `loadStored()` / `persistSession()` / `migrateHostSettings()` — the only writers of the `session` key. |
| `core/views.js` | `show()`, the three-tab model (`TAB_OF_VIEW`), `switchTab`/`goBack`, `updateContextBar()` (the contextual header row), `refreshAll()` (the project strip's panel-wide Refresh — projects, the open view, both tab counts), `toast()`, `setStatusLine()`, the degraded banner, and `paintCounter()` — the one writer of a `.counter`'s figure, which fades the number in when (and only when) it actually changed. Both filter rows and both tab chips go through it, and both rows are UPDATED rather than rebuilt, so a settling count moves nothing but its own digits. |
| `core/project-switcher.js` | The header project strip: `renderProjectBar()`, `renderProjectOpenLink()` (the strip's `↗` to `<host>/projects/<slug>`), `refreshProjects()` (JWT `listProjects`), `switchProject()` — which repoints `settings.projectId`, calls `resetProjectScopedState()` and lands the active tab on its root — and `initProjectSwitcher()` (boot paint + background refresh + resolving a config that has no project). The control is a custom listbox with a type-to-filter input (same pattern as the editor's priority menu — a native `<select>` pops an OS-level menu over the narrow panel): `initProjectDropdown()` wires it from app init, `renderProjectOptions()` paints the filtered rows, and the popup's `z-index` must stay in the root stacking context (the stacking-context rake). |
| `core/view-switch.js` | The header's surface switch: `initViewSwitch()` asks `ViewMode` which surface this document is in, `renderViewSwitch()` names and marks it for the one the press would land on ("Open in window" / "Dock to side panel"), and the click opens the other one and closes this. The two directions are not symmetric: the window is the worker's (`VIEW_OPEN_WINDOW`), while docking calls `chrome.sidePanel.open()` **before its first await** — the gesture lives only that long — on the normal-window id kept fresh from the worker's focus tracking, because a popup cannot host a side panel. |
| `core/env-info.js` | The `Browser` / `OS` / `Viewport` / `URL` facts, collected at click time and written as testrun **meta**. The `URL` is `origin + pathname` with a trailing `(query trimmed)` marker when a query/fragment was dropped, unless `envFullUrl` opts back in. |
| `core/skeleton.js` | `Skeleton` — the loading placeholders. A **navigation draws its own at once**: the screen it left is already gone, so waiting out a clock only buys an empty view that fills 150 ms later, which reads as a flash of nothing rather than as speed; it fades in (`.skeleton-enter`). The **boot** is the one that still waits — `paintBoot()` starts a 250 ms clock (`DELAY_MS`) so a fast open lands on the real panel having drawn none, and fills `#boot-skeleton` with the whole panel (project strip, tab row, a runs list) while init walks token → projects → runs; `bootDone()` disarms it, and drops the container and the `data-booting` flag, on the first view that can be painted. `show(view)` mounts a per-view placeholder in front of the container it will replace and returns a HANDLE — `hide(handle)` removes it only while it is still the one in hand, so a stranded load settling late cannot clear the placeholder of the load that outran it. A screen that already **holds its rows in memory puts up no placeholder at all**: it paints them and re-reads behind them (see 3.1). Every placeholder is composed from the real components with `.skeleton` bars in place of content (see the SKELETON section of `shared/components.css`) and from the bars in `shared/skeleton.js`, which is why there is no second copy of any row to keep in step. |

**`screens/`** — one file per surface, all plain top-level functions:
`runs-list.js` (703 lines, dashboard + v2 modes, groups, filters, search, URL
paste), `run-view.js` (717, the checklist, suite sections, inline statuses,
finish run, the custom-status pill + the run's custom-status counters), `test-view.js` (steps, priority, substatus, assignee, the
reported-result summary, the status write), `tc-studio.js` (suite tree + TC list), `evidence.js` (recorder UI
+ the `.txt` log), `attachments.js` (the Attach file picker, its upload
loop and the result's attachment list),
`hotkeys.js` (web-runner hotkeys + `attachScreenshotAnnotated`),
`livesync.js` (20 s poll), `offline-queue.js`, `onboarding.js`, `settings.js`.

`app.js` is loaded **last** and is the only bootstrap: it wires every listener,
restores settings + session, and picks the opening view.

### 1.3 Test page — `extension/editor/`

A standalone extension page (`editor.html`) serving three jobs, selected by
query string (`editor.js:3-11`):

- `?test=<uid>` — the **read-only view** of an existing TC (`renderView()`):
  title, priority chip and the description rendered through the same
  `showdown` + `sanitizeHtml` pair the Preview tab uses. No OverType, no Save, no
  priority dropdown, no recorder/screenshot tools (tests are edited in
  the web app; the panel runs and creates them). Its header carries the one way
  out — an "Open in Testomat ↗" anchor to
  `<active host>/projects/<slug>/test/<public uid>` in a new tab (the route
  is the product's own, `Test#to_url` + the Ember `suites.test` route, and both
  halves come from the active settings, so it hides rather than 404s when either
  is missing).
- `?suite=<id>` — the **create editor** (`renderEditor()`): OverType, the
  Edit/Preview tabs, the priority dropdown, the project template picker,
  the step
  recorder, screenshot capture, dirty guards and `Cmd`/`Ctrl`+`S`. A successful
  create hands the page over to `renderView()` of the new test (and rewrites the
  URL to `?test=<id>`), which is also what makes a second Save impossible —
  there is **no update path** (`api.js` has no `updateTest`).
- `?annotate=<key>` — the annotator **fallback** surface (`editor/annotate.js`),
  used when the on-page overlay cannot be injected.

`?ctx=panel` means the page is navigated to **in the side-panel document itself**
(the panel navigates away and back; `sessionStorage.tcReturn` is the breadcrumb
that restores the TC list, `app.js:86-92`) and adds the ◀ Back button;
`?ctx=tab` is the same page in a full browser tab, without that chrome.

**The trail (`?ctx=panel`).** This page is the deepest step of the panel's Tests
path, so its title bar carries the same header the panel's own drill-down does:
`buildCrumbs()` puts **Tests / ‹suite›** over the title in a `.tc-bar-main`
column beside Back — the shared `.crumbs` component, ancestors only. (In create
mode the trail is the whole of that column: the title has a row of its own under
the bar, see below.) The suite comes from `tcReturn`, **read and not
consumed** (the panel's boot still needs it). The suite crumb goes where Back
goes; the Tests crumb drops `tcReturn` first so the panel lands on the tree
instead of the suite. In create mode both go through `requestBack(to)`, which is
what keeps the unsaved-changes guard on every way out and sends the guard's own
Save & leave / Discard to whichever target opened it. In `ctx=tab` there is no
panel to walk back into, so there is no trail.

The read-only view's bar is that row **to the pixel**, because the tester walks
straight from one into the other: 8/gutter padding, 4 across the row, no gap
inside the column (the trail's line box and the title's already hold each other
apart), a 2-line clamp on the title, and the same 52px height. It had drifted 4px
in each direction, which stood the header 5px taller than the one it continues.
The create bar keeps the shared `.bar` gap of 8 — the way back, the trail and the
priority dropdown are separate controls.

**The create editor's shape.** Top to bottom: the bar (Back, the trail, the
priority dropdown), the **title's own full-width row**, the **Edit / Preview
tabs**, the **writing tools**, the markdown pane, and the **footer**. Four
decisions are worth naming, because each one moved something out of the header:

- The title is the shared `.textarea.autogrow.size-sm`, alone on its row. It
  wraps to a second line rather than scrolling its own beginning out of sight
  (`field-sizing: content` — the browser measures it, there is no JS), Enter
  moves on to the body instead of inserting a newline, and Save normalises
  whatever a paste brought in. It used to be an `<input>` set in the HEADING's
  face and size over a transparent fill, squeezed between Back and two buttons —
  a heading you could type in, on about half the width the longest value on the
  page needs.
- The tabs are the panel's own `.tabs.fill` (icon + label, the rule under the
  open one), not the folder tabs this page used to draw — one switcher shape
  across the product. The page adds `flex: none` (the shell is a column, where
  `.fill`'s `flex: 1` would buy the bar the leftover HEIGHT) and the closing
  rule the panel's tab row draws for itself.
- The tools row — template picker, Record steps, Attach screenshot — belongs to
  the **Edit tab alone**; Preview renders what they produced and has nothing for
  them to do. All three fit one row in a 380px panel, which is what the template
  picker's dropped label (the mark is inside the field now, shared `.field`) and
  Attach's icon-only form pay for. What Attach produces sits UNDER them: the
  staged screenshots are the library's `.thumb-row` (`components.css`) on a line
  of its own (`flex: 1 1 100%`), because the camera appends — a test may hold up
  to `MAX_SHOTS` (10) pictures, uploaded in order on Save — and a growing row
  must never push the camera off the strip. Each picture carries its own remove
  as a badge on it (`.thumb-remove`), and the ones that fail to upload stay
  staged so a second Save retries exactly them.

This page also sets the panel's **body type** (13px in a 1.5 line): it had
never set one, so it ran on the browser's 16px and every relative value in the
rendered markdown was measured off a root this system does not have — a test's
`### Steps` printed at 18px, above the title of the test it belongs to.

**The editor's colours.** OverType's own themes are somebody else's palette —
`solar` paints a heading orange on cream, `cave` violet on navy — so `applyTheme()`
passes `EDITOR_COLORS` alongside the theme name and every colour that lands on the
page is a **token**: `var(--fg)`, `var(--bg)`, `var(--surface-2)`, and so on.
OverType injects them as CSS custom properties into this document, so the whole
set follows the OS light/dark switch through `tokens.css` by itself, which is why
one map serves both theme names. The one design decision in there: a heading and
the marks around it (`###`, `**`, the list bullet) are **accent** — indigo, the
product's own — with the marker mixed a step toward the page so the structure of
the markdown reads without competing with the words.

**Depth.** The title bar is the shared `--z-sticky` (2), like every other pinned
chrome row in the extension, and what makes that possible is `.tc-body` —
the OverType host + preview pane — carrying `isolation: isolate`. The vendored
editor stamps `z-index: 100 !important` on its toolbar (and 10000 on its dropdown
and link tooltip), numbers written for a page that is nothing but OverType and
unreachable from here (vendored code is never edited); an
isolated pane orders them against each other and nothing else. The bar used to
out-number them instead (`--z-page-bar: 110`), which put page chrome above the
layers the whole extension shares — a tooltip opened from that bar (`--z-tooltip`
40) was painted **under** it, and so was the app frame (`--z-frame` 100). The
priority menu still paints whole over the tabs and the toolbar, which is what
that 110 had been for.

It reuses the panel's globals via its own `<script>` list
(`editor.html:15-26`) — same `TestomatAPI`, same settings, same v2 endpoints.

### 1.4 `shared/` — loaded by more than one realm

| File | Loaded by | Global |
|---|---|---|
| `shared/view-mode.js` | worker (`importScripts`), panel | `ViewMode` — which SURFACE the panel is in and which one the toolbar icon opens next: `sidepanel` (default) or `window`, remembered in `chrome.storage.local.viewMode`. Also owns the two window ids window mode needs (`chrome.storage.session`): the panel's own popup, and the last focused NORMAL window the site under test is in |
| `shared/site-tab.js` | worker (`importScripts`), panel, editor | `SiteTab`, `resolveSiteTab` |
| `shared/site-access.js` | panel, editor | `SiteAccess`, `ensureSiteAccess` |
| `shared/capture-annotate.js` | panel, editor | `CaptureAnnotate` |
| `shared/annotate-core.js` | editor page, **and injected into the page** | `Annotate` core engine |
| `shared/html-sanitize.js` | panel, editor | `sanitizeHtml` — the extension's only XSS boundary |
| `shared/img-hydrate.js` | panel, editor | `ImgHydrate` — every image inside test CONTENT, shown despite a CSP that allows no remote `<img>`. `hydrate(group, container)` runs on a DETACHED rendered-markdown container, right after `sanitizeHtml`: each `src` is taken OFF the node before it can reach the document (a remote one the CSP blocks, a root-relative one the extension 404s — the blank box that was reported), the bytes are fetched through `TestomatAPI.fetchAsset` and handed back as a `blob:` URL, and a fetch that fails leaves an "open image ↗" link instead of nothing. `load(group, url, img)` is the same swap for a thumbnail the caller built (the reported-step screenshots and the result's attachment list). Object URLs are owned per GROUP, revoked by `release(group)` when the container that painted them goes; `held(group)` is the e2e's proof that they were |
| `shared/icons.js` | panel, editor, **and injected into the page** | `Icons` — the ONE icon set (Material Symbols Rounded, wght 400, fill 0) |
| `shared/priority-icons.js` | panel, editor | `PriorityIcons` (drawn from `Icons`) — `mark(p)` builds the `.prio` component a list row opens with |
| `shared/test-type.js` | panel | `TestType` — the type-of-test mark (`.type-mark`): `of(record)` reads the kind off a v2 record, `mark(kind)` draws the square a LIST row wears, `mark(kind, {text:true})` the square-plus-word every other surface wears (the run header's kind chip). Panel-only: the editor writes one test, it lists none |
| `shared/user-cell.js` | panel | `UserCell` — a PERSON, printed (`.user-cell` + `.avatar`): `normalize(value)` reads a name / an email / a record into `{name,email,avatar}`, `cell(user)` draws the monogram-plus-name Run info's "Executed by", "Created by" and "Assigned to" wear. The monogram is the floor and the photo is an upgrade: the CSP allows no remote `<img>`, so an avatar URL is fetched (cookieless, cached per URL) and swapped in as a `blob:`; anything that refuses — CORS, 404, a login — leaves the initials |
| `shared/theme.js` | panel, editor — **from `<head>`**, the only script either page loads there | `Theme` — the colour scheme: `system` (default) / `light` / `dark`. Applying one is a pin of `color-scheme` on `<html>`, which is what every token in `tokens.css` resolves its `light-dark()` pair against; `system` REMOVES the pin, so `:root`'s own `color-scheme: light dark` follows the OS live with no `matchMedia` listener. The `<head>` placement is the point: it runs before the first paint, so a pinned panel never flashes the OS scheme on the way in |
| `shared/tooltip.js` | panel, editor | `Tooltip` — the extension's own tooltip, replacing the browser's `title` |
| `shared/empty-state.js` | panel, editor | `EmptyState` — the one builder for every "there is nothing here" (drawn from `Icons`, so it loads after it) |
| `shared/skeleton.js` | panel, editor | `Sk` — the skeleton **vocabulary**: `bar()` (one grey bar) and `lines()` (a paragraph of unloaded prose). Which placeholder a screen puts up is the screen's own business — `core/skeleton.js` for the panel, `renderView({loading})` for the test page — but the bars are the same bars, and the two documents share no other script |
| `extension/api.js`, `params.js` | panel, editor | `TestomatAPI`, `TestomatParams` |

`shared/site-tab.js` is written to load in **both** a worker and a document —
no `document`/`window` references — because `importScripts` and `<script src>`
must both work.

### 1.5 Injected code (content scripts, but not declared ones)

There are **no** `content_scripts` in `manifest.json`. Both injected scripts go
in on demand through `chrome.scripting.executeScript`:

- `content/step-recorder.js` — injected by the worker (`srInject()`,
  `background.js:124-127`) on start and on every `complete` navigation of the
  recorded tab. Capture-phase listeners, a Shadow-DOM indicator, one recorder
  per document (`window.__testomatStepRecInited`).
- `evidence/relay.js` (ISOLATED) + `evidence/page-hook.js` (**MAIN world**) —
  the evidence recorder's instrumentation, injected by `evInject()` on Rec-start
  and on every navigation of the recorded tab, and additionally **registered**
  for the recorded origin through `chrome.scripting.registerContentScripts` at
  `runAt: 'document_start'`, so a reload is instrumented before the page's own
  scripts run. One hook per document (`window.__testomatEvHooked`). See §3.4.
- `overlay/annotate-overlay.js` + `shared/annotate-core.js` + `shared/icons.js`
  (first — the toolbar draws its marks from it) + `shared/tooltip.js` — injected
  by `CaptureAnnotate.tryInjectOverlay()` (`shared/capture-annotate.js`)
  into the tab the screenshot came from. A preceding `executeScript({func})`
  stashes three things on the window in the same isolated world:
  - `__testomatAnnotateKey` — the handoff key;
  - `__testomatAnnotateScheme` — the Appearance setting **already resolved** to
    `light`/`dark` by the panel. The overlay lives in the site's document, where
    neither store `shared/theme.js` keeps is readable, so an overlay left to
    answer `prefers-color-scheme` itself would come up dark under a panel pinned
    to Light;
  - `__testomatAnnotateCss` — **the library itself**: `shared/tokens.css` +
    `shared/components.css`, read as text in the extension's own context and
    made the first stylesheet in the shadow root. A shadow root cannot `<link>`
    an extension file, and making those files web-accessible would let any page
    the overlay touches fingerprint the extension by fetching them. Two edits on
    the way in: `:root` → `:host` (a shadow root has no `:root` — the tokens must
    land on the host) and every `@font-face` stripped (its `url()`s are relative,
    so inside the site's document they would be fetched **from the site**). This
    is what retired ~120 lines of hand-copied button skin in the overlay: the
    toolbar is now made of real `.btn`/`.swatch`/`.segmented`/`.menu` controls,
    and a change to a button in the panel is that change in this toolbar. If the
    read fails there is no overlay — the caller falls back to the editor tab
    rather than drawing an unstyled one.

---

## 2. How the realms talk

### 2.1 Runtime messages

Everything is `chrome.runtime.sendMessage` with a `type` string. There are no
long-lived ports.

| Type | From → To | Purpose |
|---|---|---|
| `captureTab` `{fullPage}` | panel / editor → worker | Screenshot the active tab. Replies `{ok, dataUrl, tabId}`. `background.js:377-389`. |
| `VIEW_OPEN_WINDOW` | panel → worker | Open the panel in a window of its own, or focus the one already open. Replies `{ok, windowId}`; the panel then remembers the choice and closes the surface it was pressed in. |
| `EVIDENCE_TOGGLE` `{tabId}` | panel → worker | Start/stop the console+network recorder. |
| `EVIDENCE_STATUS` | panel → worker | Poll `{recording, tabId, tabTitle, windowSec, entryCount}`. |
| `EVIDENCE_LIST` `{errorsOnly}` | panel → worker | Entries inside the window, optionally errors only. |
| `EVIDENCE_SNAPSHOT` | panel → worker | All entries in the window (used to build the `.txt` log). |
| `EVIDENCE_WIPE` | panel → worker | Sign out and Forget on the ACTIVE instance: cancel the pending mirror, stop the recording DROPPING its buffer, then remove `evidenceMirror` — in that order, awaited, so the panel's `clear()` cannot be undone by a late mirror. |
| `EVIDENCE_EVENTS` `{events}` | injected relay → worker | One batch from the page hook: `net` / `console` / `log` / `ready` rows. Replies `{off}` — `true` meaning "this document is not being recorded", which is the hook's only stop signal. |
| `EVIDENCE_HOOK_ON` / `EVIDENCE_HOOK_OFF` | worker → injected relay (`tabs.sendMessage`) | Un-mute / mute the page hook. The mute survives in a document that never navigates, so a NEW recording on the same tab has to un-mute it — a re-inject cannot (double-init guard). |
| `EVIDENCE_STOPPED` `{reason}` | worker → panel (broadcast) | The recording ended without the tester. There is exactly one such reason: `target_closed`. |
| `STEPREC_START` | editor → worker | Begin recording on the active site tab. |
| `STEPREC_ADD` `{entry}` | injected script → worker | One recorded step/expected line: `{kind, text, action?, name?, context?:{row,section,column}, ctx?, manual?}`. `text` is the rendered line every consumer reads; the structured fields are additive and stored verbatim, field by field, by `srEntry()`. `ctx` (#23) is the action's **context packet** — `{action, element, near, page, value?, after}` — copied whole rather than field by field, and the only thing the editor's AI polish reads. `manual:true` marks an expected the tester typed on the indicator, as opposed to an auto navigation one. `entry.replaces` (dblclick only) names the single-click text this action supersedes and is a wire instruction — it never lands in the recording. Handled through `srSerial()` — one chain, because the state is a read-modify-write. |
| `STEPREC_STATUS` | editor → worker | Poll `{recording, count, paused, manualPause, blind, tabId}`. |
| `STEPREC_TITLE` `{title}` | injected script → worker | Real `document.title` after a navigation, to refine the last nav entry. |
| `STEPREC_STOP_REQUEST` | injected script / editor → worker | Stop recording, keep the entries. |
| `STEPREC_CONTINUE` | editor / injected → worker | Clear the **cap** pause and grant another cap's worth. |
| `STEPREC_PAUSE` `{on}` | injected script → worker | The tester's own Pause/Resume on the indicator. Sets `manualPause` — never the cap's `paused`, so it grants no extra cap (`background.js:269-276`). |
| `STEPREC_STOP` | editor → worker | **Drain**: return the entries and clear the state. Idempotent. |
| `STEPREC_PEEK` | e2e only → worker | Read raw entries mid-recording. Explicitly marked "no production sender" (`background.js:461-463`). |

The evidence handler ignores anything outside its `EVIDENCE_REQUESTS` set so the
two `onMessage` listeners in the worker plus the recorder's do not fight over one
message.

### 2.2 The `<script>`-tag global convention

A new panel module must:

1. be a classic script with no imports/exports;
2. expose exactly one IIFE global (`const Foo = (() => { … })()`) or bare
   top-level functions;
3. be added to `sidepanel/index.html` **before** `app.js` and **after** every
   global it reads at load time;
4. declare what it reads from other files in a `/* global … */` comment (the
   convention every existing file follows).

`core/state.js` must precede everything touching `state`; `app.js` must stay
last. Nothing enforces either — see *Rakes*.

---

## 3. Data flow of the five things that matter

### 3.1 Opening a run

`openRunsView()` takes the memory-first path whenever this project's list is
already loaded (`state.dashItems` in dashboard mode, `state.lastRuns` in v2): the
rows are painted **at once** — no clearing, no "Loading runs…", no placeholder —
and `refreshRuns()` re-reads behind them. Only with nothing to show (first open,
or a project switch having emptied them) does it put up the placeholder and go
through `loadRuns()` (`screens/runs-list.js:53-80`), which tries
`TestomatAPI.fetchDashboardPage(1)` (JWT). Success ⇒ `state.listMode =
'dashboard'`, `capabilities.jwt = true`. Failure **only when
`jwtAvailable() === false`** falls back to the v2 `listRuns` + `listRunGroups`
pair (`listMode = 'v2'`); any other error is re-thrown, so a real outage is not
silently mistaken for degradation.

Clicking a run → `openRunView(runId, title)` (`screens/run-view.js:78-166`):

1. reset per-run nav state (`runFilter`, `runSearch`, `expandedSuites`) — for a
   DIFFERENT run only, which also empties `#run-info` and the status chips so the
   new run can never wear the last one's fields under its own title. Re-opening the
   run already on screen with its records in memory (Back from a test, the
   panel-wide Refresh) tears nothing down at all: no placeholder, no cleared
   checklist, no hidden pills — the paint stays and the re-read lands in it;
   `show('run')`;
2. `Promise.allSettled([getRun, listTestruns, getRunInfo?])` — the legs are
   independent on purpose: a failed *meta* fetch degrades the header to a cached
   title and a muted note, but the checklist still renders. Only a failed
   **test-list** leg throws. The JSON:API `getRunInfo` rides in the same batch
   whenever `capabilities.jwt` is already true, and is applied OVER the v2 base
   before the first paint — so the run paints **once**, instead of inserting
   Started / Duration / Executed by a paint later. Without a proven session yet
   (the first run of a panel session) the old two-phase paint stands;
3. `state.records = <sorted by id ASC>` (v2 returns newest-first; run order is
   creation order);
4. `renderRunView()` → `startLiveSync()` → `OfflineQueue.replay()` →
   `probeRunSession(runId, { infoRead })` (fire-and-forget; loads run-replies,
   settles the Finish button, resolves assignee names — and skips its own
   `refreshRunInfo()` when the batch above already read it).

`state.records` are **testrun records**, keyed by record id — never `test_id`. A
parametrized test has one record per example row and they all share `test_id`
(`core/state.js:27-30`).

### 3.2 Setting a status

Two entry points, one writer:

- run view, inline ✓/✗/– on a row → `writeRowStatus()` (`run-view.js:511`);
- test view, the big buttons or a hotkey → `clickStatus(status)`
  (`test-view.js:520`). A landed write also moves the screen to its **Status**
  section (`showTestSection('status')`) — the four controls that only apply once
  a row HAS a result live there.

Both funnel into `writeStatus(record, status, comment, onOptimistic, opts)`
(`test-view.js:478-516`):

```
syncBeginWrite()                    ← pause live-sync ticks
message = comment                   ← the tester's text, for EVERY status
Object.assign(record, {status, message})   ← optimistic mutation
onOptimistic()                      ← caller repaints
TestomatAPI.setStatus(...)          ← v2, token only — works in basic mode
  ↳ network / 401-403 «paused»?  →  OfflineQueue.enqueue(...)  → return {queued:true}
  ↳ otherwise                    →  throw, caller rolls back from its snapshot
Object.assign(record, saved, {test_id: record.test_id})
writeEnvMeta(record, status)        ← AFTER the id exists; JWT-only, never fatal
  collectEnvMeta()                  ← core/env-info.js   (Browser/OS/Viewport/URL)
  status === 'failed'
    ? uploadEvidenceLog(record)     ← screens/evidence.js (uploads the .txt, returns its URL)
  TestomatAPI.setTestrunMeta(...)   ← one bulk_update POST for all the keys
syncEndWrite()                      ← resume ticks + force an immediate refetch
```

`setStatus` POSTs on the first result and PUTs afterwards (`api.js:138-148`).
After a successful test-view write, step ticks for that record are dropped —
and that is all: **no status navigates**. Marking used to auto-advance on
pass/skip, which redirected the tester the moment the substatus / assignee /
comment / attachment controls appear (they render only for a row with a real
status). `failed` additionally opens Attachments & log.

Moving on is an explicit, always-available act: `nextTest()`
(`test-view.js:573-597`), wired to the persistent `#btn-next-test` button
(`app.js`) and the bare `N` hotkey (`hotkeys.js`). It walks the VISIBLE sequence
(`orderedRecords()` + `rowVisible`) to the next untested row, never re-opens the
current test (it is reachable on an unmarked one), and has two dead ends —
nothing untested anywhere → `Run complete 🎉` + the run view; only the current
test untested → a toast, stay put.

### 3.2a The reported-result summary

A test the run has ALREADY reported gets the web's Summary panel above the
marking controls (`renderResultSummary()`, `test-view.js`): the status +
duration line, then the **Failure** / **Meta** / **Steps** disclosures — and
never a **Stacktrace**, which is the one web section the panel deliberately
drops.

It is a pure read of `state.testrunDetail` — the JSON:API detail `probeSession()`
already prefetches on every test open — so it costs no extra request in the
common case and is **JWT-only** like the priority icon. Attribute keys there are
dasherized (`run-time`, in **milliseconds**). Four contract facts, all verified
live against `TestrunSerializer`:

- **the gate** is a real status: `attributes.status` present and not `pending`;
- `attributes.message` is already **ANSI-stripped** server-side
  (`Testrun#cleaned_message`), so nothing here has to decode escape codes;
- `attributes.steps` exists **only for a manual testrun**. An automated one
  advertises `attributes.sections.steps.count` and its steps come from
  `GET /testruns/{id}/steps` — fetched lazily on first expand, exactly as the web
  does, through the exported `TestomatAPI.jwtRequest` (no new api.js entry point);
- **Meta** is `attributes.extras` minus the `source: 'system'` rows (the web's
  `metafields`). The `attributes.meta` attribute is a *project-template string*,
  not the entry list — do not mistake one for the other.

Rendering splits on `attributes.automated`, matching the web: a reporter message
is printed verbatim (`white-space: pre-wrap`) because its newlines and
indentation carry the assertion's shape, while a manual message — everything the
panel itself writes — goes through `showdown` + `sanitizeHtml`. The card is painted
once per open and is not refreshed by the tester's own marking (that write has
its own status line); re-opening the test re-reads it.

### 3.2b Write locks — archived run, finished run, automated result

Three conditions make a result read-only in the panel, and all of them run through
one piece of plumbing in `screens/run-view.js`:

```
runWriteLock()                  → '' | reason that holds for the WHOLE run
  runArchived()                 → 'Run is archived — results are read-only'
  runFinished()                 → 'Run is finished — results are read-only'
  runAutomated()                → 'Automated result — read-only in the panel'
recordWriteLock(record)         → runWriteLock() || (recordAutomated(record) ? … : '')
```

Precedence is deliberate: the run-level reason wins, because it is true of the
row as well and every control has room for exactly one reason. Archived comes
first because an archived run is *usually* finished too, and being told the wrong
reason is the same as not being told — an honest reason is the point of the gate.

- **Archived** is the parity hole this lock was added for. The panel filters archived runs out
  of its lists (`filter[archived]=false`, index only) but they stay reachable two
  ways: a **pasted run URL** — the archived filter is on the index, never on the
  show route, which answers 200 — and a **restored session**, since
  `persistSession` stores a bare `runId` and boot reopens it with no state check,
  so the run may have been archived by anyone in the meantime. The server has no
  authorization check for archived runs at all (only list filtering), and the
  damage is silent rather than loud: `Run#calculate_counters` early-returns on an
  archived run, so a write leaves its counters permanently stale. Web parity: the
  run page drops Finish / relaunch for an archived run
  (`extra-run-actions.hbs`) — the panel's `finishRun` otherwise offers an action
  the web UI cannot even express — so `updateRunActions()` hides the button on
  this signal too.

  Note that archiving a **rungroup does not archive its runs** (`rungroup.rb`
  touches rungroups only); a run inside an archived group is itself
  `is_archived: false` and merely vanishes from lists. Do not infer archived-ness
  from the group.

  **The open window, and why it is closed the way it is.** Unlike the finished-run lock — whose
  status ships on the v2 detail `openRunView` already awaits — the archived flag
  is JSON:API-only. With a session already proven it rides `openRunView`'s own
  batch and is applied before the first paint; without one (the first run opened
  in a panel session) it still lands with the session probe, one round-trip
  *after* the run has rendered, and that is the window below.
  Locking while the answer is unknown was considered and rejected: inside that
  window a live run is indistinguishable from an archived one, so the tester would
  get "Run is archived — results are read-only" flashed over a live run, which is
  the dishonest reason this gate exists to prevent. Instead the paint stays
  truthful and the **write** waits: `openRunView` keeps the probe promise in
  `runStateProbe`, and every write reachable inside the window awaits
  `awaitRunState()` before consulting the lock.
  The members leg — assignee names, the Run info people, and the viewer's own
  profile timezone — is detached into `probeRunAssignees()` so a click
  never waits on cosmetics.

  The wait is **bounded** (`PROBE_WAIT_MS`, 2 s, `Promise.race` with `sleep`).
  Nothing in this extension sets a fetch timeout, so a probe that *hangs* rather
  than fails would otherwise park the write forever — no spinner, no toast, and no
  error for the offline queue to catch, which is the one case the queue exists for.
  Past the cap the write proceeds on what it knows and fails honestly, as before.

  Three call sites, because three writes are genuinely reachable that early:
  * `writeRowStatus` — the run view's ✓/✗/– buttons. It claims the row
    (`setRowButtonsBusy`) *before* awaiting: the same-status guard runs first, so
    two fast clicks would otherwise both get through.
  * `clickStatus` — the test view's buttons **and** the Cmd/Ctrl hotkeys.
    `openTestView` paints `show('test')` + `updateTestActionsState()` synchronously
    before its first await, so those controls render live after one extra click, no
    round-trip needed. It claims `state.saving` before awaiting, for the same reason.
  * `finishRun` — button visibility is **not** a sufficient gate:
    when the probe is the one reading the run info, `updateRunActions()` runs inside
    `probeRunSession` *before* `refreshRunInfo`, so Finish is live on an
    archived+running run for that sub-window, and the confirm dialog can then sit
    open indefinitely. `finishBlockedReason()` is therefore checked on **both**
    sides of the dialog. It deliberately mirrors what
    `updateRunActions()` hides on (archived, finished) rather than calling
    `runWriteLock()`, which would also bar finishing an automated run — something
    the panel has always allowed (the automated lock gates results, not the run), and which
    `updateRunActions()` has never consulted, so the button would render and then
    refuse itself. An e2e scenario pins that boundary; nothing else in
    the suite paired an automated run with Finish.

  Known gap, pre-existing and unrelated to archived: `finishBlockedReason()` omits
  `updateRunActions()`'s `state.runStatus === 'running'` leg, so `finishRun()`
  *invoked directly* on a `scheduled` run is not blocked. Only the button's
  visibility stops that today.

  The offline queue resolves the run's state itself and needs none of this.

  > **Basic mode is blind to this, on purpose.** The single signal is
  > `is-archived` on the JSON:API run detail (`RunSerializer`), which rides the
  > JWT read the poll already makes anyway. **The v2 run payload carries no
  > archived flag whatsoever**, so a token-only panel
  > has nothing to read and does not lock. That is an accepted limitation, not an
  > oversight: the alternatives were all guesses (the rungroup does not say it,
  > and a terminal status is a different fact). It is pinned by an e2e
  > scenario so it cannot change silently.

- **Finished** is read off two signals, whichever is fresh — the v2 run status
  (terminal after a finish; the only signal basic mode has, refreshed by the
  livesync tick's `refreshRunFinished`) and the JSON:API run detail's
  `status`/`finished-at` that the JWT poll already reads anyway. The
  server enforces nothing here: it accepts every one of these writes into a
  finished run, because the CI reporter depends on that.
- **Automated** comes at two granularities: the run's `kind` (`state.runKind`,
  v2 run detail) bars *every* row of an automated run — including the ones no
  reporter has filled yet, exactly as the web's `routes/launch.js` `afterModel`
  redirects out of the runner — and the v2 testrun record's own `automated` flag
  bars that one row, so a **mixed** run locks only what CI reported. Here the
  server is worse than indifferent: `Testrun#add_step!` returns early on an
  automated testrun and the controller still answers **200**, so an ungated step
  click would paint a state that was never stored.

Every *per-record* write path calls `recordWriteLock(record)` — the row ✓/✗/–
buttons and `writeRowStatus`, `clickStatus` (hence both the test-view buttons and
their hotkeys), `cycleStep`, `onSubstatusChange`, `updateTestActionsState` (the
comment, the step checkboxes, the substatus select, both attach buttons),
`attachScreenshotAnnotated` and the `writeEnvMeta` side effect. Only the run-wide
surfaces read `runWriteLock()` directly: the `#run-lock-note` paragraph, which
therefore appears only when the reason holds for the whole view.

`applyRunLock({force})` paints all of it from STATE rather than from a detected
transition — several paths can learn the run finished, and a flip-detecting
version missed the paint whenever a path other than the one holding the "before"
value got there first (measured). It memoises a *signature* — the run-level
reason plus the set of rows locked on their own account — so an unchanged poll
tick costs nothing while a reporter result flipping one row of a mixed run (which
need not change any status, so the row diff sees nothing) still repaints. The
archived lock rides this unchanged: archiving changes no status either, but it *does* change the
run-level reason, which the signature already carries.

The **offline queue** is the one write path that outlives the view, so it re-checks
the lock itself rather than inheriting it — the target run is usually not the one
on screen. `dropLockedRunEntries()` (`screens/offline-queue.js`) resolves each
DISTINCT target run once and drops every entry aimed at a locked one, with the same
three reasons in the same precedence: finished and automated off the v2 run detail
(`status` / `kind`), archived off the JSON:API one, session-gated exactly as above.
Automated is covered at RUN level only — a queued entry for one automated row of a
**mixed** run still replays, because the drop resolves runs, not rows; the run-level
`kind` is what the v2 run detail carries. A run it cannot read (offline — the common
case here) is left alone and the replay fails on its own terms. Drops are always announced in one toast; a queued result is
a tester's unsent work and is never discarded silently.

Both reads per run, and all runs, go out under one `Promise.all`, because a drain's
dead time is not free: a trigger arriving inside it hits `queueReplay()`'s
`queueDraining` re-entrancy guard, and serialising these two reads (~1.35x, 158 ms
median to 117 ms) was enough to cost the finished-lock queue scenario a toast it
had always received.

That guard no longer swallows the trigger — it used to return and
raise nothing at all, so a tester's Retry did nothing and an entry queued *after*
the running pass took its snapshot waited for a trigger that might never come (a
run view polls, but a panel on the runs list has no timer at all). The request is
**coalesced** instead: remembered in `queueRedrainRequested` and honoured by ONE
more `drainPass()` after the current one — one, not a loop, which is what keeps the
original no-retry-storm promise. The banner Retry passes `{user: true}` and is the
only trigger allowed to say so out loud ("Already syncing — your Retry runs right
after"); a poll tick landing in the same window coalesces silently.

Assignee is deliberately outside all three locks; it is workflow metadata, tracked
separately.

### 3.3 Attaching a screenshot

`attachScreenshotAnnotated()` (`screens/hotkeys.js:105-150`):

1. `resolveSiteTab({verb:'captured'})`. Not `ok` ⇒ the reason is toasted and the
   flow ends. **Nothing prompts here** — the only "no" is a restricted page.
2. `sendMessage({type:'captureTab', fullPage})` → the worker's `captureShot()` →
   JPEG q80 data URL + the captured `tabId`.
4. `CaptureAnnotate.annotateImage(dataUrl, tabId, {toast})`:
   - writes `{dataUrl}` to `chrome.storage.session` under a random
     `annotate-<uuid>` key;
   - **primary**: injects the overlay into that same tab;
   - **fallback**: opens `editor.html?annotate=<key>` in a new tab and toasts
     that the page cannot host the annotator;
   - the annotator writes back to the *same key* — `{resultDataUrl}` for Apply
     and for *Keep original*, `{cancelled:true}` for Discard — and the panel
     resolves off `storage.session.onChanged`. Closing the fallback tab with no
     write means *Keep original*.
5. `recordWriteLock()` **again**: step 4 is interactive and the run can
   finish under it, so the click-time gate is minutes stale by now. A refusal
   ends the flow — and it *keeps* the annotated image in the
   `pendingAnnotation` slot and unhides `#btn-save-annotation`, which writes it
   to disk (anchor + object URL, no `downloads` permission). The refusal is
   unchanged; only the loss is. That button is deliberately outside every run
   lock: it writes to the tester's own machine, never to the server.
6. `TestomatAPI.uploadAttachment(record.id, blob, …)` — JSON:API multipart,
   JWT, scope `testruns`. **Requires a result record**, which is why the button
   is disabled until a status has been set.

#### Attaching local files

`screens/attachments.js` sits next to that button and reuses step 5 verbatim —
a picked `File` *is* a `Blob`, so `uploadAttachment` takes it unchanged and
there is no second upload contract.

The button clicks a hidden `<input type="file" multiple>`; the `change` handler
snapshots the `FileList` and clears `input.value` immediately (so the same file
can be picked twice, and a duplicate event is a no-op). Files upload **one at a
time**: a failure toasts that file and the loop continues, and the status line
ends `N of M` when some failed.

`#attachment-list` shows the result's attachments — server truth from the
`attributes.attachments` of the JSON:API testrun detail `probeSession()` already
prefetched into `state.testrunDetail`, merged (de-duplicated by URL) with what
this panel session uploaded onto that record. Screenshots and the auto-attached
log therefore appear in it too. The gate lives with the screenshot's in
`updateTestActionsState()`: no result record, or — uploads being JWT-only — a
proven-degraded session.

### 3.4 The evidence (console + network) recorder

Rebuilt with **no `chrome.debugger` anywhere**. Chrome refuses that attach as
soon as any other extension has a frame in the page, which on a machine
running Jam or 1Password is *every* page — so the recorder is now in-page
instrumentation, the way Jam/LogRocket/Sentry do it.

Three parties: the worker (`evidence/recorder.js`) owns the buffer and the
protocol; `evidence/page-hook.js` runs in the page's own MAIN world; and
`evidence/relay.js` (ISOLATED) is the only one of the two with `chrome.runtime`.

```
panel  EVIDENCE_TOGGLE {tabId}
  → evStart: arm the session, then
      executeScript relay (ISOLATED) + page-hook (MAIN) into the current document
      registerContentScripts(<origin>/*, document_start) for every later load
  → page-hook patches fetch + XMLHttpRequest and console.error/warn, and listens
      for error (capture phase — catches failed <img>/<script> loads too),
      unhandledrejection, securitypolicyviolation
    ... batched ~200 ms → window.postMessage → relay → EVIDENCE_EVENTS
  → chrome.webRequest (onBeforeRequest/onCompleted/onErrorOccurred/onBeforeRedirect)
      covers the rest of the tab: the document, subresources, sub-frames,
      workers, websocket handshakes, redirect chains, and anything before the
      hook lands
  → both feed evPush() into the same ring buffer
```

**The split is the design.** `evWrOwns()` is the whole rule: `webRequest` drops
`type === 'xmlhttprequest'` from frame 0 once the hook has said `ready`, and
keeps everything else. So the two sources never describe the same request, and
there is no heuristic de-duplication — except one deliberate merge
(`evAdoptTwin`) for the millisecond in which the hook exists but its `ready` has
not arrived yet.

Why round that way: only the hook can read a **response body**, and only the
hook sees a `fetch` to a third-party host under a per-origin grant. Only
`webRequest` sees an `<img>` 404, the main document or a redirect.

**Uncaught rows.** An uncaught exception and an unhandled rejection never
go through `console.error`, so they carry their own kind — `exception`, labelled
`uncaught.error` in the list, the Attach snippet and the `.txt` — with
`source:line:col` (the `ErrorEvent` for a throw, the reason's own stack for a
rejection) and the first `STACK_LINES` frames instead of the whole dump. A
framework that logs an error *and* rethrows it would file two rows: the dedup
rule is `loggedAlready()` in the hook — an uncaught row whose first line (minus
the `Uncaught` / `Unhandled promise rejection:` prefix) matches a `console.error`
from the last second is dropped, and the console row stands.

**Bodies.** For failures only (status ≥ 400 or a network error), capped at 16 KB,
read off a `res.clone()` with the reader cancelled at the cap — a huge failed
download is never pulled into memory. Request bodies are never read. With
`settings.evidenceCaptureBodies === false` the hook does not read at all
and flags the entry `bodySkipped`; the details pane and the `.txt` log then print
"(body capture disabled)". The flag reaches the page through the relay, and the
hook **parks** any body read until that answer arrives, so an explicit OFF is
never lost to a race. The relay reads the mirrored top-level
`evidenceCaptureBodies` key: it runs in the tested page's renderer, and the
`settings` record it used to fetch also holds the API token.

Retention is the `settings.evidenceWindowSec` window (default 60 s, clamped
10–600); the buffer is pruned to 2× the window and hard-capped at 1000 entries,
mirrored to `chrome.storage.session` `evidenceMirror` every 2 s so a worker
restart mid-recording recovers. That mirror is a COPY — the buffer itself lives
in the worker — which is why erasing the storage area is not enough to get rid
of it: `EVIDENCE_WIPE` cancels the pending `evMirrorTimer`,
`evStop(false)`s the recording, and only then removes the key, so the removal is
the last write by construction (`evStop` ends in `evMirror()`, which is awaited
for exactly that ordering). Its callers are sign out and Forget on the active
instance — §5.1. A plain **Stop**
deliberately still keeps the last window: `EVIDENCE_SNAPSHOT`, the Attach button
and the auto-attached `.txt` all read the buffer *after* the recording ends, so
clearing it in `evStop` (L-4's literal wording) would delete the feature.
`evWindowEntries()` sorts by `ts` — the two sources arrive on different
latencies, so append order is not time order.
`EVIDENCE_LIST {errorsOnly:true}` is what the test view shows: console
error/warning plus non-2xx or failed requests (`evIsError`).

On FAIL with the recorder running, `uploadEvidenceLog()` (`screens/evidence.js`)
takes an `EVIDENCE_SNAPSHOT`, builds a readable `.txt` and uploads it as an
attachment, returning the URL for the `Console & network log` **meta** key (it
used to be appended to the comment). It now runs *after* the status write, so a
row that earns its testrun id only in that response is covered too; the old
ordering had to skip those tests.

**Muting, not un-patching.** A wrapper cannot be removed safely (other code may
have wrapped `fetch` after us), so stopping a recording mutes the hook
(`EVIDENCE_HOOK_OFF`), and a hook whose worker no longer knows it is muted by the
`{off:true}` reply to its own batch. The mute survives in a document that never
navigates — which is why starting a recording sends `EVIDENCE_HOOK_ON` before
anything else.

**What it costs.** Browser-generated console rows beyond what the listeners
recover are gone (deprecation notices), as are requests fired before the hook
lands on a page with no `document_start` registration, page-worker traffic,
WebSocket frames and foreign-frame traffic. Requests appear when they complete,
not while pending. The user guide carries this list for testers.

### 3.5 The step recorder

Three parties: the **editor page** drives it, the **worker** owns the state, an
**injected content script** produces the steps.

```
editor  STEPREC_START
  → srStart(): resolveSiteTab({verb:'recorded'}) → storage.session `stepRec` =
      { tabId, recording, paused, manualPause, capBonus, lastUrl, startedAt,
        blind, pendingOpen, entries: [], lastNavIdx, sent: 0 }
  → srInjectSync(tab.id) → executeScript(content/step-recorder.js)

page    click/dblclick/type/select
  → the packet is armed AT EVENT TIME and the entry queued; ~400ms later (#23)
    `ctx.after` is read and the entry leaves — one outbox, in arrival order
  → STEPREC_ADD {entry:{kind, text, action, name, context, ctx, replaces?}}
  → srAdd → srPopTwins (a dblclick supersedes its own clicks)
          → srFlushOpen (the deferred `Open <url>` first step) → srPlace/srPush
      cap = 50 (+ capBonus), overridable by storage.session `stepRecCap`
      at the cap the recording PAUSES and drops the action

page    Pause/Resume on the indicator → STEPREC_PAUSE {on}
page    + Expected on the indicator   → STEPREC_ADD {kind:'expected', manual:true}

tabs.onUpdated on the recorded tab
  → changeInfo.url  ⇒ an `expected` entry: The "<title>" page opens
  → changeInfo.title ⇒ srRefineNav rewrites that entry once a REAL title lands
  → status 'complete' ⇒ re-inject (a full load killed the script)

editor  STEPREC_PULL (poll, 500ms) → the same status PLUS the entries that are
        final — the editor appends them to the open test right there
editor  STEPREC_STOP → returns only what the last pull had not reached and clears
        the state; Stop itself just ends the recording
        …then, with `Polish with AI` on, ONE POST /prompts over the whole
        recording — the raw steps are already in the body (#23)
page    STEPREC_STATUS (the content script's own poll) → status alone, no entries
```

**Live insertion**. Each recorded action lands in the open editor as it
happens, so `sent` counts the entries already handed over and an entry may only
be handed over once it can no longer change here. Exactly two things still rewrite
the tail — a `dblclick` popping its own click twins (milliseconds) and
`srRefineNav()` rewriting a navigation entry when the real title lands (up to a
load) — so `srFinalEnd()` holds an entry for `SR_SETTLE_MS` (700), and a nav entry
awaiting its title for `SR_NAV_SETTLE_MS` (3000), after which the URL-derived title
stands. Past `sent` both rewriters give up (`srPopTwins`, `srRefineNav`): that line
belongs to the editor now, and only rewriting our own copy would fork the two.

**Polishing (#23, editor side)**. The `Polish with AI` switch (`storage.local`
`polishSteps`, default off, hidden when `jwtAvailable() === false`) changes
**nothing** about the insertion: every entry goes in raw, at once, exactly as it
did before the feature existed. What the editor keeps alongside the body is the
recording itself — `recEntries` (the entries, packets and all), `recStart` (the
index its first item took in the `### Steps` ordered list, counted BEFORE the
insert), `recCount`, and `recRawItems`/`recPolishedItems`, the two texts each of
its items has had.

`finishRecording()` drains the recorder, and *then*, with the switch on, sends the
whole recording in ONE `polishRecordedSteps()` call (30s cap, `setPolishTimeout`
in e2e) while the record button reads `Polishing…` and is disabled. The message is
`TEST:` / `PAGE:` (from the first entry that has a packet) / `EXISTING STEPS`
(items above `recStart`, omitted when there are none) / `RECORDED ACTIONS` — one
block per recorded step: `raw:` (the sentence the recorder wrote), `action:`,
`element:`, `value:`, `near:`, `after:`, `note:` (a manual expected that followed
it; the worker's auto nav line adds nothing, its change is already in `after`). An
entry with no packet — the deferred `Open <url>` — is still an action: `raw:` +
`action: open` + `after: url=<the url>`.

The answer's numbered items replace the recording's items **1:1 by index**
(`replaceRecItems()`): fewer items leave the tail raw, extras are dropped, and an
item whose current text is no longer what we last wrote there (`recWritten()`) was
edited by hand and is skipped. Success toasts `Steps polished ✓`; a failure keeps
the raw text and toasts once — a 422 in the **server's own words** (`error` /
`details` out of the JSON body), a 401/403 switches the feature off, hides it and
persists that.

`#tc-polish-btn` beside the switch is the same button both ways: `Undo polish`
right after a successful polish (back to `recRawItems`, 1:1, same skip rule), and
`Polish recorded steps` whenever the draft holds a recording that is not polished
— stopped with the switch off, the panel closed before Stop, or undone. Hidden
while recording, with no recording, with the switch off, and after Save.

Stop and the button share one lane (`runExclusive` / `recBusy`), which is also
what `recStopping` reports and what `save()` awaits (`settleRec()`) — Save must
never send the raw text a moment before the answer rewrites it.

**Two pauses, one dropped action**. `paused` is the cap's — `STEPREC_CONTINUE`
clears it *and* grants another cap's worth. `manualPause` is the tester's Pause on
the indicator, cleared only by Resume, so stepping out of the scenario never buys
50 more steps. `srPush()` drops entries under either (`background.js:116-123`), and
`srAdd()` returns *before* `srFlushOpen()` so a pause taken right after Start cannot
swallow the deferred `Open` step. A navigation during a manual pause is followed
(`lastUrl`) but not recorded.

**The context packet** (#23, `content/step-recorder.js`). Every action carries a
`ctx` alongside its sentence: `element` (tag, role, type, own text, aria-label,
title, placeholder, name, id, first 3 classes, icon), `near` (label, row, column,
section, heading, the texts either side), `page` (title + `origin+pathname`, the
env-meta trim), `value` for a type/select — **the masked noun, never the secret**
— and `after`, read ~400ms later: url/title change, a toast, dialog or validation
message ADDED in that window (one `MutationObserver`, armed at the action — a
node classed `alert`/`error`/`invalid-feedback`/`help-block`/`validation`, or an
`aria-invalid` control's own message, reads as the `dialog` half), the control's
own state change, and a nearby badge that moved. Every field is best-effort inside a
`try/catch`: a packet is never worth a lost step. Capped at ~1.5 KB of JSON
(`siblings` and `class` go first). Two consequences elsewhere: the entry now
leaves ~400ms late, so `pagehide`/`beforeunload` flush the outbox rather than let
a navigating click die with the page, and `srPlace()` in the worker puts an action
that lands right behind an auto-nav line back in front of it. The packet is built
whether or not the AI switch is on — it is also what lets a nameless control be
named by its row (`elementName(el, fallback, near)`).

**What the injected script recognizes** (`content/step-recorder.js`): buttons,
links, `summary`, the button-ish inputs, and the ARIA custom controls
(`[role=checkbox|radio|switch|tab|menuitem|menuitemcheckbox|menuitemradio|option]`)
— each with its own wording. Two rules keep one action at one step: a role
wrapper around a real `input`/`select`/`textarea` is skipped (the native `change`
path owns it), and a `dblclick` sends the exact click text it supersedes so the
worker can pop those trailing twins. The indicator's own events are excluded —
its shadow root is inside the page, so they compose out into `document`, and
every recognizer (click, dblclick, blur, keydown, change) bails on
`fromIndicator()`; without that, typing an expected result into the pill would
record itself as a step.

**What it refuses to record**. A typed value is masked when the
field's `type` is `password`, its `autocomplete` is one of the card / one-time-code
/ password tokens (spec prefixes `section-*`/`billing`/`shipping` stripped first),
the words it is named/labelled by hit `PASSWORD_WORDS` or `SENSITIVE_WORDS`, or the
value is 13-19 digits passing Luhn (any `\s`, NBSP included, or `-` between groups)
— that last one is the backstop, because the word list is best-effort by
construction and a card can be typed into a field called anything. Two rules keep
the list honest: every entry covers BOTH spellings `words()` can produce — it
splits `cardNumber`/`cc-num` into `card number`/`cc num`, but a run-together
lowercase `cardnumber` has no seam and arrives whole, which is what the optional
space in `card ?num(ber)?` is for — and `PASSWORD_WORDS` exists because a revealed
password is a `type=text` field (every show/hide eye button flips `type`). Its
entries are whole words so `passphrase` matches it and `passport` does not — the
latter is a government id, masked as "the value" by `SENSITIVE_WORDS` alongside
`ssn` and `tax id`, and calling it a password would be the wrong word. `isCardNumber()` is
deliberately narrower than the `card` entry: a Kanban `Card title` is masked, but
only a bag carrying `number`/`num`/`no`/`pan` too is CALLED a card number.
Masked steps read `Type the card number|the password|the value into the <field>
field` and the field remembers a SENTINEL, not the secret, so `lastTyped` still
collapses the Enter+blur pair without holding the value. Masking happens in the
CONTENT SCRIPT, before `send()`, so the live insert never carries a value
either. The Settings toggle `stepRecNeverValues` overrides all of it with `Type
text into the <field> field` — `maskedAllAs()`, whose one exception is a password
field, which keeps its noun because it is a certainty rather than a heuristic and
no value is written either way (no other noun survives, or ON would still leak a
hint at the content); it is read once per injection (plus a
`storage.onChanged` listener for a mid-recording save) and a step that beats that
read waits for it rather than assuming the default.

**Element context** (`contextOf()`). A name resolved from the control alone
("the checkbox") is useless in a list, and the surroundings cannot be
reconstructed later — so they are read at event time: the row/card
(`closest('tr, li, [role=row], [role=listitem]')` → its first heading / header
cell / cell / bold run, controls stripped), the section (a `fieldset` legend,
else the nearest preceding heading over a bounded 8-ancestor × 12-sibling walk,
never a full-DOM sweep) and the column (the matching `th` of a table with a real
header row). The column also slots into the naming chain ahead of `name`/`id` —
those are developer strings, a column header is what the tester reads. The step
text takes exactly ONE clause, row before section
(`Check the Bulk checkbox in the "Bolt Cutters" row`), and a clause that would
only repeat the control's own name is dropped.

**+ Expected**. An expectation is what the tester *looked at*, not a DOM
event, so the pill carries an input for it (recording only — a paused recorder
has no step to attach it to). It lives inside the shadow root, where no page CSS
reaches it; its keystrokes are stopped on the way out of the shadow root so the
page's own hotkeys never fire; and while it is open it OWNS the pill, because the
500ms poll's re-render would otherwise take the caret with it. Enter sends
`{kind:'expected', manual:true}` (counted by `srPush` exactly like a step), Esc
collapses. EVERY expected entry attaches to the step it followed as a
`- Expected: …` sub-bullet — the shape `screens/test-view.js` folds into that
step's inline chip — the tester's own and the automatic navigation ones alike
(a flat list of the latter read as duplicates whenever a recording passed
the same page title twice). That step is usually already in the body,
so `splitRecorded()` takes the batch's own steps first and falls back to
`leadSubs` on the last item of `### Steps`; the flat `### Expected` section is
left for what has no step to attach to at all — an expected recorded before the
first step of the recording (`editor/editor.js`).

**Blind state.** If `executeScript` throws while recording —
that means the recorded tab moved to a page Chrome keeps extensions
off — the recorder goes deaf *and* `tabs.onUpdated` stops carrying
`changeInfo.url`, while the editor still shows a live recording. Rather than
swallow that, `srInjectSync()` sets `st.blind = true`; `blind` rides along on
`STEPREC_STATUS` so the editor's existing poll can warn and name the fix (go back
to the site under test). The recording is left running: the next inject that
lands — `tabs.onUpdated`'s `complete` on the way back — revives it, and
`srCatchUpNav()` then emits the one navigation entry that is true, the page open
*right now*, rather than inventing the hops it missed.

Neither recorder uses `chrome.debugger` any more, so they run in parallel
with each other **and** with an open DevTools; the only per-tab debugger session
left in the extension is the one a screenshot takes and immediately gives back.

> The `stepRec` shape comment at `background.js:115-118` lists a `needsReinject`
> field. Nothing writes or reads it — the shape above (from the constructor at
> `:247-251`) is the real one. Don't go looking for the logic behind it.

---

## 4. The permission model (install-time `<all_urls>`)

Tester-facing version: user guide §"Site access: allowed everywhere from install".

`manifest.json:30-31`:

```json
"permissions":  ["storage", "sidePanel", "debugger", "scripting", "webRequest"],
"host_permissions": ["<all_urls>"]
```

Three things are deliberately absent and must stay absent:

- **`optional_host_permissions`** — nothing is requested at runtime any more.
- **`activeTab`** — it existed only to make the toolbar click a grant. Both
  things that used it are satisfied by the host permission alone:
  `captureVisibleTab` and `executeScript`.
- **`tabs`** — host access already reveals `url`/`title` for the tab we are
  acting on. Adding `tabs` would hand us every open tab's address for nothing.

> `chrome.tabs.query` still returns a tab's `url` only where we hold host access,
> and `<all_urls>` does not cover `chrome://`, the Web Store or another
> extension's pages. **A hidden url therefore means a restricted page** — the one
> verdict a tester can act on, and never "not granted yet".
> (`shared/site-tab.js:6-13`.)

**Why this model.** The per-origin one failed on its own terms: `activeTab`
is per-tab and dies on the next tab switch, and the only permanent grant was a
12-second toast that fired in two flows and once per origin ever — miss it and no
UI path remained. Jam 5.76.1, Tango 8.9.3 and Loom 5.5.204 (manifests pulled from
the Web Store and read) all ship `<all_urls>` at install and have no runtime grant
UX at all. A tester who wants less narrows it in `chrome://extensions` → *Site
access*, which is Chrome's own surface and always available — the panel keeps
working and simply reports what it cannot touch.

**Deployment.** Adding a *required* host permission disables an extension for
every existing Store user until each re-approves. This landed BEFORE the first
Store publication precisely to avoid that; unpacked installs apply it silently.
The per-permission justification lives in [`PRIVACY.md`](../PRIVACY.md).

**One consequence worth knowing.** `evidence/recorder.js` registers its
four `chrome.webRequest` listeners at load with `urls: ['<all_urls>']`, and Chrome
delivers webRequest events only for hosts the extension holds. Under the old
manifest that meant app.testomat.io plus whatever the tester had granted; now it
means **every request in the browser wakes the service worker**, where
`evWrOwns()` drops all but the recorded tab's. Nothing is stored and nothing
leaves — but it is a real wake-up cost, and the listeners cannot simply be
narrowed: an MV3 worker only re-attaches listeners registered synchronously at
top level, which is what keeps a recording alive across a worker recycle
(`evidence/recorder.js:210-221`). Narrowing it to the recorded tab needs a
start/stop re-registration plus a restore path, i.e. its own design pass.

### 4.1 `resolveSiteTab({verb})` — three states

`shared/site-tab.js`. It resolves the active tab of the window hosting the caller
(`windows.getCurrent`, falling back to `lastFocusedWindow` — the side panel is
per-window) and returns:

| `state` | Means | The copy the user sees |
|---|---|---|
| `ok` | http(s) tab whose url we can read. Carries `tab` and the port-less `origin`. | — |
| `system-page` | A page extensions are kept off: the url is hidden (`chrome://`, the Web Store, another extension) or readable but not http(s) (`devtools://`, `file://`, …). | *"Chrome doesn’t allow extensions on this page (chrome://…, the Web Store, another extension’s page), so it can’t be `<verb>` — switch to the site under test."* |
| `none` | No active tab, or no extension context. | *"No active tab — focus the site under test"* |

`verb` ("captured" / "recorded" / …) is the only thing a call site tunes. The
copy names no gesture on purpose: there is no click that could change the answer.

**Window mode is the exception in `activeTab()`.** With the panel in a
popup window of its own, `windows.getCurrent()` IS that popup and its only tab is
the panel document — every capture and every recorder would target the panel. So
the panel's own window is skipped (`ViewMode.isPanelWindow`) and the question goes
to the most recently focused NORMAL window: the id the worker tracks, else
`windows.getAll()` filtered to `type: 'normal'` (focused first, newest after).
A normal window is never the panel's, so side-panel mode keeps exactly the old
one-query path.

### 4.2 What is left of the old machinery

Nothing that prompts. `ensureSiteAccess()` (`shared/site-access.js`) is a thin
`{ok, error}` shape over `resolveSiteTab()` for the editor's two call sites, and
that is the whole file. Deleted with the permission rework, and not to be reintroduced:

| Gone | Was |
|---|---|
| `ensureOriginAccess(url)` | the `contains → request` flow behind the Settings instance save and the "Always allow" button, with its user-gesture rule |
| `SiteAccess.offerAlwaysAllow` + `alwaysAllowOffered` | the one-time permanent-grant toast, burn-listed per origin |
| `core/site-resume.js` | the pending-action registry that replayed a blocked feature on the grant signal |
| `SITE_ACCESS_GRANTED` + `chrome.permissions.onAdded` listeners | the two signals that drove that replay |
| `srRecover()` | the worker-side retry those signals called; the blind recorder now revives on `tabs.onUpdated`'s `complete` alone |
| Settings → *Allowed websites* (+ its CSS and the `toast-action` button) | the only UI that could take a grant back; `chrome://extensions` → Site access is that surface now |

### 4.3 Two capture paths

`chrome.tabs.captureVisibleTab` requires `<all_urls>` or `activeTab` — a
per-origin host grant does **not** satisfy it (Chrome: *"Either the
'\<all_urls\>' or 'activeTab' permission is required"*), which is why the old
model could not use it at all. It is held now, so:

- **Viewport** (`fullPage: false`) → `captureVisibleTab`, JPEG q80. No debugger,
  no *"…is debugging this browser"* infobar. If Chrome refuses it — an inactive
  tab, the per-second capture quota — `captureShot()` falls through to the
  debugger rather than losing the shot.
- **Full page** (`fullPage: true`) → `chrome.debugger` + `Page.captureScreenshot`
  with `captureBeyondViewport`, on a temporary attach released in the same
  `finally`. This is the only thing that raises the infobar now.
- A debugger failure rejects, it never downgrades — with **one** exception, the
  refusal of §9 rake 10, which no retry can ever clear. There `captureShot`
  calls `captureVisibleTab` for a viewport shot and flags the response
  `viewportOnly`, so a "Full page" request is told it was cropped. That rescue is
  always available now, so the honest *"another extension has a frame…"* error is
  only reachable when the rescue itself is refused too.
- `captureBeyondViewport` is not the only difference between the two capture
  modes any more. The full-page shot first reads
  `Page.getLayoutMetrics` and passes `cssContentSize` back as an explicit
  document-relative `clip` (`scale: 1` — the clip scale MULTIPLIES the device
  scale, so a healthy capture is byte-identical to the older one). The clip
  is a fence: the surface can hold exactly one page, so nothing the renderer
  re-measures mid-capture can append a second copy. `trimToDocument` then
  backs it up — a shot still taller than the measured document is cut to it in
  the worker (the reported symptom was the page rendered TWICE, stacked), and
  the response carries `trimmed` when that happened. A healthy shot is
  returned by identity, never re-encoded; no metrics means no clip and no
  guard, i.e. exactly the older behaviour.

---

## 5. Storage

Three areas, plus page-level `sessionStorage`. Nothing is ever written to
`chrome.storage.sync`.

### 5.1 `chrome.storage.local` — survives a browser restart

| Key | Shape | Written by |
|---|---|---|
| `settings` | The **active** instance plus its preferences: `{baseUrl, apiToken, projectId (resolved from the token's project list, never typed), envInfoOnFail, envFullUrl, evidenceWindowSec, evidenceAutoAttach, evidenceCaptureBodies, stepRecNeverValues}` (`screens/settings.js` `saveSettings()`) and `fullPageCapture` (`screens/test-view.js:419`) | `screens/settings.js`, `screens/test-view.js:431` |
| `evidenceCaptureBodies` | The body-capture boolean ALONE, mirrored from the active `settings` on a save and on a recording start — the in-page relay reads this key, never `settings`, which holds the API token | `screens/settings.js`, `screens/evidence.js` |
| `stepRecNeverValues` | The recorder's never-record-values boolean ALONE, mirrored from the active `settings` on a save — the injected `content/step-recorder.js` reads this key, never `settings`, for the same reason as the row above. Absent -> OFF, i.e. values are recorded with masking applied | `screens/settings.js` |
| `polishSteps` | The test editor's **Polish with AI** switch (#23), its OWN top-level boolean — it belongs to this browser, not to the instance's `settings`, and is written the moment the switch moves (a 401/403 from `/prompts` writes `false` and hides it). Absent -> OFF | `editor/editor.js` |
| `hostSettings` | `hostname → its saved settings object` — switching instances restores that host's token/project/prefs with no re-entry | `core/storage.js:22`, `screens/settings.js:295` |
| `hostHistory` | Hosts used before, most-recent-first, deduped (the Instance dropdown) | same |
| `session` | The restorable panel session: `{view, activeTab, tabViews, runId, runTitle, currentRecordId, stepTicks, expandedGroups, runsFilter}` (`core/storage.js:35-47`) | `persistSession()` |
| `offlineQueue` | `recordId → {recordId, runId, status, comment, queuedAt}` — status writes waiting for connectivity | `screens/offline-queue.js:48` |
| `onboarding` | `{token, project, run, dismissed}` — the welcome checklist | `screens/onboarding.js:19` |
| `viewMode` | `'sidepanel' \| 'window'` — which surface the panel opens in. A fact about this browser like `theme` below: not in `settings`, committed on the header control's click, mirrored onto Chrome's `openPanelOnActionClick`, and carried back across `signOut()`'s `clear()` | `shared/view-mode.js` |
| `theme` | `'system' \| 'light' \| 'dark'` — the Appearance switch. One of the two keys here that are neither a credential nor scoped to one: it is a fact about this browser, so it is **not** in `settings` (which is per-host and committed by Save & validate), it commits on the click, and `signOut()` carries it back across `clear()` | `shared/theme.js` |

There is no `chrome.storage.sync` or `chrome.storage.managed` use anywhere.
`localStorage` is used for **exactly one thing**: `shared/theme.js` mirrors the
`theme` key into it, because `chrome.storage` answers a tick later than the first
paint and the head script has to pin the scheme synchronously. The mirror is
never the authority — the `chrome.storage.local` read that follows it overwrites
whatever it said, which is also how an absent key (a fresh profile, a wiped one)
lands back on `system`. (An earlier `settings` also carried `newTcTemplate`, the
local New-TC markdown blob; new tests are now seeded from the **project's own**
templates, so nothing about them is stored on the client.)

The one-time `migrateHostSettings()` (`core/storage.js:14-27`) folds a
pre-rework single `settings` into `hostSettings` for its own host. It is
idempotent.

`dropAiApiKey()` (`core/storage.js`, called from `app.js` boot) removes the
`aiApiKey` an install may still hold from before that feature was removed. The
AI polish is gone, so
that key is a live secret with nothing left to read it — deleting it at every
boot IS the migration, and it is a no-op on a profile that never had one.

`persistSession()` refuses to write while `state.booting` is true or before
settings exist — a fire-and-forget write from a transient first load would
otherwise resurrect a phantom session.

The table also has an **exit**, which it never had before: nothing
removed a saved token, so uninstalling was the only way off a machine.
`forgetInstance()` (`screens/settings.js`) drops one host from `hostSettings` +
`hostHistory`, and — when it is the active one — `settings`, `session` and
`offlineQueue` with it, plus the whole of `storage.session`; `signOut()` calls `clear()` on `storage.local` **and**
`storage.session` (§5.2 holds the recorded steps, the evidence buffer and the
screenshot hand-offs, and survives everything but a browser restart), a whole-area
wipe rather than a key list because the finding was that a forgotten key kept a
live credential. Two keys are carried back over that wipe: `theme`
(`shared/theme.js`) and `viewMode` (`shared/view-mode.js`) —
neither a credential nor scoped to one, and both re-written after `clear()`
rather than exempted from it, so the whole-area wipe stays whole.
The sign out first attempts `EVIDENCE_WIPE` (§3.4): the
evidence buffer lives in the worker, so a recording still RUNNING would re-mirror
it over the clear ~2 s later. A missing listener is tolerated — no
worker, no recording. A refusal or a 5 s timeout does NOT abort the sign out,
though: a token is standing access to the project and the buffer is logs, so both
areas are cleared anyway and the recorder failure is reported after. Because the
erase did happen, the panel still cold-boots to first launch, and the reason
rides a one-shot page-`sessionStorage` breadcrumb (`signOutRecorderWarning`,
§5.4) that `fillSettingsForm()` paints onto `settings-forget-status` — a status
line set before `reloadPanel()` would die with the document.
A later change gave `forgetInstance()` the same two steps for the ACTIVE instance only —
`EVIDENCE_WIPE` first, then `storage.session.clear()` — because that area is
scoped to no instance but the panel is being reset anyway, and it holds the
recorded steps, the evidence buffer, unsaved editor drafts and pending screenshot
hand-offs. Forgetting an INACTIVE instance touches neither: that data belongs to
the session the user is still in. The failed-wipe warning is shared (`lead` names
the erase that did happen — "Signed out" / "Instance forgotten"), and the whole
message, not just the reason, is what rides the breadcrumb. Storage is written FIRST and
in-memory state follows only on success, so a rejected write reports itself on a
status line instead of leaving a half-erased panel — `settings-forget-status` for
a Forget, `signout-status` for a Sign out, which the redesign gave its own line so
the failure is not reported inside the collapsed Advanced fold. Both then
`location.reload()`, a cold `init()` being the only way to be sure no module kept
an in-memory copy of what was deleted.
`state.booting` is set over the erase to quiet `persistSession()`, but it is no
barrier — the guards are read at call time, so a dispatched `set({session})` can
still land after the wipe. Credential-free, and inert once the reloaded panel is
unconfigured.

### 5.2 `chrome.storage.session` — cleared on browser restart

| Key | Owner | Holds |
|---|---|---|
| `stepRec` | `background.js:101-104` | The canonical step-recording state (see §3.5). Session on purpose: an SW restart keeps it, a browser restart drops it. |
| `evidenceMirror` | `evidence/recorder.js` `evMirror()` | `{session, buffer, windowSec}` — the recorder's throttled mirror so an SW restart recovers. A COPY of the worker's buffer, so removing the key is not enough on its own: `EVIDENCE_WIPE` stops the recording first (§3.4). |
| `viewPanelWindowId` | `shared/view-mode.js`, written by `background.js` | The panel's own popup window. One panel, not a stack: the next icon click focuses it. Removed when the window closes. |
| `viewNormalWindowId` | `shared/view-mode.js`, written by `background.js` `windows.onFocusChanged` | The last focused NORMAL window — where the site under test is. What `activeTab()` resolves against in window mode (§4.1); `windows.getAll()` is the fallback when it is missing or stale. |
| `annotate-<uuid>` | `shared/capture-annotate.js:75,102` | The screenshot handoff; the annotator overwrites the same key with `{resultDataUrl}` or `{cancelled:true}` (`overlay/annotate-overlay.js:145,149,154`, `editor/annotate.js:50`). |
| `editorDraft:suite:<id>` | `editor/editor.js` `editorDraftKey()` / `persistDraftNow()` | `{title, markdown, priority, suite, ts, params?, recording?}` — an unsaved NEW test in panel context. `recording` (#23) is `{entries, start, count, polished, rawItems, polishedItems}` — the recording the editor was holding, so a reopened panel can still polish it (or put it back) even though the steps are already in the body. Creation-only: an existing test is read-only, so it can never be dirty. |

⚠️ The worker calls
`chrome.storage.session.setAccessLevel({accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS'})`
(`background.js:44`) so the injected annotator overlay can read its handoff key.
That opens **all** of `storage.session` to **every** content script in every
page for the life of the browser session — the other three keys inherit that
trade silently.

### 5.3 e2e-only hooks (production code paths)

Three keys in `chrome.storage.session` that production code branches on. They
are live code in the shipped extension, not a test-only build:

| Key | Effect | Read at |
|---|---|---|
| `stepRecCap` | Overrides the 50-step recorder cap | `background.js:135` |
| `pollInterval` | Overrides the 20 s live-sync tick | `screens/livesync.js:25` |
| `forceWriteFail` | `null \| 'network' \| 'auth'` — synthesises a real `ApiError` inside the status-write path so the offline-queue enqueue is exercised deterministically | `screens/offline-queue.js:162`, consumed at `screens/test-view.js:497-498` |

Plus the `STEPREC_PEEK` message (§2.1), which has no production sender.

Nothing writes these keys in normal use — the e2e suite that does is maintained
in the private working repo. If you
add a hook, follow the same shape: read from `chrome.storage.session`, fall back
to the production default, and say so in a comment.

### 5.4 Page `sessionStorage`

`tcReturn` — a one-shot `{suiteId, suiteTitle}` breadcrumb written by
`openEditor()` (`screens/tc-studio.js`) and consumed by `app.js:86-92`, so
returning from the test page lands back on the right suite's TC list. Panel
document only. It exists because the panel *navigates away* to that page rather
than embedding it — the panel document is destroyed and rebuilt.

`signOutRecorderWarning` — a one-shot reason string written by `signOut()` when
the `EVIDENCE_WIPE` failed and consumed by `fillSettingsForm()`
(`screens/settings.js`), for the same reason: the erase succeeded and the panel
reloads, so the warning has to outlive the document that raised it. Not one of
the areas sign out erases, carries no credential, and dies with the browser —
which is also when an un-erased `storage.session` buffer dies.

---

## 6. The two API legs: v2 token vs JWT JSON:API

`extension/api.js` is the single client. It speaks **two protocols to the same
instance**:

| | Public API **v2** | Web **JSON:API** |
|---|---|---|
| Base | `{baseUrl}/api/v2/{projectId}` | `{baseUrl}/api/{projectId}` (project) and `{baseUrl}/api` (root) |
| Auth | the raw account General token as `Bearer` | a **JWT** from `POST /api/login` with `{api_token}` |
| Shape | flat `snake_case` | dasherized JSON:API documents |
| Entry points | `request()` / `pagedData()` | `jwtRequest()` / `jwtRequestRoot()` / `uploadTo()` |

**v2 leg** (always available once configured): list/get runs, rungroups,
testruns, tests; **set a test status** (`setStatus`); suite/folder and TC
creation (TC Studio); the run checklist. This is why the core run loop keeps
working with no session. The suite **tree** moved off this leg (below).

**JWT leg**: tri-state server-persisted steps (`setStep`), priority, substatus
(`setSubstatus`/`clearSubstatus` — the options come from the project's
`run-replies`; the run's per-value counters from `getRunInfo`, i.e. the JSON:API
run detail's `substatuses-counts`, which v2 does not serve — the same read also
returns the four **Run info** fields v2 omits, `ci-build-url` / `duration` /
`launched-at` / `finished-at` — plus whoever the payload names as the
run's executor/creator, read defensively across the shapes a person can arrive
in (`runPeopleOf`) and simply absent when it names none),
assignee (`assignTestrun`, `listProjectUsers`), `finishRun`,
the **dashboard** runs list (`fetchDashboardPage` + group children/nested/
subgroups), the **suite tree** (`getSuiteTree` → `GET /suites/tree` — the
server builds it; the Tests tab and the "New test" picker share that one read),
the header project switcher (`listProjects`), the project's **New Test
templates** (`listTemplates`), a test's **parameters and example rows**
(`getTestParams` / `setTestParams` / `createExample` / `updateExample` /
`deleteExample` — v2 serializes neither, so the editor's grid and the view's
table hide themselves in basic mode), the reported-result **summary** of an open
test (it reads the detail `probeSession` prefetched, plus a lazy
`GET /testruns/{id}/steps` for an automated row), the recorder's **AI polish**
(`polishRecordedSteps` → `POST /prompts` with `prompt: 'polish_recorded_steps'`,
the answer's `data.polished_steps` being the rewritten section — #23), and
**every upload** (`uploadAttachment` / `uploadTestAttachment` — the v2
attachments route is not deployed on prod).

`listTemplates(kind)` carries two server quirks worth knowing before touching it
(`Api::TemplatesController#index`, verified live): `?kind=` **falls back** to
every standard kind when nothing matches it — so the kind is re-checked client-
side — and `attributes.document` (the recombined body) is only ever filled when
a linking record id is passed (`?test_id=`, `?suite_id=`, …). A test being
created has none, so `attributes.body` is what seeds the editor.

The JWT is **memory-only** (`api.js:8`) and `configure()` resets it, so every
panel reload costs one `POST /api/login` and passes through `'unknown'`.
`jwtSend()` re-logs in and retries once on **both** 401 and 403 (an expired JWT
answers 403 per contract).

### 6.1 `jwtAvailable()` is a tri-state — do not coerce it

`api.js:11` — the string `'unknown'`, or the booleans `true` / `false`:

- `'unknown'` — no login attempt yet. Features that would flash hide themselves:
  `updateRunActions()` hides the Finish button entirely on `'unknown'`
  (`run-view.js:139-149`).
- `true` — session available, full mode.
- `false` — degradation is **proven**. Only then does the panel show the
  `jwt-hint` and the degraded banner (`core/views.js:74-87`), because saying
  "basic mode" before a failed login would be a lie.

`document.body.dataset.jwt` is set to `available` / `degraded` / `unknown` by
`applyCapabilities()` (`core/state.js:137-143`) and CSS keys off it.

⚠️ `capabilities.jwt` is a **derived boolean** with three independent writers —
`probeSession` (`core/state.js:152`, on test open), `probeRunSession`
(`run-view.js:122`, on run open) and `loadRuns` (`runs-list.js:64,69`) — each
calling `applyCapabilities()`. There is no subscription; read
`capabilities.jwt` directly. Comparing `jwtAvailable()` loosely, or coercing it
to a boolean, silently breaks the `'unknown'` behaviour.

### 6.2 What degrades in basic mode

Steps become local-only checkboxes (`state.stepTicks`, per record id) instead of
tri-state server-synced rows; Finish run is visible-but-disabled with a reason;
priority, custom status and assignee are unavailable (the in-test select, the
run-row pill and the run header's counters go together); the reported-result
summary of an already-reported test is absent; the runs list falls back
from the dashboard union to plain v2 runs + rungroups; screenshots and evidence
logs cannot upload. Setting statuses and comments keeps working — that is the
whole point of the split.

---

## 7. The `chrome.debugger` session: one screenshot at a time, and nothing else

The extension attaches a debugger in exactly **one** place —
`captureShot()` in `background.js`, and only for a FULL-PAGE shot —
detaching in the same `finally`.
The evidence recorder used to hold a long-lived session and share it with the
capture; it no longer holds one at all. Consequences:

- Chrome's *"…is debugging this browser"* infobar blinks for the length of a
  screenshot. It no longer stands for a whole recording.
- Opening DevTools on the recorded tab is now a **non-event** for recording. It
  still blocks a screenshot while it is open, because DevTools holds the tab's
  debugger.
- The e2e suite MAY `Target.attachToTarget` a recorded tab — a scenario does
  precisely that, to prove the point. A tab that is being *captured* is still a
  different matter.
- A second consumer of CDP must do its own temporary attach/detach, and must not
  hold the session across an await it does not control.

---

## 8. Live sync and the offline queue

**Live sync** (`screens/livesync.js`) is a **20 s poll**, not a push. It refetches
the same v2 `listTestruns` payload the run view already loads, so it works in
basic mode. Remote-wins diff keyed by record id, repainting changed rows in
place; it never touches the comment draft or local step ticks. Ticks self-gate
on view + `document.visibilityState`, pause while the tester's own write is in
flight (`syncBeginWrite`/`syncEndWrite`), and park permanently on a poll
401/403 until the next `openRunView`. A locally queued status counts as an
own-write, so the queue wins over a remote snapshot. Under a session the tick
carries **one extra read**: the run's custom-status counters, which live
on the JSON:API run detail and not in the rows — a colleague's substatus write
moves no status, so the header would never catch up otherwise. It is
best-effort, so it can neither park the loop nor blank the numbers.

True ActionCable push is **blocked on product-server work** — see §9, rake 4.

**Offline queue** (`screens/offline-queue.js`) catches a network error or a
transient 401/403 on a *status write only*, keeps the optimistic local status,
persists the entry in `chrome.storage.local` and replays it on the next panel
open / run open / successful poll tick / `online` event. Assign, custom status,
finish, steps and attachments still fail honestly. It drains from the **panel
only** — a closed panel means the queue waits. One entry per record, newest
click wins. The queued `comment` is the **raw tester text** — which is
all the message ever holds. Replay goes back through `writeStatus`, so the env
meta keys are collected at replay time, not frozen at click time. Before replaying
it re-checks each target run's write lock and drops what it must not write —
see §3.2b.

---

## 9. Known rakes

These are the ones that will bite first.

**1. Script load order is the dependency graph, and nothing enforces it.**
`sidepanel/index.html:399-424`. Every top-level `const`/`let`/`function` in
those files shares one scope. `core/state.js` must precede anything touching
`state`; `app.js` must stay last. There is already one module reading a binding
declared in a *later*-loaded file — `run-view.js:179,181` reads `stepWriteChain`,
a top-level `let` at `test-view.js:233` — which is safe **only** because it never
runs during load. Reorder those two tags and it becomes a temporal-dead-zone
`ReferenceError`. Add new files at the end of the list, before `app.js`.

**2. `runsFilter` vs `runFilter` — one letter, two different things.**
`state.runsFilter` is the **runs-list** chip (`all|running|passed|failed|
scheduled|terminated`) and it **is persisted** in the `session` object.
`state.runFilter` is the **run-view** chip (`all|passed|failed|skipped|untested`)
and it is in-memory only, reset when a DIFFERENT run opens (re-opening the one on
screen keeps chip, search and folding). Same trap for `runsSearch`/`runSearch` —
and `runsSearch` now outlives leaving the runs list too, cleared only by a project
switch. Grep before you touch either.

**3. Record id is not `test_id`.** Rows are keyed by testrun **record** id
throughout — a parametrized test case has one record per example row and they
all share `test_id` (`core/state.js:27-30`). `recordFor()` compares stringified
because ids cross the session boundary as numbers or strings. Every diff, cache
and repaint in `livesync.js` and `run-view.js` keys on record id.

**4. Real-time push is not available, and it is not your bug.** Live sync is a
20-second poll on purpose. ActionCable from an extension is blocked by **two**
product-server facts, both verified against a live instance: the production
origin allowlist rejects a WebSocket handshake from
`chrome-extension://<id>` before auth ever runs, and `/cable` authenticates via
the Devise/Warden **cookie** only, which an extension WS cannot reliably present.
It is open and blocked on product-server work. Do not spend a day rediscovering
this.

**5. `jwtAvailable()` is a tri-state.** See §6.1. `'unknown'` is not `false`.

**6. `setPanelBehavior({openPanelOnActionClick: false})` + the `action.onClicked`
handler are one unit.** `background.js:9-20`. The value is persisted per
installation, so an install that once stored `true` must be overridden on every
worker start; with it off the handler is the only thing that opens the panel.
That is all the click does — it grants nothing.

**7. `chrome.storage.session` is readable by every content script.** §5.2. Do
not put anything in it you would not hand to an arbitrary page.

**8. The HTML sanitizer is the only XSS boundary — and there is now exactly one
copy.** `shared/html-sanitize.js`, used by `test-view.js:153` and the test
page's `renderPreviewInto()` (the Preview tab AND the read-only view). Both feed
`showdown` output into a live document, and TC content is authored in
Testomat and can carry raw HTML. It was two verbatim
copies until cycle D. Do not re-inline it. It is a drop-list, so it is only
half the boundary: `manifest.json`'s `content_security_policy.extension_pages`
is what stops the markup it deliberately keeps — an `<img>` or a
`<video src>` planted in a test description — from reaching a third party. It
opens with `default-src 'none'`, so a channel nobody enumerated (media, fonts)
is closed rather than open; `connect-src` carries `data:` because the panel, the
editor and the worker `fetch()` their own screenshot data URLs.

**9. Chrome's own *Site access* UI cannot be automated.** Nothing tests it. If
you change `shared/site-tab.js`, `shared/site-access.js` or the
`action.onClicked` handler, **check it by hand in a real Chrome with the
extension set to "On click"** — that is the one state nothing else covers.

**10. Another extension's frame on the page kills `chrome.debugger` — and it
reads like a permission bug.** Measured directly: when any other
extension has a frame in the tab (an overlay, a sidebar, a widget), Chrome
refuses the attach with *"Cannot access a chrome-extension:// URL of different
extension"* even though the tab is an ordinary `https://` page we hold access to.
Attaching by `targetId` is refused identically, an **already-open** session
starts failing the moment such a frame appears, and both work again once it is
gone. `chrome.scripting.executeScript` is unaffected (foreign frames are simply
skipped), so neither the step recorder nor the evidence recorder
sees this: that immunity is exactly why the recorder was rebuilt on injection.
`resolveSiteTab` answers `ok` throughout — the tab really is the site tab — so do
not go looking in the tab resolution: `dbgError()` (`background.js`) is the one
place the refusal is translated, and the screenshot is now its only victim.

---

## 10. Where to make a change

| You want to change… | Start here |
|---|---|
| A new API call | `extension/api.js` — and first verify the endpoint against the product's own source, then curl-smoke it, before any UI code depends on it. |
| The runs list (filters, groups, URL paste) | `sidepanel/screens/runs-list.js`; remember the two modes, `dashboard` (JWT) and `v2`. |
| The run checklist, suite sections, Finish run, the run-row custom-status pill + header counters | `sidepanel/screens/run-view.js`. |
| Steps, priority, substatus, assignee, the status write | `sidepanel/screens/test-view.js`; `writeStatus()` is the single writer. |
| The status write's side effects (env meta, evidence log, queue) | `core/env-info.js`, `screens/evidence.js`, `screens/offline-queue.js` — all hang off `writeStatus`. |
| Anything that touches the page under test | `shared/site-tab.js` first. Never hand-roll a `tab.url` check. |
| A screenshot / annotator change | `background.js` `captureShot` → `shared/capture-annotate.js` → `shared/annotate-core.js` (engine) → `overlay/annotate-overlay.js` (on-page) or `editor/annotate.js` (fallback tab). |
| Reading or creating a TC | `editor/editor.js` (`renderView()` / `renderEditor()`); a separate document that reuses the panel's globals. |
| A new panel screen | Add `sidepanel/screens/<name>.js`, a `<section id="view-<name>">` in `index.html`, an entry in `views` (`core/state.js:8`) and `TAB_OF_VIEW` (`core/views.js:12-16`), and the `<script>` tag before `app.js`. |
| A new persisted field | Decide `local` vs `session` (§5), then update `core/storage.js` **and** §5 of this file — that table drifts first. |
