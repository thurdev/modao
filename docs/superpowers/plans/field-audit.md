# Modão field audit — plan

Spec: `docs/superpowers/plans/field-audit-spec.md` (the 20 numbered items).
Audit reports (read the one for your item before writing code — they carry the
exact line citations behind every verdict):
`.superpowers/sdd/field-audit/audit-01-04.md`, `audit-05-08.md`, `audit-09-12.md`,
`audit-13-16.md`, `audit-17-20.md`.

## Audit results

| Item | Verdict | Action |
|---|---|---|
| 01 profile switch destroys unmanaged files | PARTIAL — live data loss | Task 1 |
| 02 modloader.ini cp1252 | ALREADY DONE | none |
| 03 per-profile priority | ALREADY DONE | none |
| 04 post-materialisation reconciliation | PARTIAL | Task 2 |
| 05 crash address for non-exe modules | ALREADY DONE | regression test only (Task 3) |
| 06 image base applied twice | PARTIAL | Task 3 |
| 07 CrashList lookup | PARTIAL | Task 3 |
| 08 duplicate .asi, junction-blind scan | MISSING | Task 4 |
| 09 exclusive variant groups | PARTIAL | Task 9 |
| 10 extra/bonus/translations add-ons | PARTIAL | Task 9 |
| 11 .asi split from its data / binary probe | PARTIAL | Task 10 |
| 12 .asi load order, ". " disable | MISSING | Task 11 |
| 13 writing while the game runs | MISSING | Task 5 |
| 14 pre-launch sanity | PARTIAL | Task 6 |
| 15 outdated-build detection | MISSING | Task 8 |
| 16 dependency graph | PARTIAL | Task 7 |
| 17 readme comprehension | PARTIAL | Task 12 |
| 18 self-learning knowledge layer | PARTIAL | Task 13 |
| 19 verification and crash workflow | PARTIAL | Task 14 |
| 20 Mod Loader mechanics (8/13 encoded) | PARTIAL | Task 11 + Task 15 |

## Global Constraints

- **Leave passing code alone.** Items 02, 03 and 05's production code are ALREADY
  DONE — do not refactor them. Item 05 gets a regression test and nothing else.
- Every task adds regression tests to `tests/core.test.ts` (pure units) and/or
  `src/main/smokeE2E.ts` (filesystem end-to-end), matching each file's existing
  style — plain `test('name', () => …)` / `check(...)`, no new test framework.
- `npm run typecheck` and `npm run test:units` must pass before a task is done.
  Run them. Paste the tail of the output into your report.
- Encoding: `modloader.ini` and MixMods readmes are Windows-1252 — always through
  `readIniFile`/`writeIniFile` (`src/main/game/modloaderIni.ts`) and
  `src/main/install/readme.ts`. Never `utf8`, never a new `latin1` read path.
- **Never delete a game file.** Quarantine it. Quarantine entries persist until
  the user clears them.
- Mod Loader's non-destructive disable is the folder-name prefix `". "` (dot +
  space). It is the primitive for every deactivation, including the UI toggle.
- Priority is 1-100, default 50, 0 = folder not loaded, higher wins file
  conflicts. Priority governs FILE CONFLICTS ONLY. `.asi` load order is a
  separate, alphabetical concept; `$` sorts first.
- The image base `0x400000` is added exactly once, at exactly one site, and only
  when the faulting module is `gta_sa.exe`.
- The ASI directory is detected (where `modloader.asi` lives), never assumed.
- No new runtime dependency without saying so in your report. Python, capstone
  and any other external toolchain are NOT available — item 19's disassembly must
  be implemented in TypeScript or not at all.
- Do not touch `RESTAURAR-ARQUIVOS.ps1`, `package.json`, `src/main/install/archive.ts`
  or `scripts/recover-plugins.ts` beyond what your task requires — they carry
  uncommitted in-flight work.
- User-facing strings are bilingual: add to BOTH `src/shared/i18n/sections/*` pt-BR
  and en blocks. A missing key is a typecheck failure.

---

## Task 1 — Item 01: stop the profile switch destroying unmanaged files  [CRITICAL]

Read `.superpowers/sdd/field-audit/audit-01-04.md` section 01 first — it has the
line citations. Spec section `## 01`.

What already works, and must not be rebuilt: the snapshot, the count+hash
verification, the journal, and the restore path in `src/main/profiles/switchTx.ts`.

Three destructive holes to close:

