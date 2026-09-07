# Privacy Policy for the Testomat.io Chrome extension

**Last updated: 2026-09-07. Applies to extension version 0.2.0.**

This extension executes Testomat.io manual test runs beside the site under
test. This policy describes every piece of data the extension reads, keeps or
transmits. It was written against the source in this repository and
cross-checked line by line with `extension/manifest.json`.

## Summary

- The extension has **no server of its own**. Everything it uploads goes to one
  host: the Testomat.io instance **you** configure in Settings
  (`https://app.testomat.io` by default, or your own self-hosted URL). Two
  *reads* can reach further than that — a file your instance keeps in storage of
  its own, and a video attachment the file viewer plays straight from the
  address your instance gave for it. The first bullet of *What the extension
  never does* says exactly when each happens.
- Your access token and your preferences are stored **locally**, in your own Chrome
  profile. `chrome.storage.sync` is never used, so nothing is copied to your
  Google account.
- **No analytics, no telemetry, no crash reporting, no advertising, no CDN, no
  third-party AI service, no third party of any kind.** Nothing about you or
  your usage is collected, and no data is ever sold, rented or shared.
- Everything the extension uploads is uploaded **to your own Testomat.io
  instance**, as part of a test result you deliberately recorded, and it lives
  under that instance's own retention and access rules from then on.

## What is stored on your computer

Three areas, all belonging to the extension inside your local Chrome profile.

**`chrome.storage.local` — survives a browser restart:**

| Stored | Why |
|---|---|
| Your Testomat.io **access token**, per instance — the one authorizing gives you, or a General token | To authenticate every call to that instance. Project API keys are never written down: the session reads one when it needs it and holds it in memory alone, and a project key handed over by a desktop app is stripped out before the settings are saved |
| The instance URL and the selected project | To know where to read and write |
| Your Settings preferences | Log window length, *Record environment info*, *Include the query string*, *Include response bodies*, *Auto-start console & network recorder*, *Attach log to failures*, *Never record entered values*, and whether screenshots are taken full-page. Two of them — *Include response bodies* and *Never record entered values* — are kept a second time as entries of their own, so the scripts that run inside the page under test can read a switch without ever being handed the record your token is in |
| A short history of instances you have connected to | To offer them again |
| **Where you left the panel** — the tab and view you were on, the run and test and its title, which groups you had expanded, your runs filter, and your step tick marks | So reopening the panel puts you back where you were |
| The **offline queue** — test statuses, their comments, and the environment info collected with them, that could not be sent | So a click is not lost when the network drops; replayed when it returns, with the environment it was marked in rather than the one at sync time. The console & network log is never parked here |
| Colour scheme, panel/window preference | Interface state. The colour scheme is also mirrored in the panel page's own `localStorage`, read as the page loads so it cannot flash the wrong colours first |
| Where you dragged the floating **recording bar** and the floating **step-recorder pill** on the page | So each comes back where you put it |
| Whether the editor's **Polish with AI** switch was left on | To remember the choice |
| A timestamp noting that you **dismissed a desktop app's offer** to connect | So the same offer is not put to you again |

**`chrome.storage.session` — cleared when Chrome restarts:**

| Stored | Why |
|---|---|
| The rolling console/network buffer while a recording runs — together with the **title and the address of the tab being recorded**, and the test result it belongs to | It is what gets written into the `.txt` log you attach. The copy here is what lets a background worker Chrome shut down mid-run pick the log back up instead of losing it |
| The steps captured by the step recorder, **including the addresses and titles of the pages it saw** | Until you save them into a test case |
| A screenshot waiting to be annotated, and the annotated image on its way back | Handed from the capture to the annotator |
| An unsaved draft of a test case or a suite | So a reload does not lose your typing |
| **Comments you typed onto a test but have not submitted** | The same reason |
| Which tab is bound as **the site under test** | So the screenshot, the log and the step recorder all act on the same page |
| The **attachment you asked to preview** over the page — its address, name and type | So the viewer opens the one file the panel handed it, and refuses any other address |
| A **screen recording in progress**, and a finished take waiting for review or upload: its local address, size, length and generated filename, the result it is bound to, and a one-shot key proving the review window was opened by the extension rather than by the site under it | To survive a background worker restart mid-recording, and to keep a hostile page from acting on your take |
| The run a **Run in Extension** click asked for, and the last handed-off run already opened | So the panel opens it once and does not jump you back on every reload |
| Which browser window is the ordinary one and which is the extension's own | Interface state |

