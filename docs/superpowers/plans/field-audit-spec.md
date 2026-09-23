# Modão — field audit (SPEC, verbatim)

Modão is an Electron + TypeScript mod manager for GTA San Andreas.
Everything below was observed on a real install. For each numbered item:
  1. VERIFY FIRST against the current codebase before touching anything.
  2. Classify as ALREADY DONE / PARTIAL / MISSING.
  3. Implement only PARTIAL and MISSING. Leave passing code alone.
  4. Add a regression test for every item implemented.

Reference implementation (same stack, already solves several of these):
    https://github.com/DevilNine/san-andreas-mod-manager
    src/main/core/mods/readme-finder.ts       finding + decoding readmes
    src/main/core/mods/encoding.ts            Windows-1252 handling
    src/main/core/mods/install-classifier.ts  archive shape -> install plan
    src/main/core/mods/patterns.ts            folder/name heuristics
    src/main/core/rules/knowledge-engine.ts   the self-learning layer
    src/main/core/rules/knowledge-store.ts    persisted learned rules
    src/main/core/rules/signature.ts          how a mod is fingerprinted
    src/main/core/install/dependency-graph.ts
    src/main/core/install/asi-collision-checker.ts
    src/main/core/install/conflict-checker.ts
    src/main/core/install/install-planner.ts
    src/main/core/install/modloader-organization.ts
    src/main/core/install/backup-service.ts
    docs/mixmods-knowledge.md                 the domain

## 01. Profile switch destroys unmanaged files  [CRITICAL - DATA LOSS]

OBSERVED: after one profile switch, scripts\ went from 14 .asi to 1, and cleo\ from
4 .cleo + 23 .cs to zero. The quarantine folder held only 3 files. MixSets.asi,
SALodLights.asi/.dat/.ini, skygrad.asi, MobileLoad.asi, fix.black_roads.asi,
ped_spec.asi and 23 CLEO scripts were unrecoverable from anywhere on disk.

REQUIRED:
 - A profile switch is a TRANSACTION. Snapshot every file it will remove or overwrite
   (scripts\*.asi, cleo\** including .cs, root loaders, modloader.ini) BEFORE touching
   anything. Verify the snapshot by count + hash. Abort the switch if verification fails.
 - Never delete. Move to quarantine and keep entries until the user clears them.
 - Add "Restore previous state" that rolls a switch back completely.
 - Files present in the game but owned by no managed mod are UNMANAGED. Do not remove
   them on a switch - adopt them into the profile or leave them alone. Deleting
   unmanaged files is what destroyed the install.

VERIFY: does switchProfile snapshot-and-verify before mutating? Is there any code path
that deletes rather than quarantines? Write a test that switches profiles with an
unmanaged file in scripts\ and asserts the file still exists afterwards.

## 02. modloader.ini written as UTF-8  [CRITICAL]

OBSERVED: the app wrote modloader.ini as UTF-8. Mod Loader reads it as Windows-1252,
so every accented mod folder name was corrupted and its priority line silently stopped
matching:
    written:  "Animações de Kung Fu melhoradas=50"
    read as:  "Anima??es de Kung Fu melhoradas=50"
