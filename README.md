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
- `bagels.js`: singles/doubles reporting, Admin historical entry, recorded-set review, save/retry drafts and the public result list;
- `users.js`: Admin player creation, rename, deactivation/reactivation and directory save recovery;
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
Games shows booking cards, Bagels shows saved result cards, and Admin provides court management.
Task 3.1 adds the **+ Add Court** button and booking form, and 3.2 adds the game
cards. Tasks 3.3–3.4 add participation controls and action refresh; 3.5 adds court
editing and deletion. Tasks 4.1–4.3 add Bagel eligibility, reporting and the result
list. Task 4.4 adds Admin player-directory management; assigning other players
to courts remains 4.5. Branding artwork and
install icons are later tasks.

## Adding a court

In Games, choose **+ Add Court**. Visitors are prompted to sign in; any signed-in
player can book without Admin mode. The booker is prefilled with your name and
automatically receives a green place. Choose a day from this/next week's quick
buttons, or use the date picker for any future date. Sunday opens the next-week
shortcuts by default. No recurring slots are generated.

In **Admin**, **+ Add Court** also accepts an earlier time today, so a missed
08:00 booking can be entered after the game. It defaults to today's London date
and 08:00, and lets Admin select an active booker, who receives the green place.
Admin can also edit today's completed bookings. Previous dates remain expired;
use historical bagel entry for older results. Games keeps future-only booking,
including when the signed-in player has Admin mode enabled. Duplicate, overlap,
court-number and code validation still apply.

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
Previous London dates are hidden in Games and Admin; today's finished games stay
visible until midnight.

## Managing players (task 4.4)

In **Admin → Players**, use **+ Add player**, **Rename**, **Deactivate** or
**Reactivate**. Names are trimmed and must be nonempty; duplicate names are
rejected ignoring case and surrounding spaces, including inactive players. Use
reactivation for a returning player rather than creating a new identity.

Each player keeps an opaque stable ID. Renaming updates current game names;
recorded bagels retain their saved names. Deactivation removes the player from
sign-in and new-booker choices without removing existing court ownership or
green/reserve membership. Inactive players remain visible in Admin and can be
reactivated under the same ID. Historical bagel entry can still select them for
past results. No hard-delete control or action is provided.

Any active player can select **Show Admin tab** when signing in, matching the
agreed trusted-group model; GitHub still requires a write-capable token. Saving
self-deactivation signs that player out. Another active player can enable Admin
to reactivate them. Even a lost acknowledgement of self-deactivation can be
confirmed as a no-op; inactive players cannot make further directory changes.

Forms retain failed inputs when closed/reopened in the same tab, and one ID is
reused for creation retries. Unconfirmed saves lock inputs until the original
change is reconciled. Independent field edits merge; same-field conflicts keep
typed values and offer **Load latest details** for explicit review/replacement.
Controls disappear when Admin mode ends. Court player assignments remain 4.5.

## Reporting bagels (tasks 4.1–4.2)

Games shows **Bagel?** only to a signed-in green player once the game's one-hour
duration has ended, through the end of that London calendar day. Reserves,
visitors and other players do not get that action. Two-player games qualify;
four green players are not required. The button updates on minute boundaries,
session/data changes and return to the window/tab, including across midnight
and daylight-saving changes. Opening it rechecks current shared data; failed
reads or changed membership cannot confirm stale eligibility.

Admin reporting is in the **Admin** tab: completed courts have a Bagel action,
and **Add historical bagel** does not require a live court or green membership.
Games keeps its ordinary green-player restriction even with Admin mode on.
Historical entry must use a past/current date; saves enforce the existing rules.

Choose **Singles** (one winner/one loser) or **Doubles** (two winners/two losers),
select a distinct player for each position, then **Save 6–0 set**. Games restricts
the choices to green players. Singles may use any two, including players who
continued after doubles. Admin can select any registered players, including
inactive players for historical results, and choose a past/current date without
an existing court. Linked entries use the court's date.

Each set saves stable player IDs, name snapshots, game date and its court ID
(or null for standalone history). Cleanup and renaming do not change that saved
history. The reducer rechecks membership, timing and team validity against fresh
shared data, including when an Admin uses the ordinary Games form.

