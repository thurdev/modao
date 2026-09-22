# Architecture

How Modão is put together, and why each part is the way it is. Written for
someone about to change the code.

The app's rules, in one line each: the user's install is sacred, every
operation is reversible, nothing is ever deleted, and the catalogue is a way to
find someone else's work rather than a copy of it.

## Processes

```
main                         preload                 renderer
─────────────────────────    ──────────────────      ─────────────────────
fs, net, SQLite, 7-Zip       one typed bridge        React 18, no Node
game folder, Event Log   ←→  a fixed channel list ←→ sandbox: true
                             contextIsolation
```

Everything that touches the disk, the network or the game lives in the main
process. The renderer gets exactly one object on `window.modao`: `invoke`,
restricted to the channel names listed in `src/shared/ipc.ts`, plus two event
subscriptions. No `fs`, no `ipcRenderer`, no remote module, `nodeIntegration`
off and `sandbox` on.

`src/shared` is the only code both sides import: the IPC contract, the domain
types, the game table, the download classifier, the crash address rules, and
the i18n catalogues. It must stay free of Node and Electron imports — the unit
tests bundle it for plain Node, and an `electron` import there breaks them
immediately.

## Data

SQLite via better-sqlite3 in `userData`, with append-only migrations that each
run once inside a transaction (`src/main/db/index.ts`). The schema in outline:

| Table | What it holds |
| --- | --- |
| `game_install` | Each install: path, kind (`sa`/`iii`/`vc`/`sade`), exe fingerprint, ASI directory, Mod Loader and CLEO versions |
| `profile` | Name, colour, notes, which game it belongs to, whether it is active |
| `mod`, `mod_version` | The catalogue: one row per post, one per release |
| `install`, `install_file` | What a profile has installed, and every file it owns with its hash |
| `provides` | Reverse index of file path → install, for conflict detection |
| `submod_state` | Per-folder enable/disable inside one mod |
| `save_snapshot` | Save game snapshots, per profile |
| `crash_report` | Parsed Event Log records, with the faulting module and pid |
| `switch_journal` | Every profile switch: its snapshot manifest, verification and outcome |
| `dependency`, `setting`, `telemetry`, `transaction_log` | Curated dependency graph, settings, local ranking inputs, audit trail |

## The content store

One copy of every mod payload lives in `userData/store/mods/<key>`, keyed by
slug + version + variant. A profile is *materialised* into the game folder:

- a mod folder with nothing overlaying it becomes a **directory junction** —
  instant regardless of size
- a mod something else overlays becomes **per-file hardlinks**, so the overlay
  can replace one file without mutating the shared copy
- a different volume falls back to **copying**

Mod folders routinely run to gigabytes. Nothing is ever duplicated per profile,
and switching profiles moves no bytes.

## A profile switch is a transaction

`src/main/profiles/switchTx.ts`. This is the part that earned the most care,
because the version without it deleted every loose `.asi` and CLEO script a
user had adopted.

```
plan      → work out every file that would move; touch nothing
ingest    → copy anything adopted-but-not-stored into the store, hashing it
snapshot  → copy every file about to be removed or overwritten, verify each
            copy by hash; a mismatch abandons the switch here
apply     → vacate, swap saves, materialise
verify    → does the game folder now hold what the profile says it holds?
```

Steps 1-3 change nothing in the game folder, so a failure before `apply` leaves
the install exactly as it was. Two interlocks carry the weight:

- **`mayRemoveFile`** in `contentStore.dematerialise` — a real file is removed
  only when the caller can say, for that exact path, that a verified copy
  exists elsewhere. Anything it refuses stays and is reported.
- **unmanaged files are never touched.** A file no managed install claims is
  the user's; the plan lists it as untouched and the switch leaves it alone.

Every switch writes a `switch_journal` row with its snapshot manifest, so
"Restore previous state" can put the game folder back and re-activate the
previous profile. A dry run prints the same plan the real switch would execute.

Nothing is deleted anywhere in the app: files leaving the game folder that the
user edited go to `userData/quarantine`, which is never cleared automatically.

## The install pipeline

`src/main/install/`:

```
download → verify → extract → classify → plan → confirm → apply
```

- **download** — `fetcher.ts`. Most MixMods links point at a host that answers a
  plain HTTP client with 403 or an HTML page. Those are opened in a hidden,
  sandboxed `BrowserWindow` with a small page driver that does what a person
  would: reject the cookie wall, press the host's own download control, follow
  the archive link. The rule that makes it correct: a link on the host's own
  domain that merely ends in `.7z` is another *page*; the real file is always
  cross-origin or carries `response-content-disposition`. Everything streams to
  disk — these archives reach several gigabytes — with a stall watchdog rather
  than a total timeout.
- **classify** — `classify.ts` decides where each file goes among six
  destination classes (`modloader-folder`, `asi-plugin`, `cleo-plugin`,
  `cleo-script`, `root-file`, `overlay`), detects variant groups (an archive
  shipping 2K and 4K side by side) and refuses to install either until the user
  picks.
- **readme** — `readme.ts` decodes Windows-1252 (MixMods readmes are pt-BR and
  cp1252) and reads instructions out of the prose.
- **plan** — the user sees every file and its destination before anything is
  written; applying records each file with its hash so uninstall can be
  verified byte-for-byte.