It also produced a mod folder literally named
    [SA] Essentials (pack de mods que não podem faltar no GTA SA

REQUIRED: read AND write modloader.ini, and every MixMods readme, as cp1252.
Readmes are "Leiame (ou morra).txt" (pt-BR) and "Readme (or die).txt" (en) - both cp1252.

VERIFY: grep for readFile/writeFile on modloader.ini and check the encoding argument.
Test with folder names containing ç ã õ é - e.g. "Animações de Kung Fu melhoradas",
"Tradução", "ECG ParticleTXD (versão Normal)".

## 03. Priorities reset, and written for absent mods

OBSERVED: a profile switch rewrote every priority entry to the default 50, discarding
user-set values (70 / 70 / 65), and emitted a line for "Beta Gang Members" which was
not installed in that profile.

REQUIRED:
 - Persist each mod's priority PER PROFILE in SQLite and restore it on switch.
 - Never emit a priority line for a mod absent from that profile.
 - Priority semantics: 1-100, default 50, 0 = folder not loaded, higher wins file
   conflicts. A folder with no entry is treated as 50.

VERIFY: round-trip test - set priorities, switch away, switch back, assert unchanged.

## 04. Mod silently vanished on switch

OBSERVED: "Beta Gang Members" was in the profile's mod set but was not materialised
after the switch, and nothing reported it.

REQUIRED: after materialising a profile, assert every mod in the DB resolved to a real
path. Surface any that did not as a BLOCKING error, not a log line.

VERIFY: is there a post-materialisation reconciliation step? If not, add one.

## 05. Crash address computed wrongly for non-exe modules

OBSERVED: the diagnostics panel always computed 0x400000 + faultOffset. That is only
valid when the faulting module IS gta_sa.exe. For a crash in std.data.dll it produced a
meaningless address and therefore no CrashList match.

REQUIRED:
 - module == "gta_sa.exe"  ->  address = 0x400000 + offset; look up in CrashList.
 - otherwise               ->  display "<module>+<offset>" and DO NOT look it up
   (CrashList indexes executable addresses only). Say so in the UI.
 - A module named "<name>_unloaded" means shutdown fallout, not root cause. Label it and
   prefer the EARLIER event from the same process id.
 - Group events sharing a faulting process id into ONE incident.

VERIFY: feed it a std.data.dll_unloaded event and assert it does not add the image base.

## 06. Image base applied twice

OBSERVED: the same crash was rendered as both
    0x004C67BB   (correct: 0x400000 + 0x000C67BB)
    0x008C67BB   (0x400000 added to an already-based address)

REQUIRED: compute the absolute address exactly once, store it, never re-add on display.

VERIFY: search for every site that adds 0x400000 and confirm there is only one.

## 07. CrashList lookup is broken

OBSERVED: 0x004C67BB and 0x007F3825 ARE both in the bundled CrashList (lines 1113 and
407), yet the UI reported "não está no CrashList" for both.

REQUIRED: match case-insensitively on the bare hex, normalise the 0x prefix and zero
padding, and index EVERY address on every "Erro:" line - including lines listing several:
    "Erro: 0x004C9691 0x00732924 0x00749B7B"
    "Erro: 0x00564192 ... Ou 0x00801D58 0x005D9802 ... 0x007F3851 0x00552A53"

VERIFY: assert 0x004C67BB resolves to "Limite de modelos de pedestres no .ide" and
0x007F3825 to the texture-unload entry.

## 08. No duplicate-.asi detection, and scans miss junctions  [CRITICAL]

OBSERVED: III.VC.SA.LimitAdjuster.asi existed in BOTH scripts\ and
modloader\Open Limit Adjuster\, byte-identical (402,944 B). Two instances patched the
same limits and fought, so the ped-model limit never applied -> crash 0x004C67BB
("Limite de modelos de pedestres no .ide"). FramerateVigilante.SA.asi was doubled too.

THE SCAN MUST FOLLOW JUNCTIONS. Modão materialises mods as directory junctions into its
store; a plain recursive scan walks straight past them, which is exactly why this went
unnoticed. A find-style walk reported "no duplicates" while two copies were live.

ALSO: flag multiple DIFFERENT limit adjusters in one profile. The install had Open Limit
Adjuster plus SimpleLimitAdjuster_Enex active; the CrashList explicitly warns that
stacking limit adjusters causes crashes.

VERIFY: does the install index resolve reparse points? Test with a junctioned mod folder
containing an .asi that also exists in scripts\.

## 09. Mutually exclusive variants all installed at once

OBSERVED (twice):
 - All NINE Proper Shaders quality presets installed simultaneously:
   (0a- only improvements + postfx) (0b- only improvements) (1a- very low)
   (1b- very low - no shadows) (2- low) (3a- medium - DEFAULT) (3b- medium-high)
   (4- high) (5 - very high) - each containing a different ProperShaders.ini.
   Mod Loader logged "No handler or callme for file ProperShaders.ini" nine times.
 - "(configurações)" installed as its own top-level mod. It contained
   (minimalista)/zonetext.ini and (padrão)/zonetext.ini - alternative configs belonging
   to the Zone Text mod, competing with its own cleo/zonetext.ini.

REQUIRED: detect an exclusive group when sibling folders share the same file NAME SET,
or match known alternative patterns:
    quality/numeric prefixes: (0a- ...) (1- ...) 2K / 4K / low / medium / high
    language: PT / EN / RU
    platform: III / VC / SA / SAMP
    parenthesised qualifiers: (original) (shotgun reload) (alt - ...) (configurações)
Present a radio group with the readme's guidance attached ("DEFAULT" in the name is the
preselect; "2K recomendado para 1920x1080"). Install exactly ONE. Keep the rest in the
store, switchable without re-downloading.

