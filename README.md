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
- `manifest.webmanifest`: app identity and relative install/start paths.

The planned shared files are `data/users.json` and `data/current.json`.
GitHub Pages will serve the repository root; hosting has not yet been configured
or published as part of this scaffold.

## Current stage

Task 2.1 establishes the app foundation. Tabs, sign-in, shared JSON loading/saving
and game management are subsequent tasks. This scaffold makes no network requests
and does not read or write browser storage. It contains no live bookings, player
seed data or credentials. Branding artwork and install icons are a later task.

Browser-storage keys are namespaced with `early-birds-`; Longbourn keys and data
are never used. GitHub access tokens will be supplied separately and stored only
in the user's browser, never in configuration or committed JSON.

The staged plan and version 1 data contract are maintained in
`../@project/01-init.md` in the surrounding workspace.
