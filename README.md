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
- `booking.js`: Add Court form, quick dates, draft validation and save/retry integration;
- `games.js`: ordered game cards, booking details and labelled player lists;
- `model.js`: version 1 validation and replayable data actions;
- `store.js`: shared reads, queued saves and conflict reconciliation;
- `data/users.json`: the agreed initial player directory;
- `data/current.json`: courts, participation and retained singles/doubles bagels;
- `manifest.webmanifest`: app identity and relative install/start paths.

The player directory is loaded from `data/users.json`. Game and bagel data use
`data/current.json`, initially with empty court and bagel lists.
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
the form. Sign-out removes the saved identity/Admin mode and remasks codes, but
keeps the token for next time. To sign back in, choose your name and leave the
token field blank. Use **Forget saved token** in the sign-in/profile form to sign
out and remove the token. A signed-out reload keeps the token without restoring
a player session; it is checked with GitHub again when you next sign in.

Task 2.4 adds validated shared loading, Refresh, and the save/reconciliation API.
Games shows booking cards or an empty state; the other tabs show loaded counts.
Task 3.1 adds the **+ Add Court** button and booking form, and 3.2 adds the game
cards. Tasks 3.3–3.4 add participation controls and action refresh; 3.5 adds court
editing and deletion. Bagel entry and Admin player management are subsequent tasks. Branding artwork and
install icons are later tasks.

## Adding a court

In Games, choose **+ Add Court**. Visitors are prompted to sign in; any signed-in
player can book without Admin mode. The booker is prefilled with your name and
automatically receives a green place. Choose a day from this/next week's quick
buttons, or use the date picker for any future date. Sunday opens the next-week
shortcuts by default. No recurring slots are generated.

Time defaults to 08:00, with hourly starts from 07:00 to 21:00 and a fixed one-hour
duration in Europe/London. Choose court 1–6 and enter a six-digit code. A pasted
leading star is removed; the form displays one star and preserves leading zeroes.
The shared store rejects duplicate court/date/time bookings and overlapping green
places for the booker. Different players can book separate simultaneous courts.

Save is disabled while pending; the form closes only after confirmation. Failed
details remain available when closing/reopening the form in the same tab, with a
stable booking ID for retry. An uncertain save locks details until the same booking
is reconciled, avoiding duplicate creations. Drafts are kept per player in memory,
not browser storage, and the form closes when the signed-in player changes.
Saved bookings appear as individual cards in Games, including separate cards for
simultaneous courts. Cards sort by date, time, court number and ID. Each shows a
date such as `Wed 14 Oct 2026`, time such as `8:00am`, court, booked-by name and
the starred code. Visitors see a black sign-in message in place of the code;
signing out immediately remasks existing cards, including after a failed refresh.
Raw codes are not inserted into visitor card attributes or hidden elements.

Playing names appear in green and reserves in yellow, with text labels and counts
for both groups. Current names, including inactive players in existing bookings,
are resolved from stable user IDs. Names are inserted as text, never HTML. Player
lists sit to the right on wider screens and beneath booking details on phones.
Expiry/cleanup is task 3.6.

## Editing and deleting courts

Bookers see **Edit court** and **Delete court** on their own Games cards.
The **Admin** tab lists all courts with management controls, including changing
booked-by. Games keeps the booker fixed even when the player has Admin mode on.
Editing prefills the existing details and uses the same
date, hourly time, court-number and six-digit code validation as adding a court.
Only Admin can change booked-by, choosing an active player. Changing ownership
preserves the current playing/reserve lists; it does not enrol the new booker.
Moving a booking checks every green player's other games and rejects overlaps.

Edits save only changed fields against their original values. Independent changes
merge; if someone edits the same field, the form keeps your input and explains
the conflict. **Load latest details** explicitly replaces the unsaved draft with
the latest booking, which you can review and edit again. Failed drafts survive
closing/reopening in the same tab. An uncertain save locks details until retry
confirms the original action; the global retry button also works after closing.

Deletion asks you to confirm the court, date and time. It removes the court and
its participation, retaining all bagel history. If booking details change before
the deletion is saved, load the latest details and confirm again. Concurrent
participation changes do not prevent a confirmed deletion. All writes recheck
ownership against fresh shared data; a former booker cannot edit/delete after
ownership transfers unless they use Admin mode.

## Joining and reserving

Each card offers actions for your own place. **Add me** joins green when a place
is available, or yellow/reserved when four players are already green. **Reserve**
joins or moves you to yellow even when a green place is free. **Remove me** leaves
either list. Green players see Remove me/Reserve; reserves see Remove me and an
Add me button when the court has room. Reserves are never promoted automatically.
An open-place message invites eligible reserves to choose Add me. Refresh, or
return to the browser window/tab, to see other players' changes. Return refreshes
are skipped while a dialog is open, a request is pending or a save is uncertain.
There is no background polling.