**A small database of the extension's own (IndexedDB, `testomat-shots`) —
survives a browser restart:**

| Stored | Why |
|---|---|
| The full-page screenshots staged on an unsaved test draft, up to ten of them | A full-page JPEG is half a megabyte and up — too large for the session area, where it would cost you the draft as well. These outlive the draft they belong to: a record is swept at the next browser start once no draft claims it, and in any case once it is seven days old |

The extension writes outside these three areas in two places, and each of them is
a button you pressed:

- The annotator's **Download** writes `annotated-screenshot.jpg` into your
  Downloads folder, and the panel's **Save** for a screenshot waiting to be
  annotated writes its file there too. Both are an ordinary browser download —
  the extension holds no `downloads` permission and needs none.
- The annotator's **Copy** puts the picture on your system clipboard as a PNG,
  and Settings → **Copy diagnostics** puts the diagnostics rows there as text.

Nothing else is written to disk.

## What is transmitted, and where

**Recipient: your Testomat.io instance. Nothing is uploaded anywhere else.**

| Sent | When |
|---|---|
| Test statuses (passed / failed / skipped), comments, step results, assignee, priority, custom status, "finish run" | When you click the corresponding control |
| **Environment meta** — `Browser` (brand + major version), `OS` (platform name only), `Viewport` (the viewport of the tab you were testing, in CSS pixels), `URL` of the tab you were testing | With every status write, while *Settings → Record environment info* is on |
| A **console & network log** as a `.txt` attachment | On a Failed result while a recording is running (if *Attach log to failures* is on), or when you click Attach |
| **Screenshots**, annotated or original | Only when you click Apply or Keep in the annotator. Discard uploads nothing |
| A **screen recording** of the tab under test, as a `.webm` | Only when you press **Attach** in the review that opens at Stop — nothing is uploaded before that. Cut ranges never leave the machine: a trimmed take replaces its original, which is destroyed. Picture only, with no audio of any kind |
| Files you choose yourself with **Attach file** | When you pick them |
| Test cases, suites and folders you create in the panel | When you save them |
| The extension's **version number**, written into the page as an attribute | On the pages of your configured Testomat.io instance, and nowhere else — it is how the web app knows the extension is installed and can offer *Run in Extension*. Nothing else is written into that page. The only thing read back out of it is the run address that button hands over, and only when you press it |
| The whole recording's **context packets** — for each action you recorded: the attributes and visible texts of the control you used and of its surroundings (its label, its row, its column, its section, the heading above it, the texts either side of it), the page title and URL (query always trimmed here, whatever *Include the query string* is set to), the value you typed **exactly as it was already masked**, and what changed on the page right after the action (a toast, dialog or validation message that appeared, the control's own new state, a counter that moved) — plus the test's title and the steps you had already written above the recording | **Once**, when you stop a recording while the test editor's *Polish with AI* switch is on — **off by default** — or when you press *Polish recorded steps*. **Nothing is sent while you record.** It goes to your instance's own AI prompt endpoint and nowhere else |

The packets are built for **every** recording, switch or no switch: they are what
lets a nameless control be recorded by the row it sits in. With the switch off
they never leave the browser — they travel with the recording, are held in
`chrome.storage.session` like the steps themselves, and are dropped when the
recording is saved or the browser restarts. Nothing about them is kept by the
extension beyond that, and they are never sent to any third party — there is no
recipient other than the Testomat.io instance you configured.

Two details worth knowing, because they are the most sensitive things the
extension can capture:

