# Privacy Policy — Testomat Run Panel

**Last updated: 2026-08-14. Applies to extension version 0.1.0.**

Testomat Run Panel is a Chrome extension for executing Testomat.io manual test
runs beside the site under test. This policy describes every piece of data the
extension reads, keeps or transmits. It was written against the source in this
repository and cross-checked line by line with `extension/manifest.json`.

## Summary

- The extension has **no server of its own**. It talks to exactly one host: the
  Testomat.io instance **you** configure in Settings (`https://app.testomat.io`
  by default, or your own self-hosted URL).
- Your API token and your preferences are stored **locally**, in your own Chrome
  profile, using `chrome.storage.local`. `chrome.storage.sync` is never used, so
  nothing is copied to your Google account.
- **No analytics, no telemetry, no crash reporting, no advertising, no CDN, no
  AI service, no third party of any kind.** Nothing about you or your usage is
  collected, and no data is ever sold, rented or shared.
- Everything the extension uploads is uploaded **to your own Testomat.io
  instance**, as part of a test result you deliberately recorded, and it lives
  under that instance's own retention and access rules from then on.

## What is stored on your computer

Two areas, both belonging to the extension inside your local Chrome profile.

**`chrome.storage.local` — survives a browser restart:**

| Stored | Why |
|---|---|
| Your Testomat.io **API token**, per instance | To authenticate every call to that instance |
| The instance URL and the selected project | To know where to read and write |
| Your Settings preferences | Log window length, the environment-info and body-capture toggles, the step-recorder switch |
| A short history of instances you have connected to | To offer them again |
| The **offline queue** — test statuses and their comments that could not be sent | So a click is not lost when the network drops; replayed when it returns |
| Onboarding progress, colour scheme, panel/window preference | Interface state |

**`chrome.storage.session` — cleared when Chrome restarts:**

| Stored | Why |
|---|---|
| The rolling console/network buffer while a recording runs | It is what gets written into the `.txt` log you attach |
| The steps captured by the step recorder | Until you save them into a test case |
| A screenshot waiting to be annotated | Handed from the capture to the annotator |
| An unsaved draft of a new test case | So a reload does not lose your typing |

Nothing is written to disk outside these two areas, and the extension creates no
files of its own.

## What is transmitted, and where

**Recipient: your Testomat.io instance. There is no other recipient.**

| Sent | When |
|---|---|
| Test statuses (passed / failed / skipped), comments, step results, assignee, priority, custom status, "finish run" | When you click the corresponding control |
| **Environment meta** — `Browser` (brand + major version), `OS` (platform name only), `Viewport` (pixel size), `URL` of the tab you were testing | With every status write, while *Settings → Record environment info* is on |
| A **console & network log** as a `.txt` attachment | On a Failed result while a recording is running (if auto-attach is on), or when you click Attach |
| **Screenshots**, annotated or original | Only when you click Apply or Keep in the annotator. Discard uploads nothing |
| Files you choose yourself with **Attach file** | When you pick them |
| Test cases, suites and folders you create in the panel | When you save them |

Two details worth knowing, because they are the most sensitive things the
extension can capture:

- **The recorded `URL`.** By default only the scheme, host and path are sent;
  the query string and the fragment are cut off and a trailing
  `(query trimmed)` marks that something was removed. Query strings routinely
  carry password-reset tokens, signed links, invite codes and session ids, so
  this trim is on by default. *Settings → Include the query string in the
  recorded URL* opts back in. On a `chrome://` page, the Chrome Web Store or
  another extension's page Chrome hides the address from every extension, and
  the key is simply omitted.
- **Response bodies in the console & network log.** Only for **failed**
  requests (HTTP status ≥ 400, or a network-level error), and only the first
  **16 KB**. Request bodies are never read. *Settings → Include response bodies
  of failed requests* turns this off; the request is still listed, with
  *(body capture disabled)* where the snippet would be.

The console/network buffer is a **rolling window** of the last N seconds
(default 60, configurable 10–600) held in memory while recording. Older events
are discarded and nothing is written to disk.

## What the extension never does

- It never contacts any host other than the Testomat.io instance you configured.
  The extension's own pages run under a Content Security Policy that starts at
  `default-src 'none'`, so a channel nobody enumerated is closed rather than
  open.
- It never records anything without you starting it. A screenshot, a console
  and network recording, and a step recording each begin with a click of yours
  and end when you stop them or close the tab.