1. **`src/main/profiles/materialize.ts:81` passes the install's OWN targets as
   `ownedPaths`.** `src/main/install/engine.ts:522` passes the paths owned by
   *other* installs, which is the correct meaning.
   `src/main/store/contentStore.ts:162-165` therefore judges every target
   "already ours" and calls `removeLinkOrDir` (`src/main/util/fsx.ts:161-165`,
   a recursive force remove) with no backup. Fix the caller so `backupIfForeign`
   can actually see a foreign file, and make the quarantine copy happen before
   any removal.
2. **`src/main/profiles/switchTx.ts:214` filters colliding paths out of
   `plan.unmanaged`**, so a file about to be destroyed is not even reported.
   Colliding unmanaged files are the ones that matter most: report them.
3. **`src/main/profiles/manager.ts:387` calls `dematerialiseProfile(current.id, {})`,
   which deletes unconditionally.** Route it through quarantine.

Also required by the spec and not yet true: a file in the game owned by no managed
install is UNMANAGED and must survive a switch — adopted into the profile or left
alone, never removed.

Tests (both suites):
- `tests/core.test.ts`: a unit test over the `ownedPaths` decision in
  `contentStore` proving a foreign path is backed up and an owned path is not.
- `src/main/smokeE2E.ts`: switch profiles with an unmanaged `scripts\MixSets.asi`
  that **collides with an incoming install's target path** and assert the file
  still exists afterwards (in place or in quarantine, with the quarantine entry
  listed). The existing E2E fixture passes only because its unmanaged file
  collides with nothing — do not weaken it, add the colliding case.

## Task 2 — Item 04: post-materialisation reconciliation must block

Read `.superpowers/sdd/field-audit/audit-01-04.md` section 04. Spec section `## 04`.

`verifySwitch` exists and runs but never throws. `src/main/profiles/manager.ts:348-351`
flips the profile active *before* the check, and `src/renderer/state/store.ts:169`
discards the verification result.

Required: after materialising, assert every mod in the DB for that profile resolved
to a real path on disk. Any that did not is a BLOCKING error surfaced in the UI,
not a log line. The profile must not be recorded active while reconciliation is
failing, and the user must be offered the existing rollback.

Test: `src/main/smokeE2E.ts` — materialise a profile whose DB row points at a store
entry that is missing from disk; assert the switch reports a blocking failure, that
the previously active profile is still the active one, and that the failure names
the mod.

## Task 3 — Items 06 + 07 (+ 05 regression test): crash addressing and CrashList

Read `.superpowers/sdd/field-audit/audit-05-08.md` sections 05, 06, 07.
Spec sections `## 05`, `## 06`, `## 07`.

**Item 05 is ALREADY DONE — add its regression test only, change no production
code for it.** Test: feed `resolveCrashAddress` a `std.data.dll_unloaded` event and
assert it does NOT add the image base, renders as `<module>+<offset>`, and is not
looked up in CrashList.

**Item 06 (PARTIAL).** `src/main/diagnostics/eventlog.ts:256` feeds modloader.log's
**absolute** crash address into `resolveCrashAddress` as if it were an offset, so
the fixture address `0x005B8E55` (`tests/core.test.ts:528`) renders as `0x009B8E55`
— the `+0x400000`-twice shape the field report describes. `eventlog.ts:275` then
stores it in `fault_offset`, so `listCrashes` (`:203`) re-derives the same wrong
value. Make the absolute address be computed exactly once and stored; an
already-absolute source must never be re-based. Keep the single base-adding site.

Test: a unit test asserting the modloader.log-sourced fixture address stays
`0x005B8E55`, plus a test that no second `+ IMAGE_BASE` is reachable from the
stored value.

**Item 07 (PARTIAL).** In `src/main/diagnostics/crashlist.ts`: the normaliser at
`:6-9` is correct; the entry regex at `:29` is `^`-anchored on hex, so `Erro:`
lines never match, only one address per line is captured, and `Ou` is unhandled.
Rewrite the parser to index EVERY address on every `Erro:` line, including lines
listing several and lines joined by `Ou`, matching case-insensitively on the bare
hex with the `0x` prefix and zero padding normalised.

`resources/seed/CrashList.txt` is a 20-line hand-written stub and neither
`0x004C67BB` nor `0x007F3825` is in it. **Do not invent CrashList entries.** Add
only the two entries the spec itself states verbatim (`0x004C67BB` → the
pedestrian-model-limit-in-`.ide` entry, `0x007F3825` → the texture-unload entry,
text as quoted in spec items 07 and 13), each marked in the file as
spec-sourced, and add a refresh path that can replace the bundled file from
upstream later. Say clearly in your report that the bundled list remains a stub.