- **The recorded `URL`.** By default only the scheme, host and path are sent;
  the query string and the fragment are cut off and a trailing
  `(query trimmed)` marks that something was removed. Query strings routinely
  carry password-reset tokens, signed links, invite codes and session ids, so
  this trim is on by default. *Settings → Include the query string* opts back
  in. On a `chrome://` page, the Chrome Web Store or another extension's page
  Chrome hides the address from every extension, and the key is simply omitted.
  The step recorder's first `Open` step follows the same rule — the query string
  and the fragment are cut unless that setting is on, except that a fragment
  which is a route (`#/…`, as in a hash-routed single-page app) is kept without
  its own query. **The console & network `.txt` trims unconditionally**: the
  recorded tab's address, every request URL and the source location on every
  console line are cut to scheme, host and path whether or not *Include the
  query string* is on, because that file lists a whole minute of requests and
  stays on the result for the team to read. The entry you quote into a comment
  with Attach is trimmed the same way.
- **Response bodies in the console & network log.** Only for **failed**
  requests (HTTP status ≥ 400, or a network-level error), and only the first
  **16 KB**. Request bodies are never read. *Settings → Include response bodies*
  turns this off; the request is still listed, with *(body capture disabled)*
  where the snippet would be.

The console/network buffer is a **rolling window** of the last N seconds
(default 60, configurable 10–600). What is *attached* is that window. What is
*kept* while recording is twice it — a retroactive margin, so that raising the
setting mid-run still has something to show — capped at 1000 entries, whichever
comes first; anything older is dropped as each new event arrives. The buffer
lives in the background worker's memory and is copied into
`chrome.storage.session` every couple of seconds, so that a worker Chrome shuts
down does not take the log with it. Neither copy is written to disk, and both go
when Chrome restarts.

## What the extension never does

- It never **uploads** to any host other than the Testomat.io instance you
  configured. Two *reads* can reach another host, and both are your instance's
  own doing rather than a second party:
  - **Your instance's file storage.** Your files and the avatars beside a name
    live in the object storage behind your instance, and asking it for one can
    be answered with a signed, time-limited redirect there, which the browser
    then follows. Nothing else in the panel is asked for a file — an address
    that merely arrives in data from the server, pointing at a host your
    instance never signed for, is refused rather than fetched, and shown as a
    plain link instead.
  - **The file viewer.** The one attachment you click is opened from whatever
    address your instance gave for it, including an address on another host. A
    picture or a text file is fetched and shown from the bytes; a **video** is
    played straight from that address by the player, so opening a recording your
    instance stores off-instance does reach that host directly. The viewer will
    open only the single file the panel parked for it: a page that guesses the
    viewer's address and puts a URL of its own in it is refused, and gets no
    request and no link.

  The extension's own pages also run under a Content Security Policy that starts
  at `default-src 'none'`, which is what stops any remote code from running:
  scripts are `'self'` only, and frames are refused outright. It is not what
  keeps fetches on your instance — `connect-src` and `media-src` do allow
  `https:`, and the restriction to your instance is the one the code applies,
  described above.
- It never records anything without you starting it, or without a switch you
  turned on yourself. A screenshot, a screen recording and a step recording each
  begin with a click of yours and end when you stop them or close the tab. The
  console & network recording is the same, with one exception you control: with
  *Settings → Auto-start console & network recorder when you open a test in a
  run* on — **off by default** — it starts by itself when you open a test in a
  run, is bound to that test, and stops when you leave it.
- It never enumerates your open tabs. There are exactly two tab lookups in the
  code and both ask for the **active tab of one window** (`{active: true, …}`);
  there is no query for all tabs, and the extension does not request the `tabs`
  permission. Because it does hold access to all sites, Chrome will show it the
  address of a tab it asks about — but it only ever asks about the one you are
  working in.
- It never reads your browsing history, your cookies, your bookmarks or your
  downloads. None of those permissions are requested. The two Save buttons
  described above put a file into your Downloads folder the way any web page's
  download link does; that needs no permission and gives the extension no way to
  see what else is in there.