A player cannot hold green places in simultaneous games. Add me is disabled when
it would create that overlap, with an explanation; overlapping reserves are
allowed. The store revalidates against fresh shared data, so another player's
concurrent change cannot create a fifth green player or duplicate membership.
If someone takes the last place before your join is saved, the refreshed card
explains that you are reserved. Successful card messages clear when that game's
membership changes, so an old full-court message cannot hide a newly open place.
Admin assignments use the same rules in the model; their management UI is 4.5.

Buttons are disabled during saves to prevent duplicate clicks. Membership colours
change after confirmation, and each card reports its outcome. Rejected changes
offer **Retry last change** and re-read shared data to update available actions;
if that read fails, the last loaded lists remain visible. Uncertain saves block new
participation changes until the original action is reconciled. Visitors clicking
an action are asked to sign in and no write is attempted. These buttons do not
change other players' places.

Task 2.5 adds separate save outcomes and recovery: a pending change is shown as
saving, a confirmed change as saved, a rejected change as not saved, and a lost
acknowledgement as not confirmed. These outcomes stay visible across data refreshes.
If a refresh fails, a notice marks the retained snapshot as the last loaded data.

Failed or uncertain actions keep their original values/IDs in this tab and offer
**Retry last change** when the original player is signed in with the same Admin
mode. You may replace an expired token and then retry. Retry rereads shared data
and reconciles the same action rather than creating a duplicate. Retrying as a
different player is blocked. Recovery is in memory only: closing/reloading the
tab loses this retained action. Forms added in later tasks must keep their own
input until the save promise resolves, and should use the recovery API after a failure.

## Shared data and saves

Visitors on localhost read the checked-out JSON files for preview. Signed-in
sessions read GitHub directly, and hosted visitors read the public GitHub API.
Refresh runs on startup, on session changes and when the Refresh button is clicked.
There is no fallback from a failed authenticated read to an older local copy.
The initial JSON files must exist in `mikeertl/early-birds` on `main` before live
reads/saves can succeed; this local task does not push files or publish the site.

The store validates versions, metadata, references, dates, times, court/code
limits, capacity, overlapping green places and singles/doubles team sizes before
accepting or writing data. Invalid/unknown formats are rejected, not replaced
with empty data. A failed refresh retains the last good in-memory snapshot and
shows an error. No shared snapshot or offline write queue is saved in browser
storage, so stale browser data cannot be sent as a replacement document.

`EarlyBirdsStore.mutate(action)` queues one intended change. It reads both shared
files fresh, validates the actor and action, rechecks the directory revision and
uses the target file's SHA for the PUT. On a 409 conflict it rereads and reapplies
the action, up to four attempts. Uncertain save acknowledgements are reconciled
the same way. Caller-provided IDs remain stable across retries; no full-document
replacement API is exposed. Existing bagels retain their player-name snapshots.

`EarlyBirdsStore.getRecovery()` returns a copy of the last failed action and its
`failed`/`uncertain` outcome, without credentials. `retry()` reuses that action.
Store subscriptions include `status.save` (`outcome`, `message`, `canRetry`) and
`status.stale`. Refresh success does not itself imply that a failed action saved.
Rejected save promises carry an `outcome`; if GitHub acknowledged a PUT just
before sign-out, that outcome is `saved` with guidance to refresh, and the action
is not offered for replay.

Supported actions for subsequent forms are:

- `court.add` with `court: { id, date, time, courtNumber, code, bookedBy }`;
- `court.patch` with `courtId`, `changes` and matching `expected` original field values;
- `court.remove` with `courtId`;
- `participation.set` with `courtId`, optional `userId`, and `status: "green" | "reserved" | "none"`;
- `bagel.add` with `bagel: { id, sourceCourtId, date, winnerIds, loserIds }`;
- `bagel.remove` with `bagelId`;
- `courts.cleanup` (removes prior London dates; scheduling is task 3.6);
- `user.add` with `user: { id, name, active }`;
- `user.patch` with `userId`, `changes` and matching `expected` values.

Generate opaque IDs once per intended creation. Codes supplied to the store must
already be six-digit strings without the leading star. Edits preserve unrelated
changes; a conflicting edit to the same field requires review instead of silently
overwriting it. A full green court sends an additional join to reserves. Cleanup
replays against current courts and leaves bagels intact. The store enforces the
agreed booker/Admin permissions independently of button visibility.

GitHub does not offer a multi-file transaction through the Contents API. The
directory is checked again just before writing, but another user's deactivation
can still race after that final check. State and directory writes are serialized
within this browser instance; other browsers are reconciled through file SHAs.
If sign-in changes before a PUT, the action stops. A PUT already received by
GitHub may still complete after sign-out; refresh to confirm such a change.

## Token and access setup