Test: assert `0x004C67BB` resolves to the pedestrian-model-limit entry and
`0x007F3825` to the texture-unload entry; assert a multi-address `Erro:` line and
an `Ou` line index every address on them.

## Task 4 — Item 08: duplicate .asi across junctions, and stacked limit adjusters

Read `.superpowers/sdd/field-audit/audit-05-08.md` section 08. Spec section `## 08`.

`fsx.walk` (`src/main/util/fsx.ts:24-61`) already follows junctions, but no caller
points it at the game tree, and `adoptIntoProfile` (`src/main/profiles/manager.ts:501-507`)
reads only `modloader\` and explicitly skips junctions.

Required:
- A scan of the live game tree that resolves reparse points, covering the ASI
  directory, `scripts\`, `cleo\` and every materialised mod folder under
  `modloader\` including junctioned ones.
- Hash-based duplicate-`.asi` detection across those locations.
  `providesKey` (`src/main/conflicts/index.ts:123-126`) keys `scripts/x.asi` and
  `modloader/M/x.asi` differently, so the conflict index structurally cannot see
  this — the duplicate check needs its own keying by **file name + content hash**.
- Flag two or more DIFFERENT limit adjusters active in one profile.
  `limitAdjusterNames()` is currently only used via `.some()`; count distinct ones.
- Surface both as health-check findings with the file paths involved.

Test: `src/main/smokeE2E.ts` — a junctioned mod folder containing an `.asi` that
also exists in `scripts\`, byte-identical; assert the duplicate is detected and
both paths are named. Plus a unit test for the stacked-limit-adjuster count.

## Task 5 — Item 13: refuse every write while gta_sa.exe is running

Read `.superpowers/sdd/field-audit/audit-13-16.md` section 13. Spec section `## 13`.

No process probe exists. The only pre-write gate is `requireWritableGame()`
(`src/main/ipc.ts:257`), an ACL probe; 11 write handlers have it and 8 more do not
(including `game:adopt`, `saves:restore`, `health:bisectResult`, `health:bisectAbort`).

Required:
- A running-process probe for the game executable (Windows: `tasklist` /
  `Get-Process` via the existing child-process helpers — do not add a dependency).
  Match the detected game's executable name, not a hardcoded `gta_sa.exe`, so it
  works for the III/VC/SA:DE targets the app already supports.
- A hard refusal — install, uninstall and profile switch must fail with a clear
  bilingual message naming the running process, not a warning the user can click
  past.
- Audit every IPC write handler and gate them all. List in your report which
  handlers you gated and which you deliberately left ungated, with the reason.

Test: unit-test the guard's decision function with a fake process lister (running
vs not running vs a same-named process in another directory).

## Task 6 — Item 14: make the blocking pre-launch checks actually block

Read `.superpowers/sdd/field-audit/audit-13-16.md` section 14. Spec section `## 14`.

All six checks exist. The defect is that `HealthReport.blocking`
(`src/main/diagnostics/health.ts:196`) has no consumer: `game:launch`
(`src/main/ipc.ts:387`) and `src/renderer/App.tsx:83` launch unconditionally.

Required:
- `game:launch` consults the health report and refuses while a blocking finding
  stands, naming the finding. The UI surfaces it with the existing offered fix
  (the safe `stream.ini` value, backup kept — warn, never silently rewrite).
- The CLEO check (`health.ts:97-127`) currently hardcodes "CLEO+ needs ≥ 4.4".
  Make it per-plugin: every installed `.cleo` plugin's stated requirement against
  the installed CLEO version, so a future plugin is covered without a code change.

Leave checks 2, 4, 5 and 6 alone — they already behave as the spec asks.

Test: unit-test the launch gate against a report with a blocking finding, a report
with only warnings, and a clean report. Unit-test the per-plugin CLEO comparison
including the CLEO+ ≥ 4.4 case that produced the ordinal-22 dialog.

## Task 7 — Item 16: complete the dependency graph

Read `.superpowers/sdd/field-audit/audit-13-16.md` section 16. Spec section `## 16`.

The graph is real and correctly profile-scoped (`src/main/deps/resolver.ts:31-39`,
`src/main/install/engine.ts:188`). Do not re-architect it. Four gaps:

1. `provides` is unmodelled — the seeded `sa-vehfuncs provides gsx.asi` row falls
   through to the `requires` branch and reports a phantom missing dependency.
   Model `provides` and make a second provider of the same file a CONFLICT.