A parenthesised folder whose contents duplicate a sibling mod's config filenames is a
VARIANT GROUP FOR THAT MOD - attach it as an option on the parent, never a standalone mod.

VERIFY: feed it the Proper Shaders archive and assert exactly one preset is installed.

## 10. extra / bonus / translations treated as mods

OBSERVED: "Extra/GTA UG/VHud/data" was installed as its own top-level mod. It is an
optional override for VHud's data, meaningless alone - Mod Loader ignored it entirely.

REQUIRED: folders named extra, bonus, (bonus), optional, translations, (translations),
alt, (alt - ...) are ADD-ONS to a base mod. Offer them as options on the parent, and when
enabled merge into the parent's folder or install as a separate higher-priority mod.

VERIFY: assert such a folder never becomes a top-level entry in modloader\.

## 11. .asi separated from its own data

OBSERVED: VHud.asi was placed in scripts\ while blips/, map/, data/, fonts/, crosshair/,
pickups/, radar/, audio/ stayed in modloader\VHud\. The mod was completely inert -
modloader.log printed "No handler or callme" for ~250 files.

THE RULE, confirmed by extracting strings from the binary itself:
    VHud.asi contains "VHud\blips", "VHud\data\blips.dat", "VHud\data\radar.xml",
    "VHud\fonts\%s"
Those are relative paths. GTA SA's process working directory is the GAME ROOT, and
Mod Loader does not change it. So an .asi's sidecar data must resolve from <game root>\.
The .asi itself may live in modloader\ - the DATA goes to the game root.

 - .asi WITH sibling resource folders -> install the folder whole; never lift the .asi out,
   and never move the data next to the .asi either. Both are wrong.
 - BARE .asi (no siblings) -> the ASI directory is fine.

BINARY INSPECTION beats guessing: extract ASCII *and* UTF-16LE strings from a mod's .asi
to learn what it actually opens. This resolved VHud, and also GInput - whose strings
revealed "models\x360btns.txd", "models\ps3btns.txd", "models\sixaxis.txd",
"models\pcbtns.txd" plus the message "GInput could not load pad button textures... The
game will now close." Those must exist at <game root>\models\.

VERIFY: does the classifier ever split an .asi from sibling folders? Add the string-
extraction probe and use its output to place data.

## 12. .asi load order is not interchangeable

OBSERVED: GInputSA.asi was moved from scripts\ into modloader\GInputSA\.

RULES:
 - .asi load order is ALPHABETICAL starting from the modloader folder name. This is NOT
   the priority system, which governs file conflicts only.
 - Early-hooking mods - input, loaders, limit adjusters, patches - belong in the ASI
   directory, not a mod folder. Keep a list; let a learned rule grow it.
 - A readme saying "must load first" means suggest a "$" folder/file prefix (sorts first),
   not a priority number.
 - An orphaned .ini in scripts\ with no matching .asi means the .asi was moved away from
   where it belongs. Detect it and offer to move it back. The install accumulated
   SilentPatchSA.ini, MixSets.ini, SALodLights.ini/.dat, ped_spec.ini, GInputSA.ini and
   FramerateVigilante.ini with no matching .asi.
 - Use Mod Loader's documented NON-DESTRUCTIVE DISABLE - prefix the folder with ". "
   (dot + space) and Mod Loader skips it - instead of deleting, everywhere a mod must be
   deactivated. This is also the right primitive for the UI's enable/disable toggle.

VERIFY: is there any concept of load order distinct from priority? Is ". " used for
disable, or does the app delete/move?

## 13. Writing to modloader\ while the game runs

Mod Loader installs a filesystem watcher and hot-reloads changes. CrashList 0x007F3825:
"Descarregamento de uma textura. Foi relatado após ter instalado/desinstalado algum mod
sem sair do jogo usando ModLoader."

