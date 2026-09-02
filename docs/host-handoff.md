# Signing the panel in from a host app

For developers of an app that launches Chrome with this extension loaded —
Testeiya, for one — and wants the panel signed in without the tester pasting
a token. Testers have nothing to do here; the panel just arrives connected.

## The file

The host writes `handoff.json` into the extension folder (next to
`manifest.json`) and opens the panel:

```json
{
  "app": "Testeiya",
  "baseUrl": "https://app.testomat.io",
  "projectId": "my-project",
  "jwt": "eyJ…",
  "projectToken": "tstmt_…",
  "runUrl": "https://app.testomat.io/projects/my-project/runs/abcd1234",
  "at": 1756160000000
}
```

`baseUrl`, `projectId` and `jwt` are required; a file missing any of them is
ignored. Two credentials, because the panel talks to two APIs: `projectToken`
is what `/api/v2` takes, `jwt` is a web session for the routes v2 lacks.
`runUrl` is optional; with one, the panel opens that run. `at` is
milliseconds since the epoch and has to grow on every push. `app` is shown
to the tester as the name of whoever signed them in.

A file rather than a command line: `--load-extension` argv is readable by
every process on the machine, and these are credentials.

## Rules the panel follows

- Only `projectToken` and the project are stored; the `jwt` is held in
  memory and re-read from the file, exactly like the one `POST /api/login`
  returns.
- The file has to stay for as long as the connection should work. Whoever
  wrote it deletes it — closing the browser it launched is the usual moment.
- **Disconnect** marks that `at` as answered instead of deleting a file it
  does not own. Push a newer `at` to offer the connection again.
- A run is opened once per `at`, so reloading the panel keeps the tester's
  place.

## Beside a token the tester pasted

An offer is an overlay on the ordinary sign-in, never a replacement. A tester
who had already connected that instance keeps their own credential and their
preferences; the two live side by side and each request uses whichever fits:

| Request | Credential |
|---|---|
| Web JSON:API (`/api/…`) | the handed `jwt`, else the tester's own session |
| `/api/v2` on the handed project | `projectToken` when one was sent |
| `/api/v2` anywhere else | that project's key, read with whichever session is live |

`projectToken` is therefore optional — a host that already holds one saves
the panel a round trip, and nothing more. `jwt` is what the offer is really
made of.

Because a session reaches every project, the switcher stays open. It closes
in one case: the host has closed its browser, taking the session with it, and
the tester never signed in themselves — then the stored `projectToken` still
opens that one project and Settings says so.

Signing in over a handed-off connection replaces it outright, session
included.

## Pushing into an open panel

A panel that is already open takes a new push through
`window.TestomatHandoff.apply()`, which answers `{ok, projectId, run}` —
`run` says whether the run the file names is now on screen — or
`{ok: false, reason: "no-offer"}` when there is no file, it is incomplete,
or its `at` was already declined. A build without that global predates this
contract and needs updating.

With no host involved the panel logs one `ERR_FILE_NOT_FOUND` for
`handoff.json` at boot. That is the check for the file, not a fault.