2. `more-radar-icons requires cleoplus` is silently dropped at load
   (`src/main/catalog/service.ts:139`). Find out why and fix it; a dropped seed
   must at minimum be reported, never silently discarded.
3. Add the seed edges from the spec that are absent: the ItemFinders family
   (Tag/Horse/Snap/Oyster → CLEO ≥ 4.4 and CLEO+ ≥ 1.0.7) and icon/texture packs
   → their base mod.
4. Block launch on an unsatisfied hard dependency, naming what needs what. Reuse
   the gate Task 6 adds to `game:launch` — coordinate with its shape rather than
   adding a second gate.

Test: unit tests for a `provides` edge satisfying a requirement, for two providers
of the same file conflicting, for the previously-dropped seed now loading, and for
the launch block naming the unsatisfied edge.

## Task 8 — Item 15: outdated-build detection against upstream releases

Read `.superpowers/sdd/field-audit/audit-13-16.md` section 15. Spec section `## 15`.

Nothing compares an installed binary to an upstream release; no seeded repo list
exists; `startBisect` (`src/main/diagnostics/bisect.ts:49`) runs no precondition.

Required:
- For a mod resolvable to a GitHub repo, compare the installed binary against the
  latest release: size + hash, with the PE timestamp as a hint (`src/main/game/pe.ts`
  already reads PE headers — reuse it). Use the app's existing HTTP layer
  (`src/main/catalog/http.ts`) and its existing GitHub release resolution; add no
  dependency. Network failure must degrade to "unknown", never to "outdated".
- Surface "outdated — newer release available" as a health-check finding.
- Run this check FIRST in the crash workflow: `startBisect` refuses to propose a
  bisect until the outdated check has run, and reports any outdated mod as the
  cheaper thing to rule out.
- Seed the repo list: `kong78/collectibles-on-radar-gta-sa`,
  `Flentric/SA.MapCollectibles`, `CookiePLMonster/SilentPatch`,
  `GTAmodding/III.VC.SA.LimitAdjuster`, `JuniorDjjr/CLEOPlus`, `cleolibrary/CLEO4`,
  `ThirteenAG/III.VC.SA.WindowedMode`.

Test: unit-test the comparison with a stubbed release fetcher — same size+hash =
current, different = outdated, fetch failure = unknown; and assert `startBisect`
surfaces an outdated mod before proposing a bisect.

## Task 9 — Items 09 + 10: variant groups and add-on folders

Read `.superpowers/sdd/field-audit/audit-09-12.md` sections 09 and 10.
Spec sections `## 09`, `## 10`.

Item 09 — groups are detected (including by shared file NAME SET) and exactly one
installs. Two gaps:
- Unchosen options are never ingested into the store
  (`src/main/store/contentStore.ts:33-53` copies only `plan.files`), and there is
  no IPC to switch to another option. Keep every option in the store and make the
  choice switchable without re-downloading.
- A parenthesised config folder still installs standalone: the probe produced
  `modloader/(configurações)/(minimalista)/zonetext.ini` beside
  `modloader/Zone Text/`. A parenthesised folder whose contents duplicate a sibling
  mod's config filenames is a VARIANT GROUP FOR THAT MOD — attach it as an option
  on the parent, never a standalone mod.

Item 10 — `extra|bonus|(bonus)|optional|translations|alt` are matched and excluded
(`src/main/install/classify.ts:213`, `:527-538`) but the `^\(?…\)?$` anchor misses
`(alt - ...)`: the probe produced a top-level `modloader/(alt - blue paint)/` with
zero warnings. Fix the anchor, and offer add-ons as enableable options on the
parent (merge into the parent's folder, or install as a separate higher-priority
mod) instead of dropping them to `docs`.

Tests: the Proper Shaders nine-preset shape installs exactly one preset and keeps
eight switchable in the store; `(alt - blue paint)` never becomes a top-level entry
in `modloader\`; `(configurações)` attaches to Zone Text.

## Task 10 — Item 11: let the binary probe decide where an .asi's data goes

Read `.superpowers/sdd/field-audit/audit-09-12.md` section 11. Spec section `## 11`.

The classifier already never splits an `.asi` from its siblings
(`asiOwnsResources`, `emitAsiBundles`, `rejoinSplitAsi`) — keep that. And
`src/main/formats/strings.ts` already extracts ASCII **and** UTF-16LE into
`{paths, rootFolder, configs, probes, modules}`.

