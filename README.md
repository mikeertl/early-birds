# Early Birds Tennis

A static HTML/CSS/JavaScript app for arranging tennis games, using shared JSON
in the `mikeertl/early-birds` repository on the `main` branch. It follows
Longbourn's buildless approach, with independent configuration and browser
storage keys.

## Run locally

With Node.js installed, run:

```sh
./go.sh
```

Open the localhost URL printed by the launcher. It starts at port 8000 and tries
up to 8020 if ports are busy. Refresh after edits to see progress; press Ctrl+C
in the terminal to stop. To require a specific port, run `./go.sh 8001`;
an explicitly selected port will report an error if already in use.
The launcher works from any working directory and binds only to the local machine.
There is no dependency installation or build step.

## Files

- `index.html`: page entry point;
- `styles.css`: shared visual foundations;
- `config.js`: public GitHub target, data paths, booking limits and browser-storage keys;
- `app.js`: application bootstrap;
- `auth.js`: sign-in, browser sessions, profile and access helpers;
- `data/users.json`: the agreed initial player directory;
- `manifest.webmanifest`: app identity and relative install/start paths.

The player directory is loaded from `data/users.json`. Shared game and bagel data
will use `data/current.json` in task 2.4.
GitHub Pages will serve the repository root; hosting has not yet been configured
or published as part of this scaffold.

## Current stage

Tasks 2.1 and 2.2 establish the app foundation and responsive tab shell. Games
and Bagels are publicly visible; Admin sits between them when a signed-in admin
session is supplied. Arrow keys, Home and End navigate the visible tabs. The shell
provides empty, loading, error and ready states for each panel.

Task 2.3 adds sign-in, My profile, session restoration and sign-out. Choose one
of the nine agreed players, paste the separately supplied token, and optionally
select Admin mode. The app checks the credential with GitHub before activating
or restoring the session. Public Games and Bagels remain available without it.
My profile lets you change player/Admin mode or replace the token; leaving the
token field blank keeps the current one. Stored tokens are never prefilled into
the form. Sign-out removes the saved identity/token/Admin mode and remasks codes.

Shared JSON reconciliation/writes (2.4) and game management are subsequent tasks.
There are no live game cards yet. The agreed players are seeded in the local JSON
directory so sign-in can be used during this stage; GitHub directory refresh is
part of 2.4. Branding artwork and install icons are later tasks.

## Token and access setup

Use the GitHub token supplied separately by the organiser. The repository owner
can create a fine-grained personal access token for `mikeertl/early-birds` with
repository **Contents: Read and write** permission and an expiry date. See
[GitHub's token setup instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Sign-in performs a read-only repository check. It verifies the credential, but
does not prove Contents write permission: GitHub must enforce that permission
on each save when writes are implemented. Admin mode is the agreed trusted-group
interface option, available to any player; it is not an independently authenticated
role. Court codes are masked visually for visitors, while the underlying JSON
remains public.

Browser-storage keys are namespaced with `early-birds-`; Longbourn keys and data
are never used. Tokens are sent only to GitHub and saved in this browser's
`localStorage`, never in configuration or shared JSON. If browser storage is
unavailable, sign-in works for the current visit with a warning. A failed restore
leaves the app in visitor mode and allows signing in again. Signing out also
propagates to other tabs for the same origin. If the browser refuses to clear
saved data, the app reports that explicitly.

## Integration and checks

`EarlyBirdsUI.setPanelState(panel, state, message)` supplies data-loading states.
`EarlyBirdsAuth.setUsers(directory)` accepts the refreshed version 1 player
directory, filters inactive players and signs out a deactivated current player.
`getSession()` supplies the in-memory session to the future GitHub persistence
module; do not log it or serialize it into shared JSON.

Every future mutation handler must call `EarlyBirdsAuth.requireWrite()` (or
`requireWrite({ admin: true })` for Admin actions) before making a change. Visitors
see the sign-in form and an error; no change is made. This is a client-side guard,
not a substitute for token permissions or shared-data validation.

Render codes with `EarlyBirdsAuth.renderCourtCode(element, code)`. It inserts a
single-star code for a signed-in session or a black sign-in message for visitors,
keeps the raw code out of visitor DOM attributes, and remasks on sign-out.
The `early-birds-session-change` event allows game rendering to track session changes.

Run the browser regression checks with a local preview running, using Node.js
22+ and Chrome (Node 20 can use `--experimental-websocket`):

```sh
TEST_URL=http://127.0.0.1:8000/ node tests/auth.browser.cjs
```

Use the port printed by `go.sh`. On systems without Chrome in the usual macOS
location, set `CHROME_BIN` to its executable. Checks use a temporary Chrome profile,
synthetic tokens and intercepted GitHub responses, and never write to GitHub.
They cover failed sign-in, profile updates, restore, cancellation, storage failure,
cross-tab sign-out, code masking and phone/desktop layouts.

The staged plan and version 1 data contract are maintained in
`../@project/01-init.md` in the surrounding workspace.