- It never stores the value you type into a `type=password` field. The step
  recorder writes `Type the password into the … field` instead. Card and
  security-code fields are recognised too, and so are expiry, one-time code,
  PIN, IBAN, routing and account number, SSN, passport, tax id, secret, token
  and API key — but for those, unlike a password, there is no field type to go
  by: they are text or tel inputs, so recognition is by `autocomplete` value,
  name, id, placeholder, `aria-label` or label text, or by the value itself
  being 13–19 digits that pass the payment-card checksum. A recognised value is
  replaced with the words *the password*, *the card number* or *the value*, and
  the value itself is never held anywhere; only a short non-reversible
  fingerprint of it stays in the page's memory, so that pressing Enter after
  typing is not recorded as a second entry. Recognition is **best effort**, so a
  switch that needs no heuristic exists: *Settings → Step recorder → Never
  record entered values* replaces every typed value, recognised or not.
- It never sends anything to a third-party AI, and it holds no AI key of its own.
  The one AI feature — *Polish with AI* in the test editor, off by default — asks
  **your own Testomat.io instance**, in a single request when you stop recording,
  to rewrite the steps you just recorded, over the same session the panel already
  uses; what it sends is the row above. Nothing goes out while you record. No
  third-party AI host is contacted, and no AI key is asked for or stored. If an
  old install still holds the API key the removed early feature stored, the
  extension deletes that key the next time the panel opens.
- It never updates itself silently. There is no auto-update: the extension
  declares no update URL, is installed unpacked from a release zip or a clone,
  and a new version reaches you only when you replace that folder and press
  reload.

## Permissions, one by one

These are exactly the permissions declared in `extension/manifest.json`. Nothing
else is requested.