The defect: the probe's only callers are `src/main/install/engine.ts:211` (learn)
and `:696` (dependency probes), both *after* `classifyTree` at `engine.ts:124`;
`classify.ts` never imports it. `paths`, `configs` and `modules` have no production
consumer, so the one source of ground truth about where a plugin's data belongs
can only raise a warning — it never changes a `targetRelative`.

Required: run the string probe during classification and let its output place the
sidecar data. An `.asi` whose strings name relative paths (`VHud\data\blips.dat`,
`models\x360btns.txd`) means those files resolve from the GAME ROOT, because GTA
SA's working directory is the game root and Mod Loader does not change it. The
`.asi` itself may live in `modloader\`; the DATA goes to the game root. A bare
`.asi` with no siblings belongs in the detected ASI directory.

Tests: a synthetic `.asi` fixture carrying `VHud\data\blips.dat` and `VHud\fonts\%s`
as ASCII and a UTF-16LE path, asserting the plan puts the data at the game root and
never lifts the `.asi` away from its siblings; and the GInput shape
(`models\x360btns.txd` and friends) landing at `<game root>\models\`.

## Task 11 — Item 12 + item 20's disable rule: load order and ". " non-destructive disable

Read `.superpowers/sdd/field-audit/audit-09-12.md` section 12 and
`.superpowers/sdd/field-audit/audit-17-20.md` section 20. Spec sections `## 12`
and the first two bullets of `## 20`.

Nothing here exists. Required:

1. **A load-order concept distinct from priority.** `.asi` load order is
   alphabetical from the modloader folder name and governs nothing about file
   conflicts. Model it, show it, and keep the two ideas separate in the UI copy.