REQUIRED: detect a running gta_sa.exe and REFUSE to install, uninstall or switch profiles
until it exits.

VERIFY: is there any process check before a write? Add one.

## 14. No pre-launch sanity on game-level config

OBSERVED: stream.ini requested 13500 MB of streaming memory. GTA SA is a 32-bit process
capped at 4 GB; this only survives when a limit adjuster clamps it. Without one, CdStream
init received NULL and the game died in RtlEnterCriticalSection writing 0x00000024,
immediately after "Opening file for streaming MODELS\GTA3.IMG".

HEALTH CHECKS TO ADD:
 - stream.ini memory > 2048 AND no limit adjuster active -> BLOCK launch, explain, offer
   a safe value, keep a backup. This file predates the app: warn, never silently rewrite.
 - gta_sa.exe: verify 1.0 US (14,383,616 B, PE timestamp 0x427101CA) and report the
   LARGE_ADDRESS_AWARE bit (0x0020 in PE Characteristics). LAA is required before pushing
   StreamMemory toward 2048.
 - CLEO version vs every installed .cleo plugin's requirement. CLEO+ needs CLEO >= 4.4;
   against 4.3 it throws a FATAL dialog: "The ordinal 22 could not be located in the
   dynamic link library CLEO+.cleo".
 - FPS cap must never exceed 60 - physics, animations and missions break above it.
 - Warn when a mod deploys hundreds of loose .dff/.txd into modloader\ instead of an .img
   (causes stutter, especially on HDD).
 - Non-power-of-two textures inside .txd files (documented crash cause).

VERIFY: is there a pre-launch check screen at all?

## 15. No outdated-build detection  [CRITICAL]

OBSERVED: "Collectibles on Radar" was installed as a 2021-12-26 build (282,112 B). It
crashed the game every launch. Upstream v1.0.4 (253,440 B, 2026) fixed it outright.
The mod is open source with tagged releases:
    https://github.com/kong78/collectibles-on-radar-gta-sa

Before that was found, the crash was blamed on - and each was disproved by test -
GInput, Discord Rich Presence, .asi load order, and a CLEO DmaFix hook collision.
An outdated build is far cheaper to rule out than a bisect.

REQUIRED:
 - For any mod resolvable to a GitHub repo, compare the installed binary against the
   latest release: size + hash, with the PE timestamp as a hint.
 - Surface "outdated - newer release available" in the health check.
 - Run this check FIRST in any crash workflow, before proposing a bisect.
 - Seed known repos: kong78/collectibles-on-radar-gta-sa,
   Flentric/SA.MapCollectibles, CookiePLMonster/SilentPatch,
   GTAmodding/III.VC.SA.LimitAdjuster, JuniorDjjr/CLEOPlus, cleolibrary/CLEO4,
   ThirteenAG/III.VC.SA.WindowedMode.

VERIFY: does any code compare an installed mod against upstream? Almost certainly MISSING.

## 16. Dependency detection — missing capability

OBSERVED: a profile was created with Proper Shaders + GTA V HUD and nothing else.
Proper Shaders names SilentPatch and Open Limit Adjuster and probes for them at runtime
(its log prints "SilentPatch is installed." / "Open Limit Adjuster is installed.").
Neither was in the profile. The game crashed.