The dialog shows already-recorded sets before enabling an additional submission.
After saving, choose **Record another 6–0 set** only for a separate set; identical
teams are allowed for genuinely repeated sets. One ID follows each intended set
through double clicks, failed saves and unknown acknowledgements. Failed inputs
survive closing/reopening in the same browser tab. Unknown saves lock the details
until **Retry save** or the global retry confirms the original set. **Refresh
game** reviews current eligibility without dropping typed selections. Drafts are
kept separately by player, Admin mode and source; session changes close the form.

Saved sets appear in the reporting dialog and the public **Bagels** tab. Results
sort by game date newest first, then creation time newest first, then stable ID
for deterministic ties. Each card shows a bagel icon, calendar date, 6–0 score,
Singles/Doubles, green winners with smiles and red losers with sad faces. Text
labels identify both teams independently of colour; decorative icons are hidden
from screen readers. Teams sit side by side on wider screens and stack on phones.

The list uses recorded name snapshots, so inactive/renamed players and deleted
source courts do not change history. Names render as literal text, and dates stay
on the recorded calendar day regardless of the device timezone. Visitors can view
the list; a failed refresh keeps the last good results with the shared stale-data
notice. An empty result list shows the labelled empty state. Admin deletion remains
task 4.6.

The branding bird was confirmed as a **mistle thrush**; artwork remains task 5.1.

## Court expiry and cleanup

The browser checks the London date on minute boundaries and when returning to
the window/tab, so an open page hides old courts at midnight even without a new
read. Dates use Europe/London, including daylight-saving changes. The device's
timezone does not determine expiry. Visitors hide expired courts without writing.

A signed-in refresh removes expired courts from shared data using fresh SHAs
and conflict reconciliation. Ordinary game/bagel writes include cleanup in the
same commit; user-directory saves also attempt state cleanup. Today and future
bookings survive, and bagels retain their source IDs and recorded player names.
There is no server job or periodic network polling.

At midnight, a signed-in open page attempts a refresh/cleanup when no dialog,
pending request or retained failed/uncertain action is present. If busy, it keeps
checking locally on minute boundaries; normal refreshes/writes also clean up.
Cleanup waits for retained player intent to be resolved rather than replacing
that intent. A denied or unconfirmed cleanup shows a separate message and can be
retried with Refresh. Old courts remain hidden, and readable data and player-save
outcomes are preserved. An open form keeps its input; saves revalidate the date.

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
`status.stale`, plus separate maintenance `status.cleanup` (`outcome`, `message`).
Refresh success does not itself imply that a failed action saved.
Rejected save promises carry an `outcome`; if GitHub acknowledged a PUT just
before sign-out, that outcome is `saved` with guidance to refresh, and the action
is not offered for replay.

Supported actions for subsequent forms are:

- `court.add` with `court: { id, date, time, courtNumber, code, bookedBy }`;
- `court.patch` with `courtId`, `changes` and matching `expected` original field values;
- `court.remove` with `courtId`;
- `participation.set` with `courtId`, optional `userId`, and `status: "green" | "reserved" | "none"`;
- `bagel.add` with `bagel: { id, sourceCourtId, date, winnerIds, loserIds }` and optional `asPlayer: true` to retain ordinary-player restrictions in Games even in Admin mode;
- `bagel.remove` with `bagelId`;
- `courts.cleanup` (removes prior London dates; automatic refresh/write cleanup and local midnight checks are enabled);
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

## Stage 3 acceptance (task 3.7)

Run the independent-session browser acceptance test with Node.js 22+ and Chrome:

```sh
node tests/stage3.browser.cjs
```

It starts its own temporary local server and GitHub Contents simulator; no
preview server, credentials or live GitHub access are needed. Five separate
browser contexts book simultaneous courts through the forms, join up to four
green players, race for the last place with a forced SHA conflict, reserve,
remove and reclaim places, and recover a rejected save. Both racing players
remain recorded and refreshed sessions converge. All browser profiles and the
temporary server are removed/stopped afterwards. `CHROME_BIN` selects Chrome;
`STAGE3_RESULT_PATH` optionally saves a JSON report to the supplied path.

Task 3.7 passed on 2026-10-15: all 17 multi-session checks, all 33 model/store
tests and the full browser regression suite passed. This includes London
midnight, both daylight-saving boundaries, open-page expiry, cleanup recovery,
court editing/deletion and responsive layouts. See
[the recorded Stage 3 result](docs/stage3-verification.json). These checks use
isolated simulated shared data. The earlier real GitHub verification is recorded
below; live GitHub was not rerun for 3.7. Production data was unchanged.

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