- It never enumerates your open tabs. Every tab lookup in the code asks for the
  **active tab of one window** (`{active: true, …}`); there is no query for all
  tabs, and the extension does not request the `tabs` permission. Because it
  does hold access to all sites, Chrome will show it the address of a tab it
  asks about — but it only ever asks about the one you are working in.
- It never reads your browsing history, your cookies, your bookmarks or your
  downloads. None of those permissions are requested.
- It never stores the value you type into a `type=password` field. The step
  recorder writes `Type the password into the … field` instead. Card, CVV,
  expiry, OTP, PIN and similar fields are masked the same way when they are
  recognised — by field type, `autocomplete` value, name, id, placeholder or
  label, or by the value itself being 13–19 digits that pass the payment-card
  checksum. Recognition is **best effort**, so a switch that needs no heuristic
  exists: *Settings → Step recorder → Never record entered values* drops every
  typed value.
- It never uses AI. An optional "polish the recorded steps with AI" feature
  existed briefly and was removed entirely. If an old install still holds an
  Anthropic key in storage, the extension deletes that key the next time the
  panel opens.
- It never updates itself silently. There is no auto-update: the extension is
  installed unpacked from source.

## Permissions, one by one

These are exactly the permissions declared in `extension/manifest.json`. Nothing
else is requested.

| Permission | Why it is needed | Limits |
|---|---|---|
| `storage` | Keep the API token, the project choice, preferences, the offline queue and the in-session recording buffer in your local Chrome profile | `chrome.storage.sync` is never used, so nothing leaves the profile through Chrome |
| `sidePanel` | Draw the panel itself in Chrome's side panel | — |
| `scripting` | On your click, inject the screenshot annotator, the step recorder and the console/network instrumentation into the tab you are testing | Nothing is registered to run automatically except for the origin currently being recorded, and it is unregistered when the recording stops |
| `webRequest` | List the page's own network traffic (method, URL, status, timing) in the console & network log | **Observational only.** The four listeners are registered with no `extraInfoSpec`: the extension never asks for request or response **headers**, never uses the **blocking** form, and cannot modify, redirect or cancel any request. Events for any tab other than the one being recorded are discarded on arrival and kept nowhere, not even in memory |
| `debugger` | One capability only: a **full-page** screenshot (`Page.captureScreenshot` with `captureBeyondViewport` over the Chrome DevTools Protocol), which is the only way to capture a whole scrollable document | Attached for the duration of that one shot and detached immediately in the same `finally`. No other feature uses it. A plain viewport screenshot uses `chrome.tabs.captureVisibleTab` and attaches nothing. Chrome's *"…is debugging this browser"* bar appearing for that moment is this, and only this |
| `host_permissions: <all_urls>` | The extension acts on whatever site you are testing, and that site is different for every user and every session — including internal hosts no developer could enumerate in advance. The three things the product exists for all need to read that page: a screenshot of it, its console and network log, and a recording of your steps on it | Nothing runs on a page without an explicit click, and no page content is sent anywhere except your own Testomat.io instance. You can narrow the grant at any time in Chrome's own UI — **chrome://extensions → Testomat Run Panel → Details → Site access** — to *On specific sites* or *On click*; the panel is built to say plainly when it cannot touch a page rather than fail silently |

Chrome summarises `<all_urls>` at install as *"Read and change all your data on
websites you visit"*. That is an accurate description of what a tool that
screenshots, records and instruments the page under test needs.

`minimum_chrome_version` is `123`.

## Retention and deletion

The extension keeps data only on your machine, and gives you three ways to erase
it. All three ask for confirmation first, and all three stop a running recording
before erasing anything.

- **Disconnect** (Settings → Connection) — erases the current instance's token,
  project, preferences and history row, plus the session-backed data: recorded
  steps, the console/network buffer, unsaved drafts and any screenshot waiting
  to be annotated. Other instances are untouched.
- **Forget this instance** (Settings → Advanced) — the same erase, aimed at
  whichever instance the *Instance* field names.
- **Sign out** — clears both storage areas entirely: every token, every
  instance, the history, the offline queue, drafts and onboarding progress. The
  panel restarts as if freshly installed. Only your colour-scheme choice is
  carried across.

Uninstalling the extension deletes both storage areas, because Chrome removes
them with the extension.

Sign out does **not** reach anything already uploaded. Results, comments, logs
and screenshots that reached your Testomat.io instance live there under that
instance's own policy. It also does not touch Chrome's own state — cookies, your
Testomat.io web login, browsing history — which the extension has no way to
clear.

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