2. **Early-hooking mods belong in the ASI directory**, not a mod folder — input
   handlers, loaders, limit adjusters, patches. Ship a seed list and let a learned
   rule (Task 13's store) grow it.
3. **A readme saying "must load first" suggests a `$` prefix**, not a priority
   number. `$` currently appears only in a warning string
   (`src/main/install/classify.ts:746-758`).
4. **Orphaned `.ini` in the ASI directory with no matching `.asi`** — detection
   exists at `src/main/diagnostics/health.ts:375-400` but offers no move-back and
   has no test. Add the offered fix and the test.
5. **`". "` non-destructive disable.** Disable currently removes files
   (`src/main/profiles/materialize.ts:168-191`, `src/main/library/index.ts:178`
   `fsp.rm`) plus priority 0. Replace that with the documented Mod Loader
   primitive: rename the folder to `". " + name`, which Mod Loader skips. Recognise
   the prefix everywhere a folder name is read, so a folder disabled by hand is
   understood. This is the UI enable/disable toggle's primitive.

Tests: disable then enable round-trips a mod folder through `". "` and back with
no file removed; an orphaned `.ini` is detected and the offered move-back names the
`.asi` it belongs with; load order is reported independently of priority.

## Task 12 — Item 17: readme comprehension, the two remaining gaps

Read `.superpowers/sdd/field-audit/audit-17-20.md` section 17. Spec section `## 17`.

Most of this item is already done — the readme is genuinely parsed, all four
formulaic pt-BR instruction lines are recognised, all six destination classes
including `overlay` have real writers, the ASI directory is detected via
`modloader.asi`, and the parsed instruction is shown beside the raw text with an
override. **Do not rebuild any of that.**

Two gaps only:
- Activation codes are not extracted (`digite "TAGS"` and the same shape for other
  mods). Extract them and surface them on the mod, so the user is told how to turn
  the mod on in-game.
- A readme that parses to zero instructions raises no warning. The spec says never
  install an archive whose readme failed to parse without asking first — surface it
  and require an explicit confirmation.

Tests: a cp1252 readme fixture containing an activation code yields it; a readme
with no recognisable instruction produces the ask-first warning.

## Task 13 — Item 18: finish the self-learning knowledge layer

Read `.superpowers/sdd/field-audit/audit-17-20.md` section 18. Spec section `## 18`.

The store is real: versioned SQLite, keyed by exact + shape signature, with a
source and a weight per rule. Keep it. Gaps:

- Only 4 of 7 rule kinds have writers. `variant-group`, `post-install` and
  `priority-override` are type-only; `redundancy` is borrowed for crash sets. Give
  each of the three its own writer, fed by real evidence: variant groups from
  Task 9's detection, post-install from readme recipes, priority-override from a
  user's manual priority change.
- `learnCrash` is dead code — wire it, and give crash correlation its own kind
  rather than borrowing `redundancy`.
- User corrections are learned as `inference` weight 20. The spec says the user's
  manual correction carries the HIGHEST weight — if a user moves a file, learn it
  as such.
- Confidence is stored but never shown. Show source and confidence in the UI.
- A learned rule must never silently override a readme instruction — surface the
  conflict.

Tests: each new rule kind round-trips through the store; a user correction
outranks an inference for the same signature; a learned rule conflicting with a
readme instruction is reported rather than applied silently.

## Task 14 — Item 19: the crash workflow's remaining depth

Read `.superpowers/sdd/field-audit/audit-17-20.md` section 19. Spec section `## 19`.

Already done, do not rebuild: `modloader.log` is parsed as cp1252, per-mod
ACTIVE / INERT / MIS-INSTALLED verdicts with causes exist, the modloader.log crash
is read before the Event Log, hang-versus-crash is distinguished including the
"no entry at all is itself the diagnosis" message, and bisection uses
`ExcludeAllMods` + `[IncludeMods]` and surfaces both warnings.

Gaps:
- The modloader.log crash address is never looked up in CrashList. Look it up
  (via Task 3's fixed parser — depend on its shape, do not duplicate it).
- The register dump, stack dump and backtrace that Mod Loader's own handler writes
  are not parsed. Parse them and show them.
- No deep-analysis action for an unmatched address. Implement it **in TypeScript**
  — parse the PE section table (`src/main/game/pe.ts` already reads PE headers),
  convert the crash VA to a file offset, and show the bytes around it. Python and
  capstone are not available; if a full disassembler is out of scope, ship the
  VA→file-offset conversion plus a hex window and say so plainly in your report
  rather than pretending to disassemble.
- MSVC `$0...@` mangled-hex decoding is absent (nibbles A-P, A=0..P=15). Implement
  the decoder and use it to detect two mods hooking the same address.

Tests: the four `CollectiblesOnRadar.SA.asi` mangled names
`$0FDOJIB@ / $0FHFLEE@ / $0FIKKCN@ / $0FLPDKB@` decode to
`0x53E981 / 0x575B44 / 0x58AA2D / 0x5BF3A1`; two mods hooking one address are
flagged; a VA converts to the right file offset for a synthetic PE section table.

## Task 15 — Item 20: the five unencoded Mod Loader mechanics

Read `.superpowers/sdd/field-audit/audit-17-20.md` section 20. Spec section `## 20`.
Eight of thirteen are encoded. The `". "` disable is Task 11's. These four remain:

1. **Sprite `.txd` must sit in a folder literally named `txd`** — only the negative
   half is encoded (never put vehicle/ped/weapon/map `.txd` in a `txd` folder).
   Encode the positive rule too.
2. **Don't mix a full data-file replacement (`handling.cfg`, `vehicles.ide`) with a
   `.txt` line-install of the same data** — the full file always wins. Detect the
   mix and warn.
3. **`nodes#.dat` goes in a folder named after its `.img`.**
4. **White/invisible cars or peds = `.dff` and `.txd` loaded from different mods**,
   fixed by priority. Note in the finding that a starved streaming budget produces
   the same visible symptom for a different reason, so the two are distinguished.

Tests: one unit test per rule, in `tests/core.test.ts`, using the existing
classifier/conflict test style.

## Task 16 — README.md brought up to date (LAST, after the final review)

Runs only after every other task has landed and the final whole-branch review is
clean. `README.md` predates this branch and no longer describes what the app does.

Bring it up to date against the code as it stands at that point, not against this
plan's prose. Cover what the audit added and changed:
- the profile switch as a verified transaction — snapshot, hash check, quarantine
  instead of deletion, restore-previous-state, and the rule that unmanaged files
  are never removed;
- the hard refusal on any write while the game is running;
- crash diagnosis: image base applied once and only for `gta_sa.exe`, CrashList
  lookup, modloader.log parsing and per-mod Active/Inert/Mis-installed verdicts;
- whatever the remaining tasks ship (duplicate-`.asi` detection across junctions,
  pre-launch blocking checks, outdated-build detection, the dependency graph,
  variant groups and add-ons, `". "` non-destructive disable, the knowledge layer).

Keep the existing tone, structure and language of the file. State plainly anything
that is still a stub — in particular that the bundled `CrashList.txt` is an
excerpt, not the full community list. Do not claim a capability no task shipped.
No version bump, no changelog invention, no marketing copy.