Use the GitHub token supplied separately by the organiser. The repository owner
can create a fine-grained personal access token for `mikeertl/early-birds` with
repository **Contents: Read and write** permission and an expiry date. See
[GitHub's token setup instructions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens).

Sign-in performs a read-only repository check. It verifies the credential, but
does not prove Contents write permission: GitHub enforces that permission
on each save. Admin mode is the agreed trusted-group
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
`getSession()` supplies the in-memory session to the GitHub persistence
module; do not log it or serialize it into shared JSON.

Forms should call `EarlyBirdsStore.mutate(action)` and retain their input until
its promise resolves. The store calls `EarlyBirdsAuth.requireWrite()` before
queueing work and rechecks actor/permissions against fresh data. Visitors see the
sign-in form and an error; no change is made. This client-side guard complements
GitHub token permissions and shared-data validation.

Render codes with `EarlyBirdsAuth.renderCourtCode(element, code)`. It inserts a
single-star code for a signed-in session or a black sign-in message for visitors,
keeps the raw code out of visitor DOM attributes, and remasks on sign-out.
The `early-birds-session-change` event allows game rendering to track session changes.

Run the model/store regression checks (no server, credentials or dependencies):

```sh
node --test tests/store.test.cjs
```

They simulate two independent clients sharing a GitHub Contents store, including
last-place joins, concurrent edits/bagels/cleanup, lost acknowledgements, Unicode,
directory changes, sign-out during a save, malformed data, failed/uncertain outcomes
and retry input preservation. Live test-repository verification also passed on
2026-10-15; see [the recorded evidence](docs/foundation-verification.json).

Run the browser regression checks with a local preview running, using Node.js
22+ and Chrome (Node 20 can use `--experimental-websocket`):

```sh
TEST_URL=http://127.0.0.1:8000/ node tests/auth.browser.cjs
```

Use the port printed by `go.sh`. On systems without Chrome in the usual macOS
location, set `CHROME_BIN` to its executable. Checks use a temporary Chrome profile,
synthetic tokens and intercepted GitHub responses, and never write to GitHub.
They cover failed sign-in, profile updates, restore, cancellation, storage failure,
cross-tab sign-out, retained-token reuse/forgetting, signed-out reload, code masking, local/GitHub refresh, refresh failure/recovery
and phone/desktop layouts, including edit and delete dialogs. They also cover
booker/Admin controls, independent and same-field edit conflicts, ownership
changes, deletion confirmation/cancellation and failed/uncertain edit/delete
recovery. Denied saves retain original values and only show saved after confirmation.
Add Court checks cover defaults, date shortcuts, court/time limits, star/zero
handling, duplicate submission, duplicate bookings, booker enrolment, failed and
uncertain saves, retained drafts and dialog widths from 320px to 1280px. These
form checks simulate GitHub responses and do not create live bookings.
Card checks cover ordering, simultaneous bookings, calendar/time formatting,
player/reserve labels, empty player lists, literal name rendering, inactive names,
visitor/sign-out code masking and responsive placement at 320/390/768/1280px.
Participation checks cover green/reserve/removal transitions, full-court overflow,
duplicate clicks, overlapping games, no automatic promotion, failed saves and
uncertain-save reconciliation. Model tests also check Admin capacity/overlap rules
and block ordinary players from changing another player.

## Live foundation verification (task 2.6)

Use a dedicated repository such as `mikeertl/early-birds-test` and a token granting
it Contents read/write access. The runner refuses repository names that do not
end in `-test`; it does not change the app's production configuration. It creates
two JSON files in a unique `verification/<run-id>/` folder, then removes those
files after the run. Existing repository files are left alone; test commits remain.

Start the setup page with Node.js 22+ and Chrome installed:

```sh
node tests/live.browser.cjs
```

On Node.js 20, use `node --experimental-websocket tests/live.browser.cjs`.
Open the printed local URL (normally `http://127.0.0.1:8787`), enter the repository
and its token, then click **Run live checks**. Use `CHROME_BIN` for a different
Chrome location or `LIVE_TEST_PORT` for another setup-page port. Enter credentials
only in that local page, never in chat, command arguments or project files.

Two separate Chrome contexts sign in as Mike Ertl and Akiko and exercise real
GitHub reads/writes. A barrier holds their first concurrent writes until both
have read the same SHA, producing a real conflict for the store to reconcile.
One rejected write is injected locally to verify failure recovery, followed by a
real retry and a read from the other session. Longbourn storage sentinels and
independent session identities are checked without opening the real Longbourn app.

The token is held in memory and in temporary test-browser profiles, which are
removed after testing. No credential is included in logs or results. The local
page displays progress and cleanup; an ignored `tests/live-last-result.json`
records sanitised results. Wait for cleanup before stopping the runner with
Ctrl+C. If cleanup fails, the report identifies only the unique test folder that
needs removal.

Task 2.6 passed on 2026-10-15: all 14 live checks succeeded against
`mikeertl/early-birds-test`, including real SHA-conflict reconciliation and
cross-session persistence. Both temporary JSON files were removed. The rejected
write was injected locally; the subsequent retry used real GitHub persistence.
See [the sanitised result](docs/foundation-verification.json). Production data
and Longbourn were unchanged.

The staged plan and version 1 data contract are maintained in
`../@project/01-init.md` in the surrounding workspace.
