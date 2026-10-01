# Privacy Policy for the Testomat.io Chrome extension

**Effective 2026-10-01. Covers version 0.2.1 and later — both the copy from the Chrome Web
Store and the copy from GitHub.**

The Testomat.io extension, published by Testomat.io, runs Testomat.io manual tests beside the
site you are testing. This policy says what data it handles, where that data goes, how long it
is kept, and how to switch it off or erase it.

## Summary

- The extension has **no server of its own**. Everything it uploads goes to the Testomat.io
  instance **you** connect it to: `https://app.testomat.io`, or your own self-hosted address.
- On `app.testomat.io`, that instance is run by Testomat.io (Optimum Solutions Sp. z o.o.), and
  what you upload is covered by the [Testomat.io Privacy Policy](https://testomat.io/privacy/).
  A self-hosted instance is run by your own organization.
- **Polish with AI** is off by default. When you use it, the recorded steps go to your instance;
  on `app.testomat.io`, Testomat.io passes them to its AI provider, **Groq** (USA).
- Nothing is captured until you start a capture, mark a result, or turn on a setting that does it
  for you.
- **No analytics, no telemetry, no advertising.** Your data is never sold.

## What the extension handles

**Your Testomat.io account.** Your access token, stored in your browser and sent only to the
instance you save it for. To show the people on runs and tests and to set assignees, the extension
reads your project members' names, emails, avatars and time zones from your instance, and your own
user ID from your session; these stay in the panel's memory and are gone when it closes.

**Test results.** The statuses, comments and step results you mark, and the tests, suites and
attachments you create, edit or delete — sent to your instance when you click.

**Environment info.** With each status you mark: the browser and its major version, the operating
system, the size of the tested tab, and its address. By default the address is cut to scheme,
host and path — no query string, no fragment. *Settings → Record environment info* turns this off;
*Include the query string* keeps the full address, here and in a recorded *Open* step.

**Screenshots and screen recordings** of the tab you are testing — only when you take one. You
mark up a screenshot before it is saved, and review (and can trim) a recording before you attach
it. Recordings are picture only, with no sound.

**The console & network log** of the tab you are testing — only while you record it (the Rec
button), or when you have turned on *Auto-start* (off by default). It holds the page's console
errors and warnings, and for each network request its method, address, status and timing, plus
the first 16 KB of the response body of a **failed** request (*Include response bodies* turns
bodies off). Request bodies and cookies are never read. Outside those response bodies, every
web (http and https) address in the log file is cut to scheme, host and path. It keeps a rolling
window of the last minute (configurable), and is attached to a result when you mark it **Failed**
(*Attach log to failures*, on by default). The *Attach* button next to one log entry copies that
entry, response body included, into your comment.

**Recorded steps.** When you record steps, the extension writes down your clicks, what you type,
the options you pick and the pages you open, as readable sentences such as
`Type "Kyiv" into the City field`. Typed values are kept up to 40 characters.
- Passwords, card numbers, security codes, expiry dates, cardholder names, one-time codes, PINs,
  bank account numbers, identity numbers, secrets and API keys are recognised and replaced with
  words such as *the password* or *the value*. Recognition is best effort.
- *Settings → Never record entered values* replaces every typed value, whatever the field.
- Neither covers a choice you make by **clicking** — a radio button, or an item in a dropdown or
  menu the page draws itself, is recorded by its text — nor the page's own text around a control.
- Slider and colour values and the names of files you attach are recorded as they are, unless
  *Never record entered values* is on.
- The recorder also works inside frames embedded in the page, such as a payment form.

**Polish with AI** (off by default). When you stop a recording with the editor's *Polish with AI*
switch on, or press *Polish recorded steps*, the extension sends your instance, once: the test's
title, the steps already written, the recorded steps, the texts and attributes of the controls
you used and of their surroundings, what changed on the page after each action, and the page's
title and address (query cut). Nothing is sent while you record.

**Payment details.** When you test a payment page, card or bank details can end up in a
screenshot, a recording, the log or a recorded step: card fields are masked, but only as best
effort, and a card you pick by clicking ("Visa •••• 4242") is recorded by its text.

**Page addresses and titles.** The address of the page you are testing travels with results;
its address and title travel with logs and recorded steps, as described above. Chrome's browsing
history is never read.

## Where your data goes

- **Your Testomat.io instance** receives everything the extension uploads, over HTTPS, and
  nothing is uploaded anywhere else. On `app.testomat.io` that is Testomat.io, under its
  [Privacy Policy](https://testomat.io/privacy/) and [Terms](https://testomat.io/terms/).
  Everyone with access to the project there can see what you upload to it.
- **Groq** (USA) receives the text of *Polish with AI* on `app.testomat.io`, passed on by
  Testomat.io. Testomat.io's Terms say AI features must first be switched on by the company owner
  in the company settings. On a self-hosted instance, where that text goes is up to its
  administrator. The extension itself never contacts an AI provider.
- **Files you open.** An attachment, its thumbnail or an avatar is loaded from the address your
  instance gives for it — its own storage, or another host where the file lives — and that host
  receives the request directly.
- **The page you test** can see the extension's views drawn inside it (see below).
- **No one else** receives anything from the extension.

## What is kept in your browser, and for how long

- **Until you erase it or uninstall** (`chrome.storage.local`): your access token per instance,
  the instance and project, your settings, a short list of instances you used, where you left
  the panel, and results waiting to be sent while your instance cannot be reached.
- **Until the browser restarts** (`chrome.storage.session`): the log you recorded, recorded
  steps, unsaved drafts and comments, a screenshot being marked up, and the record of a screen
  recording waiting for review (the video itself stays in the extension's memory).
- **Screenshots staged in the test editor** (the extension's own database): deleted with the
  draft; any left over are removed at the next browser start once no draft needs them, or once
  they are seven days old.
- `chrome.storage.sync` is never used, so none of this is copied to your Google account.

Once something reaches your instance, it lives there under that instance's rules — on
`app.testomat.io`, the Testomat.io Privacy Policy.

## What runs without a click

- A small marker on the pages of `app.testomat.io` and of the self-hosted instance you are
  connected to, which tells the web app that the extension (and its version) is installed, so it
  can offer *Run in Extension*. It never runs on the site you test.
- Results you marked while your instance could not be reached are sent automatically once it
  can be.
- With *Auto-start* on (off by default), the console & network log starts when you open a test in
  a run, and stops when you leave it.
- While a capture you started is running, the extension puts its scripts back after the tested
  page reloads or navigates. While the log records, its script is also set to load at page start
  on that site, so the first requests are not missed; in other tabs of that site its events are
  ignored.

The mark-up tool, the file preview, the recording bar and review, and the step recorder's pill are
drawn inside the page you are testing, so that page's own scripts can see them — including the
screenshot being marked up and the address of a file being previewed.

## Permissions

- **storage** — keep the token, settings and the in-progress data listed above.
- **sidePanel** — show the extension in Chrome's side panel.
- **scripting** — put the extension's own scripts into the tab you are testing: the mark-up tool,
  the step recorder, the log recorder, the file preview and the recording controls, and read that
  tab's viewport size and title.
- **webRequest** — list the tested tab's network requests in the log. It only observes: it cannot
  block or change a request, and it ignores every other tab.
- **tabCapture** and **offscreen** — record the tested tab as video, without sound.
- **debugger** — full-page screenshots, a screenshot when Chrome refuses its ordinary capture, and
  screen recording where Chrome refuses the video stream. Chrome shows its *"…is debugging this
  browser"* bar while it is in use.
- **contextMenus** — one right-click item, *Record this tab for Testomat.io*.
- **Access to all sites** — the site you test is different for every tester and can be any
  address, including internal ones. You can narrow it in Chrome under
  *chrome://extensions → Testomat.io → Details → Site access*.

Chrome shows two warnings for these: *"Read and change all your data on all websites"* and
*"Access the page debugger backend"*.

## Your choices and how to erase

- **Switches** in Settings: *Record environment info*, *Include the query string*, *Include
  response bodies*, *Attach log to failures*, *Auto-start*, *Never record entered values*, and the
  editor's *Polish with AI*.
- **Disconnect**, or **Forget this instance** for the instance you are on, erases that instance's
  token and settings, all results waiting to be sent, and everything kept until the browser
  restarts. A running log or screen recording is stopped and thrown away first. Screenshots staged
  in the editor go at the next browser start.
- **Sign out** erases all of the extension's settings and saved data except your colour scheme
  and your side-panel-or-window choice, and stops any running recording the same way. Screenshots
  staged in the editor go at the next browser start.
- **Uninstalling** removes everything the extension stores in Chrome.
- None of these reaches what is already on your instance; delete it there, or ask the instance's
  operator.

## What the extension does not do

- It does not collect analytics, send telemetry or show advertising.
- It does not sell or rent your data, or use it for advertising or to judge credit.
- It does not read Chrome's browsing history, cookies, bookmarks or downloads, and never lists
  your open tabs.
- It does not load code from the internet: everything it runs ships inside the extension.
- It does not update itself outside the Chrome Web Store. The store copy is updated by Chrome
  after Google's review; the GitHub copy changes only when you replace its folder. Only the
  GitHub copy reads `handoff.json`, the file a desktop test tool can place in that folder to
  connect the panel.

## Limited Use

The use of information received by this extension adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements. It is used only to run your tests, attach evidence to
their results and write test cases, and it is never sold, never used or transferred for
advertising, and never used to determine creditworthiness or for lending.

## Children

The extension is a professional testing tool and is not directed at children.

## Changes

This page is published from the repository's `main` branch and changes when a change is merged
there, which can be a few days before that version reaches the Chrome Web Store. The date at the
top says when it last changed.

## Contact

Questions about the extension, or a claim here that does not match the code: open an issue at
**https://github.com/testomatio/browser-extension/issues**.

A request about your data on `app.testomat.io`: **legal@testomat.io**.