| Permission | Why it is needed | Limits |
|---|---|---|
| `storage` | Keep the access token, the project choice, preferences, the offline queue and the in-session recording buffer in your local Chrome profile | `chrome.storage.sync` is never used, so nothing leaves the profile through Chrome |
| `sidePanel` | Draw the panel itself in Chrome's side panel | — |
| `scripting` | On your click, inject the screenshot annotator, the step recorder and the console/network instrumentation into the tab you are testing | Those three are injected on your click and, for the console/network recording, registered for the recorded origin until you stop it. One script is registered permanently and independently of any recording: the presence marker, described in the row below |
| `content_scripts` (in the manifest) and the presence marker | A single small script that writes the extension's version into the page as an attribute, so the Testomat.io web app can tell the extension is installed and offer *Run in Extension*; the click on that button is relayed to the panel | It runs on `https://app.testomat.io` (declared statically in the manifest) and, when you configure a self-hosted instance, on that instance's origin as well — registered automatically and kept across browser sessions. **Never on the site under test.** It reads nothing out of the page; it writes the version attribute and listens for that one button |
| `web_accessible_resources` | The file viewer and the screen-recording review are extension pages that have to be openable over the site under test, so a screencast is not squeezed into a ~400px panel | Being web-accessible means any site can try to open them, so both refuse to act for anyone but the panel: the viewer opens only the exact file the panel parked, and the review disables every control — and shows neither the take's address nor its size — when it was framed by the page rather than by the extension, which the worker's one-shot per-take key is what tells apart |
| `webRequest` | List the page's own network traffic (method, URL, status, timing) in the console & network log | **Observational only.** The four listeners — request start, completion, error and redirect — are registered with no `extraInfoSpec`: the extension never asks for request or response **headers**, never uses the **blocking** form, and cannot modify, redirect or cancel any request. Every event is dropped unless it belongs to the tab being recorded, and when nothing is recording every event is dropped |
| `tabCapture` | Record the picture of the tab you are testing, and only while a recording you started is running | Chrome allows it only on a tab where the extension was invoked (the toolbar icon, our right-click item or the shortcut), the stream is requested with `audio: false` and carries none, and it is closed the moment you stop |
| `offscreen` | An MV3 worker has no DOM, so the recording is assembled in a hidden extension page of our own | It exists only while a recording runs or a finished take waits to be attached, it loads no remote code and makes no network request of any kind, and it talks to nothing but this extension |
| `contextMenus` | One item, **Record this tab for Testomat.io**: it starts a recording and is one of the ways Chrome lets you grant the capture | That one item, offered on a page, a selection, an image or a link. Nothing else is added to any menu |
| `debugger` | Two capabilities. A **full-page** screenshot (`Page.captureScreenshot` over the Chrome DevTools Protocol, clipped to the document's own measured size), which is the only way to capture a whole scrollable document. And a **screen recording** on a tab where Chrome refused its capture stream (`Page.startScreencast`), which is what lets the record button work without a prior gesture on the tab | For a shot, attached for that one capture and detached immediately in the same `finally` — unless a recording already holds the attach on that tab, in which case the shot borrows it and leaves it standing; for a recording, attached while it records and detached at Stop. No other feature uses it. A plain viewport screenshot uses `chrome.tabs.captureVisibleTab` and attaches nothing. Chrome's *"…is debugging this browser"* bar appearing (a flash for a shot, the recording's duration otherwise) is this, and only this. One side effect is worth naming: when Chrome refuses the attach because **another extension's** iframe is in the page, those iframes are taken out and put back where they were once the capture is done — putting one back reloads it. Only other extensions' frames are moved, never the page's own content |
| `host_permissions: <all_urls>` | The extension acts on whatever site you are testing, and that site is different for every user and every session — including internal hosts no developer could enumerate in advance. The three things the product exists for all need to read that page: a screenshot of it, its console and network log, and a recording of your steps on it | Nothing runs on a page without an explicit click, and no page content is sent anywhere except your own Testomat.io instance. You can narrow the grant at any time in Chrome's own UI — **chrome://extensions → Testomat.io → Details → Site access** — to *On specific sites* or *On click*; the panel is built to say plainly when it cannot touch a page rather than fail silently |

Chrome summarises `<all_urls>` at install as *"Read and change all your data on
websites you visit"*. That is an accurate description of what a tool that
screenshots, records and instruments the page under test needs.

`minimum_chrome_version` is `123`.

## Retention and deletion

The extension keeps data only on your machine, and gives you three ways to erase
it. All three ask for confirmation first.

- **Disconnect** (Settings → Connection) — erases the current instance's token,
  project, preferences and history row, plus everything in the session area:
  recorded steps, the console/network buffer, unsaved drafts, unsent comments
  and any screenshot waiting to be annotated. It also erases that instance's
  offline queue. A running console & network recording is stopped first, and if
  it cannot be stopped the erase says so rather than claiming the log is gone.
  Other instances are untouched.
- **Forget this instance** (Settings → Advanced) — the same erase, aimed at
  whichever instance the *Instance* field names. When that is an instance you
  are **not** currently on, only its saved token, project, preferences and
  history row go: the session data and the queue belong to the instance you are
  on, and neither they nor a running recording are touched.
- **Sign out** — clears both `chrome.storage` areas entirely: every token, every
  instance, the history, the offline queue and drafts. A running recording is
  stopped first, with the same warning if it cannot be. The panel restarts as if
  freshly installed. Two things are carried across: your colour-scheme choice
  and your panel-or-window choice.

Disconnect and Forget leave the settings that belong to no instance in place —
the colour scheme, the panel-or-window choice, the two switches the in-page
scripts read, the *Polish with AI* switch, where you dragged the floating bars,
and the note that you declined a desktop app's offer. Sign out clears those too,
keeping back only the two named above. None of the three reaches the staged
full-page screenshots in the extension's own database; those are swept at the
next browser start, once no draft is left to claim them.

Uninstalling the extension deletes all three areas, because Chrome removes them
with the extension.

Sign out does **not** reach anything already uploaded. Results, comments, logs
and screenshots that reached your Testomat.io instance live there under that
instance's own policy. It also does not touch Chrome's own state — cookies, your
Testomat.io web login, browsing history — which the extension has no way to
clear. Nor does it reach a file you saved to your Downloads folder yourself.

## Children

The extension is a professional testing tool. It is not directed at children and
collects nothing about any user's identity.

## Changes to this policy

This file is versioned in the repository. Any change ships with the release that
makes it true, and the date at the top is updated.

## Contact

Questions, corrections, or a claim in this document that does not match the
code: open an issue at

**https://github.com/testomatio/browser-extension/issues**
