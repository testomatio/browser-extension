# Testomat Run Panel — user guide

A Chrome side panel for running Testomat.io **manual runs** next to the site
under test. You read the steps, tick them off, set passed/failed/skipped, add a
comment, an annotated screenshot and a console/network log — without leaving the
tab you are testing.

This is the single entry point. Read part 1 and 2 before the first run; the rest
is reference.

Contents:

1. [Install and update](#1-install-and-update)
2. [Quick start](#2-quick-start)
3. [Feature guide by tab](#3-feature-guide-by-tab)
4. [Limits and quirks](#4-limits-and-quirks)
5. [What it does NOT do](#5-what-it-does-not-do)
6. [Where to report a problem](#6-where-to-report-a-problem)

---

## 1. Install and update

The extension is **not** in the Chrome Web Store. You install it from the repo
as an unpacked extension.

### Install

1. Clone the repo:

   ```
   git clone https://github.com/testomatio/browser-extension.git
   ```

2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the **`extension/`** folder inside the
   clone — not the repo root.
5. Pin the panel: click the puzzle-piece (Extensions) icon in the toolbar and
   pin **Testomat Run Panel**.

Chrome asks for the extension's permissions once, at load: it works on **all
websites**, because the site you test is different every session (see
[site access](#site-access-allowed-everywhere-from-install)). There is nothing to
grant per site afterwards.

### Connect it to your project

1. Click the **Testomat Run Panel** icon in the toolbar. The panel opens on the
   right.
2. You land on **Settings** — the other tabs stay disabled until the connection
   is saved.
3. Fill in **Connection** — one field:
   - **General token** — starts with `testomat_`. The link
     *"Find it in Account → Access Tokens"* under the field opens the
     access-tokens page of the instance you are pointed at.
4. Click **Save & validate**. The panel makes a live call, loads every project
   that token reaches and picks one; on success the status line reads
   `Connected ✓` and you land on the **Runs** tab.
5. Working on a different project? Use the **Project** row at the very top of the
   panel — see [switching projects](#switching-projects).

If the token is not accepted the status line says so and names the host
(*"Token rejected by app.testomat.io — create a new General token there and save
again"*). Nothing is changed until a save succeeds, so a bad paste never breaks
the connection you already had.

That is it for app.testomat.io — the instance is already filled in for you.
Self-hosted? Open **Advanced** at the bottom of Settings (it is folded away
behind its heading) and put your own `https://` URL in **Instance** before
saving. Nothing to approve — the extension already reaches every host.

### Switching projects

The **Project** row sits under the panel title and is there on every tab. Click
it and a list of every project your General token reaches drops down — start
typing to filter it (the box matches both the project name and its slug), move
with ↑/↓, pick with Enter or a click, and `Esc` closes it without changing
anything. Picking one repoints the whole panel at it:

- an open run or test closes (you land on that tab's list),
- the runs list and the test tree reload for the new project,
- the choice is remembered — reopening the panel comes back to it.

Nothing you had open in the old project is carried over, on purpose: a row or a
suite from another project would be a wrong-project write.

Per instance, per token: the project list belongs to the instance in
**Advanced**. Point the panel at another host and you authorize there again —
a token from one instance means nothing on another.

### Update

1. `git pull` in the clone.
2. Open `chrome://extensions` and click the **reload** (↻) icon on the Testomat
   Run Panel card.
3. Reopen the panel.

Your settings and the offline queue survive the reload.

---

## 2. Quick start

Zero to a first passed test, shortest real path:

1. Open the site you are testing in a normal tab.
2. Click the **Testomat Run Panel** toolbar icon to open the panel. Keep the tab
   under test focused when you capture or record — a `chrome://` page is off
   limits to every extension.
3. **Runs** tab → click your run. (No run in the list? Create it in the web app,
   or paste the run link into the search box above the list.)
4. The run opens as a checklist grouped by suite. Click a suite header to expand
   it, then click a test row to open the test.
5. Read the steps. Click a step's checkbox to tick it off as you go — optional;
   the test status is what is reported.
6. Click **✓ Passed** (or press ⌘/Ctrl+Enter). The panel saves and jumps to the
   next untested test.

That's it. For a failure, see [the failure flow](#failing-a-test-the-full-story).

---

## 3. Feature guide by tab

The panel header is three rows, top-down:

```
| Tests   Runs   Settings      ● Rec |   tabs (Rec chip only while it can record)
| Project: Your Project            ▾ |   the active project, on every tab
| ← Manual tests at 29 Jul…          |   only while a run / test / suite is open
```

Three tabs at the top: **Tests**, **Runs**, **Settings**. Each tab remembers
where you left it. The third row appears only when you have drilled into
something — it names what is open, and its back arrow navigates *inside* the
current tab. On a tab's own landing screen (the test tree, the runs list,
Settings) there is no third row: the highlighted tab already says where you are.

### Runs tab

#### Runs list

- **Status chips** — All / Passed / Failed / Running / Scheduled / Terminated,
  each a name with its count beside it. One at a time; the choice is remembered.
  The row never wraps and no chip ever loses its word: what does not fit at the
  panel's current width moves into the **⋯** menu at the end of the row, from the
  right (Terminated first, then Scheduled, and so on) — **All** always stays. Pick
  a filter from that menu and it works exactly as the chip would; when the chosen
  filter is one of the hidden ones, the **⋯** button itself carries the selected
  wash so the row is never silent about which answer is on.
- **Search or paste run URL…** — one input for both jobs: type to filter run and
  folder titles live, or paste a link to jump straight to it (see below).
- **+ New run** — opens the web app's run-creation page for the project you are
  on, in a new tab. Runs are still created in the web app; the panel only takes
  you there.
- **Type pill** — `manual` / `automated` / `mixed` next to a run's title, the
  same badge the web app shows. Folders (run groups) have none — a folder is not
  a run.
- **Folders** (run groups) expand in place; contents load on first expand.
- **Refresh** (↻) — re-fetches the list, keeping your filter and expanded
  folders.
- **Paste a link** into that same input — a run link
  (`…/projects/<project>/runs/<id>`) opens the run, a run-group link expands and
  highlights the folder. Pasting acts immediately; a link you typed by hand opens
  on **Enter**. The link must belong to the configured instance and project —
  anything else (wrong host, another project, an id that no longer exists, or one
  you have no access to) gets a **Run not found** toast and leaves you on the
  list. The panel never switches project for you.
- An empty project shows a link to the web app instead of a dead end.

#### Run view

- **Run summary card** — one card at the top of the run holding everything about
  the run itself: the type pill (`manual` / `automated` / `mixed`) and the run's
  **status** (`failed`, `running`, …) on the first line with **Finish run** on
  its right, then `done/total · N passed · N failed · N skipped` — each tally in
  the colour of the bar segment under it, and a tally of zero simply left out —
  over the colored bar. In full mode the counts line ends with the run's **custom
  statuses** (`· Product Bug: 3 · Test Issue: 1`), biggest group first — a
  one-glance triage summary of the whole run. If the run can no longer be written
  to, a 🔒 line inside the card says so (see **Read-only results**).
- **Run info** — a section in the foot of the card, open by default, with the same
  fields as the web run page's sidebar, read as a list with a hairline between
  fields: Status, Duration, Tests, **Environment**, **Test plan**, Executed (or
  Started while the run is live), **Executed by**, **Build URL**, Created,
  **Created by** and Description. Environment is a list and is drawn as one — one
  pill per environment, the same pills a run wears in the runs list; Test plan is
  a single name and reads as plain text. The Status value is the word in its own
  colour — red for failed, green for passed — the way the web prints it, and a
  person is shown as their initials plus their name (the panel cannot load avatar
  images). Empty fields are simply not shown, and the Build URL is a short **Open
  CI build ↗** link that opens the CI job in a new tab — the panel's only way to
  reach it. Click the header to open or close it; the panel remembers your choice
  — closed stays closed the next time you open the panel, not just the next run.
  Times read in the timezone of **your Testomat account profile**, exactly as the
  web shows them, so the two windows never disagree — change it in the web account
  settings. In basic mode the section keeps Status / Tests / Environment / Test
  plan / Created / Description and drops the four that need a session (Duration,
  Executed, Started, Build URL), and its times fall back to your computer's
  timezone (a plain token cannot see a profile).
- **Finish run** — closes the run; pending tests are marked skipped. A confirm
  dialog appears first. The button is only there while the run is running, and
  it needs full mode (see [basic vs full mode](#basic-vs-full-jwt-mode)).
- **Status chips** — All / Passed / Failed / Skipped / Pending, counted over the
  whole run. Same row as the runs list: one line, and whatever does not fit waits
  in the **⋯** menu at its end.
- **Search tests…** — over test and suite titles.
- **Suite sections** are collapsed by default (a run with a single suite opens
  expanded). A filter or a search auto-expands what it matched. Each header
  shows `done/total` for that suite.
- **Row buttons ✓ / ✗ / –** — set a status straight from the list without
  opening the test. The row badge flashes green when the write lands.
- Rows show the assignee when the test has one, and — in full mode — the test's
  **custom status** as an outlined pill next to the status badge (`failed`
  `Product Bug`), tinted by the row's status. Setting one inside the test
  (see below) makes it show up here, and a colleague's change lands on the next
  refresh, together with the header counters.
- **Read-only results** — two things the panel will not let you overwrite: a
  **finished** run, and an **automated** result your CI reported. The row
  buttons, the status buttons and their shortcuts, the step checkboxes, the custom
  status, the comment box and both attach buttons go grey and say why. When the
  reason covers the whole run it is spelled out once, as a 🔒 line — in the run
  summary card on the run view, and under the three status buttons inside a test;
  in a
  **mixed** run only the rows CI reported are locked and the manual ones keep
  working as usual. Reading is never affected — the checklist, the steps and the
  result summary all render in full. (The automated lock matches the web app,
  which does not open its runner on an automated run at all; the API would take
  the click and quietly drop it.)

#### Test view

The test's name is in the panel header. Under it comes the test's own summary
card — the same card the run view opens with, so nothing moves as you go in and
out of a test: the marks this test carries on the top line, the run's progress
under them, and a foot band with the shortcut legend and the pager. Then the
three status buttons, and then the screen splits in two sections you switch
between:

**Description** — what to do: the steps.
**Status** — what happened: the reported result, the assignee, the custom status,
the comment and the attachments.

The buttons stay above both, so marking a result is one click away whichever
section is open. Marking one moves you to **Status**, which is where everything
you write *about* a result lives. A dot on the **Status** segment, in the colour
of the result, says the test already has one.

- The card's top line, when the test has anything to say about itself: the
  **result** it already carries (the same chip the run wears for its own status),
  the **custom status** refining that result, and a `queued` marker if the last
  status is waiting to sync. None of them? The line is not there at all.
- The test's **priority** is a mark at the head of its name, in the header row,
  left of the type mark — the same pair of marks a list row opens with. A test
  nobody gave a priority shows the neutral `normal` ring, which is the priority
  it actually runs at; that is what the lists show for it too.
- **Basic mode** pill — shown only when the panel could not get a full session.
- **example row missing** pill — a parametrized test whose example data could
  not be loaded; placeholders show raw, the test still runs.
- **✓ Passed / ✗ Failed / − Skipped** — the primary controls, above the
  sections. Each button does exactly what its keyboard shortcut does — the click
  and the shortcut are one action, never two behaviours. Marking never leaves the
  test (see **Moving on** below); it only opens the **Status** section.
- **‹ 3 of 11 ›** — the pager, in the foot of the summary card: where you are in
  the run, and one step either way through the *visible* list (exactly what the
  arrow keys do). Each end goes grey when there is nowhere further to go. The
  **?** at the other end of that band toggles the keyboard-shortcut legend.
- **Steps** (the *Description* section) — rendered from the test's Markdown, one
  card per step. In full mode each step has a checkbox synced to the server:
  click cycles **passed → failed → skipped → passed**, and the card's left edge
  takes the colour. The first click is always *passed*, and a step cannot be
  clicked back to unset (same rule as the web runner). In basic mode steps are
  plain local checkboxes that are not sent anywhere and reset when you leave the
  test. A nested `Expected:` (or `Expected Result:`) bullet renders as a muted
  expected result under its step, not as a step of its own. Every other
  top-level list item in the description — under *Expected Results*,
  *Preconditions*, a numbered list — gets the same control and is stored the
  same way, exactly as the web runner treats it; a tick made in one place shows
  in the other. Nested sub-bullets stay plain, as they are in the web. **Images in the
  description show**, the same ones the web shows you — they are loaded a moment
  after the text, and one that cannot be loaded (a picture that was deleted,
  a panel with no web login) leaves an **open image ↗** link in its place rather
  than a blank gap.
- **Result summary** (full mode, the *Status* section) — only for a test the run has *already*
  reported, i.e. when you open a finished or automated run. It is the web's
  Summary panel, one card above the buttons:
  - `● Failed · 18.4s` — the reported status and how long the test took;
  - **Failure** — the failure message, open by default and tinted red (a
    non-failed result titles the same box **Log** and tints it green). A
    reporter's message is shown exactly as reported, newlines and indentation
    intact; a message written by hand (including everything the panel itself
    writes) renders as Markdown;
  - **Meta** — collapsed; the result's custom meta entries (what the reporter
    sent under `meta`, plus anything typed into the web's Meta editor);
  - **Steps** — collapsed; the steps the run reported, each with its status,
    duration and, on a failure, its own error. Sub-steps are indented.
  - **No stacktrace.** Deliberately: the panel is for marking, and a stack
    belongs in the web report. Follow the run link there if you need it.
  It is a read-only picture of the *reported* result and does not change while
  you mark the test — re-open the test to refresh it.
- **Assignee** (full mode) — project members plus *Unassigned*.
- **Custom status** (full mode) — appears when the project defines replies for
  the status you just set. What you pick here is what the run list and the run
  header show once you go back (see [Run view](#run-view)).
- **Comment (optional)** — free text; Markdown.
- **Attachments & log** — a collapsed section that opens itself the moment you
  mark the test failed (it never closes itself), holding:
  - a reminder that the recorder is off and what window it would keep,
  - **Full page** — capture the whole scrollable page instead of the viewport
    (remembered),
  - **Console & network log** — the live errors-only list while recording;
    click a row for details, **Attach** to drop that one entry into the comment,
  - **📸 Attach screenshot** — capture → annotate → upload,
  - **📎 Attach file** — pick one or more files from your machine (a spec, an
    export, a video…) and upload them onto this result,
  - the list of everything already attached to the result — screenshots, the
    console/network log, your own files — each a link that opens in a new tab.
    An **image** on that list is shown as a thumbnail; click it to see it full
    size over the panel (Esc, the ✕ or a click outside closes it).
- Status line at the bottom — `Saving passed…` while the write is in flight, the
  offline-queued notice, and the errors. A write that *lands* says nothing there:
  the chip in the card, the filled button and the dot on **Summary** are already
  the answer.

**Moving on**: marking a test leaves you *on* that test — every status, whether
you clicked a button or pressed its shortcut. That is deliberate: **Custom
status**, **Assignee**, the comment and the attachments only appear once the test
carries a real status, and being redirected at that exact moment hid them. Failing
additionally opens **Attachments & log** for you, since that is when you attach
evidence.

You move on with the pager's **›** (one step down the visible list) or with **N**
— the next untested test, skipping anything already graded. When nothing untested is left you
get `Run complete 🎉` and land back on the run; if the test you are on is the last
untested one, the panel says so and stays put. Fast marking is therefore two
keystrokes — the status shortcut, then **N**. A landed status says nothing under
the buttons: the chip in the card, the filled button and the dot on **Summary**
are the answer. If a status fails to save, the
status rolls back and the failure is toasted, so you never move on from a test
the server never recorded.

**Keyboard shortcuts** (test view only, and never while you are typing in a
field):

| Action             | Keys                 |
| ------------------ | -------------------- |
| Passed             | ⌘/Ctrl + Enter       |
| Failed             | ⌘/Ctrl + U           |
| Skipped            | ⌘/Ctrl + I           |
| Next untested test | N                    |
| Previous test      | ↑ / ←                |
| Next test in list  | ↓ / →                |

Arrows move ±1 through the *visible* list (filter and search applied) and stop at
the ends — they never wrap and never write a status. **N** is the one that skips
tests you have already graded.

#### Failing a test: the full story

1. **Before reproducing**, click **Rec** in the panel header. Nothing pops up —
   no *"…is debugging this browser"* bar, and you can keep DevTools open. The
   recorder keeps only the last N seconds (60 by default), so arm it first.
2. Reproduce the bug in the tab.
3. Open **Attachments & log** → **Console & network log** to see the errors and
   failed requests as they arrive. **Attach** copies a single entry into the
   comment.
4. Type what you saw in the comment.
5. Click **✗ Failed**. The panel then:
   - records `Browser`, `OS`, `Viewport` and `URL` as **meta** on the result —
     they show up in the **Meta** section of the test detail on the web, not in
     the Failure box (toggleable in Settings),
   - uploads the console+network log as a readable `.txt` and adds it as a
     `Console & network log` meta key (toggleable in Settings),
   - keeps you on the test and opens **Attachments & log** for you.
6. Optionally **📸 Attach screenshot** → annotate → **Apply**.
7. Click **Rec** again to stop recording.

#### The annotator

After a capture, the screenshot opens as an overlay **on the page you captured**
(if the page can't host it, it opens in a tab instead and says so).

The toolbar reads left to right: the tools, the ink they draw with, the history,
then what to do with the picture. Every button carries its shortcut in the
tooltip, and **?** opens the whole keyboard map over the image.

**Tools** (the letter picks it):

| | Tool | | Tool |
|---|---|---|---|
| **V** | Select | **H** | Highlight — translucent marker |
| **P** | Pen — freehand | **B** | Blur — softens, and destroys what was under it |
| **A** | Arrow | **T** | Text — click, type, Enter |
| **L** | Line | **N** | Number — drops 1, 2, 3… as you click |
| **R** | Box | **C** | Crop — drag the part worth keeping |
| **O** | Ellipse | | |

**Ink** — the colour swatch on the bar *is* the colour you are drawing with;
click it for the other seven (or press **1**–**8**, which never opens anything).
Three stroke weights sit beside it (**[** and **]**). Pick either one with an
annotation selected and it restyles *that* annotation instead of the next one.
The weight is also the size control for what has no stroke: a text label and a
numbered badge come out small, medium or large with it.

While you draw freehand, the pointer becomes the tool — a pen or a marker, in
the ink it is about to lay down. The shape tools keep the crosshair, because a
glyph would cover the corner the drag has to start on.

**History** — **Undo** (⌘/Ctrl Z) and **Redo** (⇧⌘/Ctrl Z) step through
everything: draws, moves, deletes, restyles and crops alike.

With **Select**, click an annotation to pick it, drag it to move it, and press
Delete (or Backspace) to remove it — Esc drops the selection.

A picked shape shows its **grips**: a box, an ellipse and a blur take their four
corners (drag one, the opposite corner stays), a line takes its two ends, and an
arrow takes its two ends *plus a round grip in the middle* — drag that and the
arrow **bends**, which is how you reach around a dialog without drawing three
arrows. Every drag is one step of Undo. **Double-click a
text label** to retype it: it reopens as the input that wrote it, in its own
place, with the words selected so typing replaces them. Enter commits, Esc puts
the old wording back, and emptying it removes the label. Either way it is one
step of Undo.

Then:

- **Apply** (⌘/Ctrl ⏎) — upload the flattened, annotated image.
- **Keep original** — upload the raw screenshot, annotations and crop dropped
  (also what Esc and closing the tab do).
- **Discard** — upload nothing.
- **Copy** / **Download** — take the picture without attaching it. Both are
  local; nothing is uploaded. A page that won't let the extension reach the
  clipboard says so on the toolbar — use Download there.

### Tests tab

Browse and author test cases.

- The tree shows **folders** and **suites**. Counts are test counts.
- The toolbar above it is search on the left, the three creates on the right:
  a **live search** over suite and folder titles, then the new-folder and
  new-suite glyphs and **+ New test**.
- **Search** filters the tree as you type. A folder stays when anything under it
  matches, and the branch down to a match opens itself, so a hit three levels
  deep is visible without unfolding anything. **×** clears it and gives the tree
  back exactly as you had it folded. The tab's own count keeps stating the
  project total, not what the search left. (The tests themselves are searched
  one level in — see the suite's own list below.)
- **+ New test** (toolbar) asks which suite, then opens the editor. In a pane
  dragged narrow it reads just **+ Test** — this is the busiest of the panel's
  toolbars, so it is the first to give the word up rather than squeeze the
  search box; the full name stays in its tooltip.
  The two glyphs beside it create at root; folder rows carry their own
  **Suite** / **Folder** buttons — every control that makes something new
  wears the same leading **+**. The new node appears as a row where it will
  live — its own folder or file glyph, and an empty name in place of a title —
  so you are naming it in the tree, not in a form above it. Enter or the **✓**
  creates it; the **✕**, Esc, or clicking away cancels. Creating something
  clears an active search, so the new node is never made off screen.
- Clicking a suite opens its test list (**+ New test**, plus a live search).
- **Add new test** — the field pinned along the bottom of that list. Type a
  title and press Enter, or **Create**, and the test is made in this suite right
  there, with no editor in between. The **Bulk** switch beside it turns the one
  field into one title per line, and **Create** — or `Cmd`/`Ctrl`+`Enter` —
  makes the whole list in a single go. New tests land at the end of the list,
  which reloads to show them; an active search clears itself so the row you just
  made is never created off screen.
- Clicking a test **shows** it — read-only.

#### Reading a test

An existing test opens as a plain page: its title, its priority, and its
description and steps as formatted text. A parameterised test carries its
**Parameters** table under the description — the columns it runs with, and one
row per run. The pencil in the header opens this same test in the editor;
**◀** goes back to the suite's list.

#### Editor (new tests)

Creating a test opens the Markdown editor. Top to bottom: the header (**◀**, the
trail, the priority dropdown), the title field across the full width, the
**Edit** / **Preview** tabs, the writing tools, the text, and **Save** /
**Cancel** in the footer. The title field takes a second line when the sentence
needs one; Enter there moves you into the body rather than breaking the title.
Leaving with unsaved work — **Cancel** included — prompts **Save & leave /
Discard / Cancel**, and `Cmd`/`Ctrl`+`S` saves from anywhere on the page.

New tests are pre-filled from your **project's** New Test template — the ones
managed in Testomat (*Project settings → Templates*). The template dropdown leads
the tools row above the text: the project's default template is picked for you,
and choosing another one fills the body with it. If you have already written
something, it asks before replacing it. A project with no test template simply
opens an empty body and shows no dropdown. Switch projects in the header and the
next new test uses that project's templates.

A test needs a title: saving without one outlines the field in red and says so
right under it (the message clears as soon as you start typing). Save creates the
test and the page turns into the read-only view of it.

**Parameters** folds open under the text. It is the same idea as in Testomat: the
top row names the parameters, every row under it is one set of values, and the
test runs once per row. Write a parameter into the steps as `${name}` — `Open
${url} as ${login}` — and each run fills its own values in. Type in the empty row
at the bottom and it becomes a row, with a fresh empty one under it; **✕** drops
a row, **+ Column** / **− Column** add and remove parameters, and Enter walks
down the column you are in. Name every column you use — values under a nameless
one are refused with a line under the grid. The grid is saved with the test, and
it is a session feature: in *basic mode* the block is not there at all.

Two evidence tools share that row, next to the template dropdown (all three
belong to **Edit** — **Preview** just shows the result):

- **● Record steps** — see below.
- **📸** (the camera button) — **Attach screenshot**: capture and annotate. The
  shot is held as a thumbnail under the row and uploaded when you **Save**.
  Click the camera again for another one — a test can hold up to **10**, and
  they upload in the order you took them. Each thumbnail carries a **✕** in its
  corner to drop that one; the rest stay. Held shots are unsaved work, so
  leaving the editor asks before it throws them away.

#### Step recorder

Recording is part of writing a new test, so it lives in the editor.

1. Open the tab you want to record, then start a new test.
2. Click **● Record steps**.
3. Work through the flow in the page. A dark pill in the bottom-right corner
   counts what it caught (`Recording · 7 steps`) and carries **+ Expected**,
   **Pause** and **Stop** buttons.
4. Watch the test write itself: every action is appended to the `### Steps` list
   a second or so after you do it, while the recording is still running. A page
   transition hangs under the step that caused it as an `Expected:` line — `The
   "Sign in" page opens` right under the click that opened it. The section is
   created if the test has none, and existing items are kept.
5. Click **■ Stop recording (N)** in the editor (or **Stop** in the pill) when
   you are done. That only ends the recording — the steps are already there.

What it records: clicks and double-clicks on buttons and links, typing into
fields, dropdown selections, checkboxes and radios, and navigations. Custom
controls that modern web apps build out of `<div>`s are recognized by their ARIA
role and get the wording that fits — *Open the "Details" tab*, *Choose "Export"
in the menu*, *Toggle the "Dark mode" switch*, *Select "QA"*.

**Sensitive values are kept out of the steps.** A password, a card number, a CVV,
an expiry, a one-time code, a passport number or a tax id records as *Type the password / the card
number / the value into the … field* — the field is named, the value is not. It
is recognized from the field's type, its `autocomplete`, the words it is named
and labelled by, and — for a card — the number's own checksum, so a card typed
into a field called anything at all is still caught. That last net aside, the
recognition is best-effort: if the site you test handles real payment or identity
data, turn on Settings → **Step recorder** → *Never record entered values* and no
value is recorded at all (see below).

Steps say **where** you clicked, not just what: a control inside a table row or a
card is recorded with that row's name, and one that has no label of its own
borrows its column header. So the bulk checkbox in a product table records as
*Check the Bulk checkbox in the "Bolt Cutters" row* instead of *Check the
checkbox*. Outside lists the enclosing section answers instead — the nearest
heading above, or a form's caption: *Click the "Save" button in the "Shipping"
section*. Only one such clause is ever added, and never one that just repeats the
control's own name. A control with no name of its own — an icon-only **+** —
borrows the nearest label, or that row, instead of the `name`/`id` its developers
gave it: *Click the button in the "Bolt Cutters" row*, not *Click the "qty-plus"
button*.

**Expected results while you record.** Click **+ Expected** in the pill the
moment you have checked something, type what you saw and press Enter (Esc drops
it). It attaches to the step you have just done, as the `Expected:` line the run
panel shows under that step — the same place the automatic page-transition lines
go. Nothing you type there is recorded as a step, and the page underneath never
sees the keystrokes. Each expected result counts toward the step limit like a
step.

Need to step out of the scenario mid-recording? Click **Pause** in the pill. It
turns into `Paused · N steps` with a **Resume** button, and everything you do in
between — clicks, typing, even navigating away — is dropped instead of landing in
the test. Resume picks up exactly where you left off. (The editor's Stop button
says *"— paused"* while that lasts.)

It also pauses by itself at 50 steps and asks *"Still recording?"* — click
**Continue** for another 50. That is a different pause: Continue raises the limit,
Resume does not. Closing the recorded tab — or the editor — stops the recording,
and everything recorded up to that moment is already in the test. The output is
human-readable Markdown, not Playwright code.

**Polish with AI.** The switch next to **Record steps**, **off** by default. While
you record, nothing about it changes: every step appears in the list the moment
you do it, in the recorder's own words. The rewriting happens **when you stop** —
the button reads *Polishing…*, your own Testomat.io instance's AI reads the whole
recording in one go, and each recorded step is replaced by the sentence it wrote
for that step. Steps you had written before the recording are never touched. You
may flip the switch at any point while recording; only where it stands when you
press Stop decides anything.

Right after a polish, the small **Undo polish** button beside the switch puts the
recording back exactly as it was recorded. And a recording that was *not* polished
— you stopped with the switch off, the panel closed before you stopped, or you
undid it — leaves that button reading **Polish recorded steps**, so you can ask
for the rewrite whenever you like. Either way, a step you have edited by hand is
left alone: only lines still holding the words the extension put there are
swapped.

If the request fails, times out or comes back unusable, the raw steps stay exactly
as they were recorded and a toast says why — nothing is ever lost to a failed
polish. When your plan carries no AI, that toast is the server's own sentence
(*"Ai is not available in your subscription plan"*). The switch needs the web
session, so it is hidden in *basic mode*, and an instance that refuses the request
outright turns it off with *"Polishing isn't enabled on this server yet"*. What is
sent is described in [the privacy policy](../PRIVACY.md) — read it before you turn
this on for a site whose content is confidential.

Nothing recorded leaves your browser except into the test you are writing: the
steps go straight into the editor, and the only place they are ever sent is your
own Testomat instance — when you save, or, with *Polish with AI* on, when you
stop the recording.

### Settings tab

- **Welcome — 3 steps to your first run** — a first-run checklist (token →
  project → first run) that ticks itself off and disappears. `×` dismisses it.
- **Connection** — the first section, and once you are connected it is a card,
  not a form: the instance you are on, and **Disconnect**. There is no token box
  — a saved token is nothing you can read back, so the panel does not show you a
  row of dots. Disconnect erases that instance (token, project, preferences,
  restored session, anything still queued) and drops you back on the connect
  screen, where one field asks for a token again. There is no project field
  either: the panel resolves the projects the token reaches and you switch
  between them from the header.
- **Failure log**:
  - *Attach console & network log to failed tests* — on by default. Off only
    skips the automatic upload; the per-entry **Attach** still works.
  - *Include response bodies of failed requests* — on by default. Off and the
    recorder never reads a response body: the failed requests are still listed
    with method, URL, status and timing, and the row details and the uploaded
    `.txt` say *(body capture disabled)* where the snippet would be.
  - *Log window (seconds)* — how much console/network history the recorder
    keeps; default 60, allowed 10–600.
  - *Record environment info (browser, OS, viewport, URL)* — on by default.
    Written on **every** status, not just a failure, and it lands in the test
    detail's **Meta** section rather than in the comment.
  - *Include the query string in the recorded URL* — off by default; see
    [the privacy policy](../PRIVACY.md).
- **Step recorder**:
  - *Never record entered values* — **off** by default, so what you type is saved
    into the step with the sensitive values masked. On, every text entry records
    as *Type text into the … field* and nothing typed is kept — the switch for a
    site whose fields no heuristic is going to recognize. A password field is the
    one that still names itself (*Type the password into the …*): no value is
    written either way, and that one is a certainty rather than a guess.
- **Appearance** — **System** / **Light** / **Dark**, and it takes effect the
  moment you press it: there is nothing to save. *System* is the default and
  keeps following your operating system as that changes; *Light* and *Dark* pin
  the panel regardless of it. The choice belongs to this browser rather than to
  the Testomat you are connected to, so it is the same on every instance you
  switch between — and the test editor tab and the on-page screenshot annotator
  follow it too. A **Sign out** keeps it: it erases credentials, not the way you
  set the panel up to look.
- **Advanced** — folded away behind its heading; click it to open. It opens by
  itself when the instance you saved is not `https://app.testomat.io`, and when a
  save fails on the Instance field, so you never chase an error into a closed
  section.
  - **Instance** — the Testomat you connect to, prefilled with
    `https://app.testomat.io`. Leave it alone unless you are self-hosted. Once you
    have used more than one instance, a dropdown above the field lets you switch
    between them (each keeps its own token, project and preferences). Point it at
    an instance the panel holds no token for and the **General token** field
    comes back — that is the only place the full form asks for one.
  - **Forget this instance** — erases whichever instance the field above is
    showing. For the one you are *on*, that is **Disconnect** up in Connection.
- **Save & validate** — nothing is saved until you press it. Leaving the tab
  discards unsaved edits.
- **Stored credentials → Sign out** — erases every token, instance and queued
  result from this browser. See [the privacy policy](../PRIVACY.md).

### Always-on bits

- **Project** (header row 2) — the active project, on every tab. Click to drop
  down the list, type to filter it; picking another one repoints the panel — see
  [switching projects](#switching-projects).
- **Open in window / Dock to side panel** (last button of the project row) —
  the panel can run as Chrome's side panel or as a window of its own; the button
  switches to the other one and closes the one you were in. Your run, your test
  and your place in it come back on the other side. The choice is remembered, so
  the toolbar icon opens the surface you last used — and it survives a sign out,
  like the colour scheme. A panel in its own window still acts on the tab you
  left in the browser window: screenshots, **Rec**, the step recorder and the
  environment info all follow the site under test, not the panel.
- **Rec** (right end of the tabs row) — the console/network recorder. Visible on
  the run and test views, and from anywhere while a recording is running, so you
  can stop it in one click. A red dot pulses while it records; the recorded tab's
  title sits next to it.
- **Basic mode banner** — a slim strip on the runs/run views naming what is
  disabled, with **Refresh** and a dismiss ×.
- **N changes pending · Retry** — the offline queue strip.
- Toasts appear bottom-centre; error toasts are red-tinted cards with an alert
  icon (the same notification style as the web app) and a dismiss ×.

---

## 4. Limits and quirks

### Basic vs full (JWT) mode

The panel authenticates with your General token, then quietly upgrades it to a
session. Everything that lives on Testomat's web API needs that session. When
the upgrade fails you get **basic mode**: a *Basic mode* pill in the test view
and a banner on the runs views, which suggests signing in to the instance in the
same browser and clicking **Refresh**.

Available in basic mode: the runs list (a flatter one), opening runs and tests,
reading steps, setting passed/failed/skipped, comments, the offline queue.

Not available in basic mode:

- server-synced step results (steps fall back to local checkboxes),
- **Finish run** (visible but disabled, with the reason on hover),
- priority, assignee, custom status — the in-test select, the run-row pill and
  the run header's counters all disappear together,
- the **result summary** of an already-reported test (it reads the same web API
  as priority, so in basic mode the card simply is not there),
- **uploads** — screenshots and the console/network `.txt` go through the
  session route, so they fail with an error toast; **📎 Attach file** knows this
  up front and is disabled with the reason instead,
- **environment meta** — `Browser` / `OS` / `Viewport` / `URL` and the log link
  ride the same web API as custom status, so they are skipped silently; the
  status itself still saves,
- parametrized example substitution (you see raw `${placeholders}` and the
  *example row missing* pill),
- the web-ordered runs list with nested run-group folders.

### Site access: allowed everywhere from install

The extension asks for access to all websites when you install it, and that is
the end of the subject — there is no per-site step, nothing to grant mid-run and
nothing that expires when you switch tabs. It is the same model Jam, Tango and
Loom use.

What that does and does not mean:

- **It acts only when you click.** Nothing is captured, recorded or read until
  you press Rec, Attach screenshot, Record steps — or click a status, which reads
  the tab's address for the `URL` meta row (switchable off in Settings).
- **Browser pages are still off limits, to every extension.** On a `chrome://`
  page, the Chrome Web Store or another extension's page, Chrome hides the tab
  from us entirely, and the panel says so: *"Chrome doesn't allow extensions on
  this page… switch to the site under test."* No click fixes that — switch to a
  normal `http(s)` tab.
- **You can narrow it.** `chrome://extensions` → **Testomat Run Panel** →
  **Details** → **Site access** offers *On all sites* / *On specific sites* /
  *On click*. Restrict it there if your policy requires it; the panel keeps
  working and simply reports the pages it cannot touch.
- **Clicking the toolbar icon** opens the panel, nothing more. Close the panel
  with Chrome's own side-panel close button.

### The "…is debugging this browser" bar

A **Full page** screenshot uses the DevTools protocol, so Chrome flashes its
infobar over the tab while that shot is taken and drops it straight after. That
is expected, and it is now the only thing that raises the bar: a plain viewport
screenshot uses Chrome's own capture and raises nothing, and **recording does
not** either — it never touches that protocol. Recording also survives DevTools
being open on the tab.

### Another extension on the page can block a full-page screenshot

Some extensions put a frame of their own into the page they run on (overlays,
sidebars, assistants — Jam and 1Password are the common ones). Chrome then
refuses to let *any* other extension attach the DevTools protocol to that tab, so
a **Full page** screenshot cannot be taken there. What you get instead is the
viewport shot, with a note saying the page was cropped — and a plain viewport
screenshot is unaffected in the first place, since it does not use that protocol
at all. To get the whole page, turn that other extension off for the page or run
the session in a clean Chrome profile.

**Rec is not affected any more.** It used to be blocked on exactly these pages;
the recorder now works inside the page instead, so it records there like
anywhere else.

### Live sync is polling, ~20 s

While a run (or a test of it) is open and the panel is visible, the panel
re-reads the run every **20 seconds** and repaints what changed — a colleague's
status or assignee change lands within that window, with a toast if it hit the
test you have open. Your own writes are never overwritten and trigger an
immediate refresh. Switching back to the panel also refreshes immediately.

There is no push: if you need "now", use **Refresh** on the runs list or reopen
the run. Real-time push is blocked on server-side work.

### Offline queue

If a status write fails because of the network (or a paused/refused token), the
panel keeps your click, shows `queued` on the row and test, and counts it in the
**N changes pending** strip. It replays when the connection returns, when you
hit **Retry**, when a poll succeeds, and when you open the panel or a run. The
queue survives a browser restart. If a sync is already running when you hit
**Retry**, the panel tells you so and runs your retry right after it — the click
is never simply ignored.

Only test statuses ✓/✗/– (with their comment) are queued. Assignee, custom
status, finish-run, step results and uploads are not — they fail with an honest
error.

The queue only drains **while the panel is open**. Close the panel with pending
items and they wait for the next time you open it.

### Recorder limits

Step recorder:

- **Top frame only** — actions inside iframes are not recorded.
- **No `contenteditable`** — rich-text editors are not recorded (plain inputs,
  textareas, selects, checkboxes, radios, buttons, links and ARIA custom
  controls — tab, menu item, option, checkbox, switch, radio — are).
- Element naming falls back through `aria-label` → visible text → label →
  placeholder → table column header → the row/section clause → `name`/`id`; an
  element with none of those records as `Click the button`.
- Row context comes from the row's first heading, header cell, cell or bold text;
  a card whose whole text is one long paragraph gets no clause rather than a
  truncated one.
- Recording state is lost on a browser restart (not on a panel reload).

Console/network recorder:

- Only the **last N seconds** (Settings, default 60) end up in the attached log
  — arm it *before* reproducing.
- One tab at a time. DevTools may stay open, and other extensions on the page no
  longer block it.
- The recorder watches the page from **inside** it, so a few things are out of
  reach: browser-written console notes it cannot observe (deprecation warnings
  and the like), requests made by page **workers**, WebSocket messages,
  content inside **iframes**. The handful of requests a page fires in its very
  first instants after a reload are kept: the instrumentation is registered for
  the recorded origin up front.
- A request reaches the list when it **finishes** (or fails); something still
  hanging is not listed yet.
- Console messages and request metadata (method, URL, status, timing) are kept.
  Response **bodies are captured only for failed requests** (HTTP ≥ 400) and are
  truncated at 16 KB — and only while *Include response bodies of failed
  requests* (Settings, on by default) is on; off, you get the request without
  its body and a *(body capture disabled)* note in its place. Nothing is
  recorded unless you switch Rec on.
- The in-panel list is errors-only (console errors/warnings, non-2xx and failed
  requests). The attached `.txt` carries the full window.
- A crash the page never logged — an **uncaught error** or an **unhandled
  promise rejection** — is listed too, as `uncaught.error`, with the file, line
  and column and the top of its stack. If the page also `console.error`-ed the
  same failure a moment earlier (many frameworks do), you get one row, not two.

### Smaller things

- **📸 Attach screenshot** is disabled until the test has a saved result — the
  screenshot attaches to a result, so set a status first. The reason is shown
  inline.
- **📎 Attach file** has the same "set a status first" gate, plus one of its
  own: uploading needs the web session, so in basic mode it is disabled and says
  so. Picking several files at once uploads them one after another — if one is
  rejected (too large for your plan, say) you get an error toast naming *that*
  file and the rest still go up.
- Step results and the local step ticks are per *result row*: a parametrized
  test has one row per example and each keeps its own state.
- The comment box, its draft and local step ticks are never touched by live
  sync.
- Suite expand/collapse is remembered per run for the session; opening a
  different run resets it.
- The runs-list status chip is remembered between sessions. The run-view chips
  and both search boxes reset every time you open a run.

---

## 5. What it does NOT do

Worth knowing before you plan a session around it:

- **No run creation.** You cannot start, clone or schedule a run from the panel.
  Create runs in the Testomat web app; the panel executes them. (Paste its link
  into the runs search to jump straight to one.)
- **No real-time push.** Live sync is 20-second polling, not ActionCable/
  WebSocket — blocked on product-server work.
- **No editing of existing tests.** The panel creates test cases and shows them;
  changing one — its title, steps, priority, suite — happens in the web app.
- **No move-to-suite.** The panel cannot move a test to another suite, rename a
  suite, or delete anything (tests, suites, folders, runs, attachments). All of
  that stays in the web app.
- **No screen recording.** Screenshots (viewport or full page) and console/
  network logs only — no video, no GIF.
- **Not in the Chrome Web Store.** Install from a release zip or the repo; update
  by unpacking a newer zip or `git pull`, then reload. There is no auto-update.
- **No test creation from a run.** The Tests tab authors test cases; a run's
  checklist is whatever the run was created with.
- **No bulk actions.** No multi-select, no "mark the rest skipped" other than
  **Finish run**, which skips everything still pending.
- **No offline reading.** The queue holds *writes* only; you cannot browse runs
  or open tests without a connection.
- **No cross-project view.** One instance and one project at a time (switching
  is one dropdown away in Settings).
- **No telemetry.** Nothing is collected about you or your usage, ever.
- **No third-party traffic, none at all.** The panel talks only to the Testomat
  instance you configured. No CDN, no analytics, no AI service.

---

Security or privacy question — what is sent where, and how to turn it off?
One page answers them all: [`PRIVACY.md`](../PRIVACY.md).

## 6. Where to report a problem

Issues go to the repo:
**https://github.com/testomatio/browser-extension/issues**

There are no issue templates yet, so please include:

- **What you did** — tab, screen, and the exact button you clicked.
- **What happened vs. what you expected**, including the exact wording of any
  message or toast.
- **Which mode** — was the *Basic mode* pill or banner showing?
- **Where** — instance, project, run URL (if it is not sensitive).
- **Chrome version** and the extension commit (`git rev-parse --short HEAD` in
  your clone).
- A screenshot of the panel, if the problem is visual.

Label the issue **bug** for something broken, **enhancement** for an idea, or
**question** if you are not sure. Anything site-access, recorder or upload
related: say which site you were on, and what Chrome shows under
*chrome://extensions → Details → Site access*.