SOURCES, in order of authority:
 1. The readme. MixMods readmes state requirements verbatim:
      "-- Download do Essentials Pack: <link>"
      "-- NECESSARIO CLEO+: <link>"
      "ATENCAO: O mod inclui gsx.asi, certifique-se de que voce ja nao o tenha"
    Parse into requires / requires-one-of / conflicts-with / provides edges.
 2. Runtime probe strings inside the .asi binary (item 11's technique).
 3. A seeded, user-editable rule set.

SEED with verified edges:
    Proper Fixes        requires-one-of  [Proper Shaders, SkyGfx]
    Proper Shaders      requires         [ModLoader, SilentPatch, Open Limit Adjuster]
    Proper Shaders      conflicts        [SkyGfx, Ped Spec]
    More Radar Icons    requires         CLEO+
    ItemFinders (Tag/Horse/Snap/Oyster)  requires  CLEO >= 4.4 and CLEO+ >= 1.0.7
    CLEO+               requires         CLEO >= 4.4
    icon/texture packs  requires         their base mod (e.g. Weapon Icons TXD)
    VehFuncs            provides         gsx.asi  (conflict if another copy exists)

RULES:
 - Dependencies resolve INTO THE PROFILE. Satisfied in another profile counts for zero.
 - Resolve before install, show the full plan, install dependencies first.
 - Block launch on an unsatisfied hard dependency and name what needs what.
 - A bare-.asi dependency must be fetchable from its authoritative source, not only from
   a local store that may be pruned. SilentPatchSA.asi vanished from the entire disk when
   a store entry was removed, and the repair could not find it anywhere.

VERIFY: does a dependency graph exist? Is it profile-scoped or global?

## 17. Readme comprehension — missing capability

Every MixMods archive ships "Leiame (ou morra).txt" and/or "Readme (or die).txt",
encoded cp1252 (item 02). The instruction line is formulaic - parse it and obey it:

    "Extraia a pasta X para a pasta do ModLoader."  -> modloader/X/
    "Mova a pasta do mod para a pasta do modloader."  -> modloader/<mod>/
    "Extraia o .asi para a pasta scripts"             -> ASI directory
    "...para a pasta do jogo"                         -> game root

Also extract: required companion mods, stated incompatibilities, variant guidance
("2K recomendado para 1920x1080"), and activation codes ("digite TAGS").

ALWAYS show the parsed instruction beside the raw readme text, allow override, and never
install an archive whose readme failed to parse without asking first.

DESTINATION CLASSES:
    modloader-folder  -> modloader\<mod>\
    asi-plugin        -> the detected ASI directory
    cleo-plugin       -> cleo\   (*.cleo)
    cleo-script       -> cleo\   (*.cs)
    root-file         -> <game root>\   (loaders, .ini, .dat, an .asi's sidecar DATA)
    overlay           -> a file that must overwrite a file inside ANOTHER installed mod
                         (icon packs, texture repaints)
The overlay class is essential and is what generic managers miss.

THE ASI DIRECTORY IS NOT FIXED. Detect it: find where modloader.asi lives and treat that
directory as the ASI directory. Never assume the game root - this repack ships an empty
root with everything under scripts\.

VERIFY: is the readme parsed at all, or is placement inferred purely from archive shape?

## 18. Self-learning knowledge layer — missing capability

Mirror the reference repo's rules/ design: a persisted, versioned knowledge store keyed
by a mod SIGNATURE (file-name set + folder shape + readme fingerprint + hashes), so a rule
learned once applies to that mod forever, and to similar archives by shape.

RULE KINDS:
    install-layout    where this mod's files actually belong (incl. binary-derived paths)
    dependency        requires / requires-one-of / conflicts / provides
    variant-group     which sibling folders are exclusive, and the default pick
    post-install      "after installing X, delete Y" recipes
    priority-override e.g. Loadscreens must outrank a translation shipping LOADSCS.txd
    redundancy        mod A obsoletes mods B, C, D
    verdict           Active / Inert / Mis-installed, learned from modloader.log

LEARNING INPUTS, all grounded, never invented:
    parsed readmes; binary string extraction; modloader.log outcomes after each launch;
    the user's manual corrections (highest weight - if a user moves a file, learn it);
    crash outcomes correlated with the mod set that produced them.

Every stored rule records its SOURCE and a confidence, shown in the UI. A learned rule
must never silently override a readme instruction - surface the conflict.

VERIFY: is there any persistence of learned behaviour, or is every install from scratch?

## 19. Verification and crash workflow — missing capability

VERIFY EVERY INSTALL AGAINST modloader.log. Mod Loader reports, per mod, whether the
install worked:
    "Installing file <X>"              -> contributed files.  ACTIVE
    "No files in modloader\<mod>"      -> present, contributed nothing.  INERT
    "No handler or callme for file X"  -> Mod Loader doesn't manage X. Normal for
                                          .ini/.json/.dds owned by an .asi; but a mod
                                          where EVERY file says this AND which reports
                                          "No files in" is MIS-INSTALLED.
Render a per-mod verdict with the likely cause (its .asi is elsewhere; it is an add-on
with no parent; it is an unpicked variant). This is the single highest-value check in the
app - it turns "my mod does nothing" into one line of text.

CRASH ANALYSIS ORDER:
 1. modloader.log - Mod Loader's own handler writes a register dump, stack dump and
    backtrace. Far better than the Event Log. Parse this FIRST.
 2. Windows Event Log - apply items 05/06/07.
 3. A HANG produces NO Event Log entry at all. Distinguish "crashed" (exception logged)
    from "stopped responding" (nothing logged). The absence of an entry is itself
    diagnostic - say so rather than showing nothing.

DISASSEMBLE WHEN THE ADDRESS IS NOT IN CrashList. Using Python + capstone (no IDA needed):
parse the PE section table, convert the crash VA to a file offset, disassemble around it.
Worked example:
    0x00540720  cmp word ptr [ecx + 0x10E], 0   ; ECX = 0xFFFFFFFF
    0x0054072A  mov al, byte ptr [ecx + 0x11A]
    0x00540737  cmp word ptr [ecx + 0x24], 0    ; NewState.ShockButtonL
    0x0054073E  cmp word ptr [ecx + 0x54], 0    ; OldState.ShockButtonL
0xFFFFFFFF + 0x10E wraps to exactly 0x0000010D - the reported fault address. Those offsets
identify CPad, so it was a CPad "just pressed" query called with this = -1.
Offer this as a "deep analysis" action on any unmatched crash address.

DECODE HOOK ADDRESSES FROM A plugin-sdk .asi WITHOUT SOURCE: MSVC mangles integer template
args as hex nibbles A-P (A=0 .. P=15). In CollectiblesOnRadar.SA.asi the mangled names
$0FDOJIB@ / $0FHFLEE@ / $0FIKKCN@ / $0FLPDKB@ decode to 0x53E981 / 0x575B44 / 0x58AA2D /
0x5BF3A1 - the addresses it hooks. Use this to detect two mods hooking the same address.

BISECTION, done properly - automate Junior_Djjr's documented method: disable half the
mods, launch, record, halve again (~5 rounds for 100 mods). Use Mod Loader's own safe
mode - ExcludeAllMods=true plus an [IncludeMods] safe core - rather than moving files.
Two warnings to surface, both confirmed in practice:
 - More than one mod can be guilty at the same time.
 - A CHANGED CRASH ADDRESS DOES NOT MEAN PROGRESS. Reinstalling mods removed during
   testing can reintroduce the same bug, a new bug, or both. Re-verify with a fresh boot
   after every reinstall step. Test after every single change; never batch edits while
   debugging a live crash.

VERIFY: is modloader.log parsed at all? Is there any per-mod Active/Inert verdict?

## 20. Mod Loader mechanics to encode

- Priority 1-100, default 50, 0 = folder not loaded, higher wins file conflicts.
- Non-destructive disable: prefix the folder with ". " (dot + space).
- .asi load order is alphabetical from the modloader folder name; "$" prefix loads first.
  Distinct from priority.
- Sprite .txd must sit in a folder literally named "txd". NEVER put vehicle/ped/weapon/map
  .txd in a folder named "txd" - Mod Loader treats them as sprites and textures break.
- CLEO mods belong in a "cleo" folder inside the mod so they find sidecar files.
- Don't mix a full data-file replacement (handling.cfg, vehicles.ide) with .txt
  line-install of the same data - the full file always wins.
- .col: don't raise the COL limit; ship the .col plus a .txt with "COLFILE 0 path/to.col".
  COL-limit crash = 0x015632B0.
- New clothes -> folder named "player.img". nodes#.dat -> folder named after its .img.
- Duplicated files across mods cost DISK only, not memory - Mod Loader loads exactly one.
- White/invisible cars or peds = .dff and .txd loaded from different mods (fix by
  priority). A starved streaming budget causes the same visible symptom for another reason.
- Saves live OUTSIDE the game folder:
  %USERPROFILE%\Documents\GTA San Andreas User Files\ (GTASAsf1-8.b, gta_sa.set, Gallery,
  User Tracks). Per-profile saves means swapping that directory, and never deleting it.
