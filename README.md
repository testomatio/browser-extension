# Testomat Run Panel

A Chrome side-panel extension for executing [Testomat.io](https://testomat.io)
**manual test runs** next to the site being tested. You read a test's steps,
tick them off, set passed / failed / skipped with a comment, and attach the
evidence — a screenshot, a console and network log — without leaving the tab
under test.

It works against `app.testomat.io` and against self-hosted instances. It is not
in the Chrome Web Store; you install it from source (see below).

## What it does

**Runs.** Browse the project's runs and run folders, or paste a run URL. A run
opens as a checklist grouped by suite. Statuses, comments, tri-state steps
synced to the server, parametrized example rows, custom statuses, assignee,
priority, finish run, and the web runner's keyboard shortcuts. Marking a test
never navigates — you move on when you choose to. An open run re-reads itself
about every 20 seconds, so a colleague's change lands on its own; a status write
that fails offline is queued locally and replayed when the connection returns.

**Evidence.** **Rec** records the console messages and network traffic of the
tab under test into a rolling in-memory window. Errors show inline in the test
view, and setting a test to Failed uploads a readable `.txt` log and links it on
the result. **Attach screenshot** captures the tab — viewport or full page —
and opens an annotator over the page itself: arrow, box, pixelate and text,
each selectable afterwards to move or delete. The pixelate tool is a real
mosaic, and the un-pixelated original is dropped on Apply.

**Tests.** Browse suites and test cases; an existing test opens as a rendered
read-only view. New test cases are written in a Markdown editor (with suites and
folders), and a **step recorder** turns your clicks on the page under test into
human-readable Markdown steps, masking values it recognises as sensitive.

**Graceful degradation.** The panel upgrades your API token to a web session
automatically. When it cannot, it drops to *basic mode*: statuses, comments and
the run list keep working over the public v2 API, while the session-only
features are disabled with a stated reason rather than vanishing.

## Install from source

There is no packaged build and no auto-update.

1. Clone this repository:

   ```
   git clone https://github.com/testomatio/testomat-run-panel.git
   ```

2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the **`extension/`** folder inside the
   clone — not the repository root.
4. Pin **Testomat Run Panel** from the toolbar's extensions menu.
5. Click the toolbar icon. The panel opens on Settings; paste a **General
   token** from *Testomat.io → Account → Access Tokens* and click **Save &
   validate**. Self-hosted? Put your own `https://` URL into **Instance** under
   **Advanced** before saving.

Chrome 123 or newer. To update: `git pull`, then press the reload (↻) icon on
the extension's card in `chrome://extensions`. Your settings and the offline
queue survive the reload.

There is no build step: `extension/` runs exactly as it is checked in. No npm
install, no bundler, no compiler.

## Permissions, and why each is needed

These are the permissions declared in `extension/manifest.json`. Chrome
summarises the host permission at install as *"Read and change all your data on
websites you visit"*.

| Permission | Why |
|---|---|
| `storage` | Keeps the API token, the project choice, your preferences and the offline queue in your local Chrome profile. `chrome.storage.sync` is never used, so nothing is copied to your Google account |
| `sidePanel` | Draws the panel in Chrome's side panel |
| `scripting` | Injects, on your click, the screenshot annotator, the step recorder and the console/network instrumentation into the tab under test |
| `webRequest` | Lists the page's own network traffic (method, URL, status, timing) in the recording. Observational listeners only — no headers requested, never the blocking form, so nothing can be modified, redirected or cancelled |
| `debugger` | Full-page screenshots only, via the DevTools protocol — the only way to capture a whole scrollable document. Attached for that one shot and detached immediately, which is when Chrome's *"…is debugging this browser"* bar appears. Viewport screenshots do not use it |
| `host_permissions: <all_urls>` | The site under test is different for every user and session, and screenshotting, recording and instrumenting it all require reading that page. Nothing runs on a page without your click. You can narrow this in **chrome://extensions → Details → Site access** at any time |

The `tabs` permission is **not** requested: the extension never enumerates your
open tabs, and cannot read your browsing history.

Full detail — what is stored, what is transmitted, and every off switch — is in
**[PRIVACY.md](PRIVACY.md)**.

## Documentation

| | |
|---|---|
| **Using it** | [`docs/user-guide.md`](docs/user-guide.md) — every screen and button, the limits and the quirks |
| **Privacy** | [`PRIVACY.md`](PRIVACY.md) — what is sent where and when, every off switch, what it cannot do |
| **Working on the code** | [`docs/architecture.md`](docs/architecture.md) — module map, data flows, the permission model, storage keys, known traps |

## How this repository is maintained

Day-to-day development happens in a **private working repository** — that is
where the issue history, the pull requests and the end-to-end test suite live.
**This repository is the public release mirror**: each release arrives as a
single snapshot commit of the tree at that version. There is therefore no
fine-grained commit history here, and pull requests are reviewed by maintainers
by hand, since the automated suite is not part of this tree. That suite also
drives a few test seams in the shipped code (a couple of `chrome.storage.session`
keys, one message with no production sender) which look unused from inside this
tree — they are documented in [`docs/architecture.md`](docs/architecture.md)
§5.3; please leave them alone.

Bugs and feature requests belong **here**, in this repository's
[Issues](https://github.com/testomatio/testomat-run-panel/issues). A useful
report says what you clicked, what happened (with the exact wording of any
message), your Chrome version, and whether the *Basic mode* pill was showing.
Please do not paste API tokens or run URLs you would rather keep private.

## Licence

MIT — see [LICENSE](LICENSE).

Third-party code is vendored under `extension/vendor/` as committed single files
and keeps its own licence: [marked](https://github.com/markedjs/marked) (MIT)
and [OverType](https://github.com/panphora/overtype) (MIT). The icon paths come
from [Material Symbols](https://fonts.google.com/icons) (Apache-2.0), and
JetBrains Mono ships under the SIL Open Font License (`extension/shared/fonts/OFL.txt`).