## Mod Loader specifics

- **The ASI directory is found, never assumed.** `detectAsiDirectory` looks for
  where `modloader.asi` actually is: repacks load from `scripts\`.
- **`modloader.ini` is Windows-1252, both ways.** Writing it as UTF-8 turns
  `Animações de Kung Fu melhoradas` into a name that matches no folder, and its
  priority line silently stops applying. `decodeIni` also detects a file an
  older build wrote as UTF-8 so it reads back correctly instead of becoming
  mojibake.
- **The profile's priority block is rewritten whole**, comments kept. A key left
  behind is a priority for a mod that is not in the profile, and Mod Loader
  would happily apply it.
- **Priorities are the user's.** Adoption reads the block belonging to the
  profile, falling back to Mod Loader's own default block and the unscoped
  `[Priority]` section, rather than resetting a hand-tuned load order to 50.

## Conflicts

`src/main/conflicts` plus the format readers in `src/main/formats`: a
RenderWare `.txd` chunk walker (texture names, dimensions, non-power-of-two
detection), `.ifp` animation names, `.img` VER2 directories, and a PE header
reader. Conflicts are computed from `provides`, and the winner follows Mod
Loader's own rule: highest enabled priority above zero, ties broken
alphabetically.

## Diagnostics

- **Crash addressing** (`src/shared/crash.ts`) — `0x400000 + fault offset` is
  the crash address **only** when the faulting module is `gta_sa.exe`; that is
  looked up in the bundled CrashList. A fault inside a DLL reports an offset
  relative to *that* DLL, which Windows does not tell us, so it is shown as
  `module+offset` and never looked up.
- **Incidents** — one dying game writes several Event Log records. They are
  grouped by faulting process id, and the primary event is the earliest one
  whose module Windows did not mark `_unloaded`, because an already-unloaded DLL
  is usually what shutdown ran over rather than the cause.
- Health check, guided bisect and a log timeline round it out.

## The catalogue

MixMods is WordPress. `mixmodsParse.ts` is a pure parser (no database), used
both by the live crawler and by the seed builder, so a crawl and the bundled
catalogue can never disagree. The crawler walks the category archives — not the
sitemap, which cannot say which game a post is for — at one request per second,
honouring robots.txt, validating with ETag/Last-Modified and re-reading a page
at most once a day.

A post is classified per game from its `[SA]` / `[III|VC|SA]` / `[SA:DE]` title
tag and its categories (`gamesOfMod` in `src/shared/games.ts`). Rows indexed
before that existed are classified on read, so an old index needs no re-crawl.

The bundled seed carries a summary and a link, not the author's post; the full
post is fetched from MixMods when the user opens a mod and cached for that user
alone. Paywalled early-access builds are never downloaded, only linked.

## Multi-game

`src/shared/games.ts` is the single table of what differs per game: executables,
save folder, whether Mod Loader / CLEO / ASI apply, where Definitive Edition
`.pak` mods go, whether CrashList covers it. The game is the top-level choice
in the UI and everything below it — profiles, library, conflicts, saves, the
catalogue — belongs to one install. Activating a profile from another game is
refused rather than attempted.

## Renderer

React 18 + Vite, Zustand for state, `motion` for animation, CSS custom
properties for the theme: a zinc neutral scale with one warm sand accent, light
and dark both designed rather than inverted. Motion is used for continuity — a
shared nav marker, a tab pill, staggered lists — never for decoration.

`npm run ui` serves the renderer alone against a mock IPC bridge
(`devBridge.ts`), which is how the UI is iterated without a game folder.

## i18n

pt-BR is the source language and the default; English is the translation and
falls back to Portuguese key by key. Catalogues live in
`src/shared/i18n/sections/`, one file per area, so two people can translate
different screens without touching the same file. `useT()` in the renderer
reads the language from settings, so changing it re-renders without a reload.

## Packaging

`npm run dist` builds, packages with electron-builder (NSIS), then runs
`scripts/verify-package.mjs`, which reads the asar the way Electron does and
fails the build if `package.json` or any entry point does not read back
cleanly. That check exists because a shipped build once died before it could
log anything: one packed file was recorded a byte shorter than it was written
and every entry after it shifted.

The main process writes `userData\logs\main.log` from its first line, and
startup is arranged so the window always opens — a failed migration or an
unreadable catalogue is logged and surfaced inside the app rather than turning
into a process that starts and vanishes.

## Tests

- **Unit** (`tests/core.test.ts`, plain Node) — the `.txd` chunk walker, `.img`
  sector maths, `modloader.ini` round-tripping in cp1252 with accented folder
  names, the priority rules, Windows-1252 readme parsing, the classifier, the
  download classifier and the crash addressing rules.
- **End-to-end** (`src/main/smokeE2E.ts`, inside Electron) — a synthetic game
  folder in a throwaway `userData`, covering adoption that provably changes no
  file, saves that predate the app, a variant install, conflict resolution by
  priority, sub-mods, byte-for-byte uninstall, and the whole switch
  transaction: verified backups, unmanaged files left alone, a restore, and a
  switch that refuses to run because a mod would vanish.

Neither suite touches a real install; the e2e passes its own `--user-data-dir`,
which the data-directory migration explicitly honours.
