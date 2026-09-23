import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { getDb } from './db'
import { addGame, activeGame, setActiveGame } from './game/detect'
import {
  adoptInstall,
  adoptIntoProfile,
  activateProfile,
  createProfile,
  listProfiles,
  restorePreviousState,
  SwitchVerificationError,
  unmanagedContent
} from './profiles/manager'
import { listJournals, planSwitch, verifySnapshot } from './profiles/switchTx'
import { storeDir } from './store/contentStore'
import { detectExistingSaves, listSnapshots } from './profiles/saves'
import { clearCache, storageReport } from './ipc'
import { Paths } from './util/paths'
import { applyPlan, createPlan, choose, uninstall } from './install/engine'
import { listInstalled, setPriority, setSubModEnabled, switchVariant } from './library'
import { listConflicts } from './conflicts'
import { readIniFile, readKeys, getSection } from './game/modloaderIni'
import { walk, sha256File, createJunction, removeLinkOrDir } from './util/fsx'
import { V1_US_SIZE, V1_US_TIMESTAMP } from './game/pe'
import { runHealthCheck } from './diagnostics/health'
import { duplicateAssetCheck, scanGameTree, scanGameTreeAssets, stackedAdjusterCheck } from './diagnostics/duplicateAssets'
import { t } from './util/i18n'
import type { InstalledMod, SubMod } from '@shared/types'

/**
 * End-to-end self-check against a synthetic game folder. Run with
 * MODAO_SMOKE=2 and a throwaway --user-data-dir. Covers adoption,
 * installation with a variant, conflict resolution by priority, the import of
 * save games that predate Modão, profile switching with isolated saves,
 * storage accounting, and byte-for-byte uninstall.
 */
export async function runE2E(): Promise<number> {
  let failures = 0
  const check = (name: string, ok: boolean, extra?: unknown): void => {
    if (ok) console.log(`  PASS  ${name}`)
    else {
      failures++
      console.log(`  FAIL  ${name}`, extra ?? '')
    }
  }

  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'modao-e2e-'))
  const game = path.join(tmp, 'GTA San Andreas')

  // --- a believable v1.0 US install -----------------------------------------
  await fsp.mkdir(path.join(game, 'scripts'), { recursive: true })
  await fsp.mkdir(path.join(game, 'modloader', 'Old Cars', 'models'), { recursive: true })
  await fsp.mkdir(path.join(game, 'cleo'), { recursive: true })
  await fsp.writeFile(path.join(game, 'gta_sa.exe'), fakePe(V1_US_SIZE, V1_US_TIMESTAMP, 0x010e))
  // Repack layout: the ASI loader reads from scripts\, not the game root.
  await fsp.writeFile(path.join(game, 'scripts', 'modloader.asi'), fakePe(4096, 0x60000000, 0x2102))
  await fsp.writeFile(path.join(game, 'vorbisFile.dll'), fakePe(4096, 0x60000000, 0x2102))
  await fsp.writeFile(path.join(game, 'modloader', 'Old Cars', 'models', 'infernus.dff'), 'vanilla-ish car')
  await fsp.writeFile(path.join(game, 'modloader', 'Old Cars', 'models', 'LOADSCS.txd'), 'old loadscreen')
  await fsp.writeFile(
    path.join(game, 'modloader', 'modloader.ini'),
    '; hand written by the user\r\n[Config]\r\nIgnoreAllFiles=0\r\n\r\n[Profiles.Default.Priority]\r\nOld Cars=60\r\n'
  )

  const before = await snapshotDir(game)

  const installed = await addGame(game, 'E2E install')
  setActiveGame(installed.id)
  check('game adopted', activeGame()?.path === game)
  check('exe recognised as stock v1.0 US', installed.isV1UsOriginal, { size: installed.exeSize, ts: installed.exeTimestamp })
  check('LARGE_ADDRESS_AWARE reported as not set', installed.largeAddressAware === false)
  check(
    'ASI directory detected as scripts\\, not assumed to be the root',
    installed.asiDirectory === path.join(game, 'scripts'),
    installed.asiDirectory
  )
  check('ASI loader found', !!installed.asiLoader)

  // --- save games that were on this machine before Modão -----------------
  const saves = process.env['MODAO_USER_FILES']!
  await fsp.mkdir(saves, { recursive: true })
  await fsp.writeFile(path.join(saves, 'GTASAsf3.b'), 'campaign from before Modão existed')
  await fsp.writeFile(path.join(saves, 'gta_sa.set'), 'the user own settings')
  const savesBefore = await snapshotDir(saves)

  const detectedBefore = await detectExistingSaves()
  check('saves already in the user files folder are detected', detectedBefore.found && detectedBefore.slots.length === 1, detectedBefore.slots)
  check('gta_sa.set noticed alongside the slots', detectedBefore.hasSettings)
  check('those saves belong to no profile yet', detectedBefore.importedIntoProfileId === null)

  const adopted = await adoptInstall('Adopted')
  check('existing mod folder indexed', adopted.adopted === 1, adopted.report)
  const afterAdopt = await snapshotDir(game)
  check('adoption moved and changed nothing', sameTree(before, afterAdopt), diff(before, afterAdopt))

  const adoptedLib = listInstalled(adopted.profileId)
  check('existing priority read from modloader.ini', adoptedLib[0]?.priority === 60, adoptedLib[0])

  const savesAfterAdopt = await snapshotDir(saves)
  check('adoption left the live save folder byte-for-byte intact', sameTree(savesBefore, savesAfterAdopt), diff(savesBefore, savesAfterAdopt))
  check(
    'adoption reports exactly what it copied and where',
    adopted.report.some((line) => line.startsWith('Saves: copied') && line.includes(saves) && line.includes('1 save slot(s)')),
    adopted.report
  )
  check(
    'existing saves copied into the profile store',
    fs.existsSync(path.join(Paths.profileSaves(adopted.profileId), 'GTASAsf3.b')),
    Paths.profileSaves(adopted.profileId)
  )

  const importedSnap = (await listSnapshots(adopted.profileId)).find((snap) => snap.label === 'Imported from your existing install')
  check('the import snapshot exists and is kept forever (not an auto snapshot)', !!importedSnap && importedSnap.auto === false, importedSnap?.label)
  check(
    'the import snapshot holds the same slots that were in the folder',
    importedSnap?.slots.map((slot) => slot.file).join(',') === detectedBefore.slots.map((slot) => slot.file).join(','),
    importedSnap?.slots
  )
  check(
    'the snapshot content matches the original save byte-for-byte',
    !!importedSnap && (await fsp.readFile(path.join(importedSnap.path, 'GTASAsf3.b'), 'utf8')) === 'campaign from before Modão existed'
  )
  const detectedAfter = await detectExistingSaves()
  check('a second detection recognises the import instead of offering it again', detectedAfter.importedIntoProfileId === adopted.profileId, detectedAfter)

  // --- install a mod with a variant -----------------------------------------
  const source = path.join(tmp, 'Loadscreens')
  await fsp.mkdir(path.join(source, 'Loadscreens 2K Definitive', 'models'), { recursive: true })
  await fsp.mkdir(path.join(source, 'Loadscreens 4K Definitive', 'models'), { recursive: true })
  await fsp.writeFile(path.join(source, 'Loadscreens 2K Definitive', 'models', 'LOADSCS.txd'), '2k loadscreen')
  await fsp.writeFile(path.join(source, 'Loadscreens 4K Definitive', 'models', 'LOADSCS.txd'), '4k loadscreen')
  await fsp.writeFile(
    path.join(source, 'Leiame (ou morra).txt'),
    // Windows-1252, as MixMods readmes actually ship - accented bytes included.
    Buffer.from(
      'Instala\u00e7\u00e3o:\r\nExtraia a pasta "Loadscreens" para a pasta do ModLoader.\r\nA vers\u00e3o 2K \u00e9 recomendada para 1920x1080.\r\n',
      'latin1'
    )
  )

  const plan = await createPlan({
    archivePath: source,
    profileId: adopted.profileId,
    modId: null,
    modVersionId: null,
    title: 'Loadscreens Definitive',
    author: 'Junior_Djjr',
    sourceUrl: 'https://www.mixmods.com.br/2020/09/loadscreens-definitive/'
  })
  check('variant detected and blocks the install until chosen', plan.requiresVariantChoice && plan.variants.length === 1, plan.variants)
  check('readme parsed from Windows-1252', plan.readmes[0]?.encoding === 'windows-1252', plan.readmes[0]?.encoding)
  check(
    'readme instruction recognised',
    plan.readmes[0]?.instructions[0]?.destination === 'modloader-folder',
    plan.readmes[0]?.instructions
  )

  const option2k = plan.variants[0].options.find((o) => o.label.includes('2K'))!
  const chosen = await choose(plan.planId, plan.variants[0].id, option2k.id)
  check('choosing a variant unblocks the plan', !chosen.requiresVariantChoice)
  check(
    'plan places the chosen variant into modloader\\',
    chosen.files.every((f) => f.targetRelative.startsWith('modloader/Loadscreens 2K Definitive/')),
    chosen.files.map((f) => f.targetRelative)
  )
  check(
    'plan warns that it will displace an existing file',
    chosen.files.some((f) => f.targetRelative.endsWith('LOADSCS.txd')),
    chosen.files.map((f) => f.targetRelative)
  )

  const applied = await applyPlan(chosen.planId, adopted.profileId)
  check('install wrote the files', applied.written === 1, applied)
  const installedFile = path.join(game, 'modloader', 'Loadscreens 2K Definitive', 'models', 'LOADSCS.txd')
  check('file materialised into the game folder', fs.existsSync(installedFile))
  check('file content is the chosen variant', (await fsp.readFile(installedFile, 'utf8')) === '2k loadscreen')

  // --- conflicts and priority ------------------------------------------------
  const conflicts = listConflicts(adopted.profileId)
  const loadscs = conflicts.find((c) => c.relativePath === 'models/loadscs.txd')
  check('duplicated relative path detected across mods', !!loadscs, conflicts.map((c) => c.relativePath))
  check('winner decided by priority (60 beats the default 50)', loadscs?.winner?.title === 'Old Cars', loadscs?.winner)

  const newMod = listInstalled(adopted.profileId).find((m) => m.title === 'Loadscreens Definitive')!
  await setPriority(newMod.installId, 80)
  const afterPriority = listConflicts(adopted.profileId).find((c) => c.relativePath === 'models/loadscs.txd')
  check('raising priority changes the winner', afterPriority?.winner?.title === 'Loadscreens Definitive', afterPriority?.winner)

  const ini = await readIniFile(path.join(game, 'modloader', 'modloader.ini'))
  const block = readKeys(getSection(ini, 'Profiles.Adopted.Priority'))
  check('priority written into the profile block in modloader.ini', block['Loadscreens 2K Definitive'] === '80', block)
  check('Mod Loader profile pointer written', readKeys(getSection(ini, 'Folder.Config'))['Profile'] === 'Adopted')
  check('user comment in modloader.ini preserved', (await fsp.readFile(path.join(game, 'modloader', 'modloader.ini'), 'latin1')).includes('; hand written by the user'))

  // --- field audit item 09: every variant option stays switchable in the store,
  // without ever touching the archive again -----------------------------------
  const beforeShaders = await snapshotDir(game)
  const shadersSource = path.join(tmp, 'Proper Shaders')
  for (const preset of ['(3a- medium - DEFAULT)', '(5 - very high)']) {
    await fsp.mkdir(path.join(shadersSource, 'Proper Shaders', preset), { recursive: true })
    await fsp.writeFile(path.join(shadersSource, 'Proper Shaders', preset, 'ProperShaders.ini'), preset)
  }
  const shadersPlan = await createPlan({
    archivePath: shadersSource,
    profileId: adopted.profileId,
    modId: null,
    modVersionId: null,
    title: 'Proper Shaders',
    author: 'V!Rus_Káin',
    sourceUrl: null
  })
  const shadersOption = shadersPlan.variants[0].options.find((o) => o.label.includes('DEFAULT'))!
  const shadersChosenPlan = await choose(shadersPlan.planId, shadersPlan.variants[0].id, shadersOption.id)
  const shadersApplied = await applyPlan(shadersChosenPlan.planId, adopted.profileId)
  check('field audit 09: the quality preset installed', shadersApplied.written >= 1, shadersApplied)

  const shadersFile = path.join(game, 'ProperShaders.ini')
  check('field audit 09: the DEFAULT preset content was written', (await fsp.readFile(shadersFile, 'utf8')) === '(3a- medium - DEFAULT)')

  // The archive is gone. Nothing that follows may need it again.
  await fsp.rm(shadersSource, { recursive: true, force: true })

  const shadersMod = listInstalled(adopted.profileId).find((m) => m.title === 'Proper Shaders')!
  const shadersGroup = shadersMod.variantGroups[0]
  check(
    'field audit 09: both presets remain recorded on the install, not just the chosen one',
    shadersGroup?.options.length === 2 && shadersGroup.chosenOptionId === shadersOption.id,
    shadersGroup
  )

  const veryHigh = shadersGroup!.options.find((o) => o.label.includes('very high'))!
  await switchVariant(shadersMod.installId, shadersGroup!.id, veryHigh.id)
  check(
    'field audit 09: switching writes the other preset, with the archive long gone',
    (await fsp.readFile(shadersFile, 'utf8')) === '(5 - very high)'
  )
  const shadersModAfter = listInstalled(adopted.profileId).find((m) => m.title === 'Proper Shaders')!
  check(
    'field audit 09: the install record now shows the new choice',
    shadersModAfter.variantGroups[0]?.chosenOptionId === veryHigh.id,
    shadersModAfter.variantGroups[0]
  )

  // Switching rewrote a file Modão had already recorded a hash for. If the
  // switch left that hash stale the file reads as user-edited, uninstall
  // quarantines it instead of removing it, and it survives in the game folder
  // - which is exactly how this landed as two byte-for-byte uninstall
  // failures further down. Assert the switch stayed honest, here, where the
  // cause is visible.
  const shadersUninstalled = await uninstall(shadersMod.installId)
  check(
    'field audit 09: uninstalling after a switch removes the switched file instead of quarantining it',
    shadersUninstalled.quarantined.length === 0 && !fs.existsSync(shadersFile),
    shadersUninstalled
  )
  check(
    'field audit 09: the variant install leaves the game folder byte-for-byte as it found it',
    sameTree(beforeShaders, await snapshotDir(game)),
    diff(beforeShaders, await snapshotDir(game))
  )

  // --- field audit 09, the dangerous half: a group found by a NAME RULE whose
  // options ship DIFFERENTLY NAMED files. Proper Shaders is safe by
  // construction - every preset holds one ProperShaders.ini, so replacing the
  // file of that name is the whole switch. Here the outgoing file has no
  // counterpart in the incoming option, and a switch that only wrote the new
  // one would leave both on disk: two options live at once, which is the bug
  // item 09 exists to remove, wearing a different hat.
  const beforeHud = await snapshotDir(game)
  const hudSource = path.join(tmp, 'HUD Pack')
  await fsp.mkdir(path.join(hudSource, 'HUD 2K', 'models'), { recursive: true })
  await fsp.mkdir(path.join(hudSource, 'HUD 4K', 'models'), { recursive: true })
  await fsp.writeFile(path.join(hudSource, 'HUD 2K', 'models', 'hud2k.txd'), 'two kay')
  await fsp.writeFile(path.join(hudSource, 'HUD 4K', 'models', 'hud4k.txd'), 'four kay')

  const hudPlan = await createPlan({
    archivePath: hudSource,
    profileId: adopted.profileId,
    modId: null,
    modVersionId: null,
    title: 'HUD Pack',
    author: 'Unknown',
    sourceUrl: null
  })
  const hudGroupPlan = hudPlan.variants[0]
  check(
    'field audit 09: differently-named options are still one exclusive group',
    hudGroupPlan?.options.length === 2,
    hudPlan.variants
  )
  const hud2k = hudGroupPlan.options.find((o) => o.label.includes('2K'))!
  const hud4k = hudGroupPlan.options.find((o) => o.label.includes('4K'))!
  const hudApplied = await applyPlan((await choose(hudPlan.planId, hudGroupPlan.id, hud2k.id)).planId, adopted.profileId)
  const hudOld = path.join(game, 'modloader', 'HUD 2K', 'models', 'hud2k.txd')
  const hudNew = path.join(game, 'modloader', 'HUD 2K', 'models', 'hud4k.txd')
  check('field audit 09: the 2K option installed', fs.existsSync(hudOld), hudApplied)

  await fsp.rm(hudSource, { recursive: true, force: true })
  const hudMod = listInstalled(adopted.profileId).find((m) => m.installId === hudApplied.installId)!
  await switchVariant(hudMod.installId, hudMod.variantGroups[0].id, hud4k.id)
  check(
    'field audit 09: switching to a differently-named option removes the file the old one installed',
    !fs.existsSync(hudOld),
    (await walk(path.join(game, 'modloader', 'HUD 2K'))).map((f) => f.rel)
  )
  check(
    'field audit 09: and writes the new one in its place',
    fs.existsSync(hudNew) && (await fsp.readFile(hudNew, 'utf8')) === 'four kay'
  )
  const hudAfter = listInstalled(adopted.profileId).find((m) => m.installId === hudApplied.installId)!
  check(
    'field audit 09: the install tracks exactly the files of the option now live',
    hudAfter.fileCount === 1 && hudAfter.variantGroups[0]?.chosenOptionId === hud4k.id,
    { fileCount: hudAfter.fileCount, group: hudAfter.variantGroups[0] }
  )

  const hudUninstalled = await uninstall(hudMod.installId)
  check(
    'field audit 09: uninstalling a differently-named switch quarantines nothing either',
    hudUninstalled.quarantined.length === 0,
    hudUninstalled
  )
  check(
    'field audit 09: and the game folder comes back byte-for-byte',
    sameTree(beforeHud, await snapshotDir(game)),
    diff(beforeHud, await snapshotDir(game))
  )

  // --- profiles and saves -----------------------------------------------------
  await fsp.writeFile(path.join(saves, 'GTASAsf1.b'), 'adopted profile save')

  // The user edits an installed file by hand. A profile switch vacates the game
  // folder, and this file no longer matches what Modão wrote: it is theirs now.
  const userEdited = 'the user own hand-tuned loadscreen'
  await fsp.writeFile(installedFile, userEdited)

  const second = await createProfile({ name: 'Clean', notes: 'vanilla-ish' })
  const t0 = Date.now()
  const switchOut = await activateProfile(second.id)
  const switchMs = Date.now() - t0
  check('profile switch completes quickly', switchMs < 5000, `${switchMs} ms`)
  check('game folder vacated on switch', !fs.existsSync(path.join(game, 'modloader', 'Loadscreens 2K Definitive')))
  check('outgoing saves stored, live folder reset', !fs.existsSync(path.join(saves, 'GTASAsf1.b')))

  const rescued = (await walk(path.join(Paths.quarantine(), 'profile-switch'))).filter((f) =>
    f.rel.toLowerCase().endsWith('loadscs.txd')
  )
  check(
    'a file edited after installing is quarantined when the profile is switched away, not deleted',
    rescued.length === 1,
    rescued.map((f) => f.rel)
  )
  check(
    'the quarantined copy holds exactly the bytes the user wrote',
    rescued.length === 1 && (await fsp.readFile(rescued[0].abs, 'utf8')) === userEdited
  )
  check(
    'the switch log says a file was rescued rather than staying silent',
    switchOut.log.some((line) => line.includes('quarantine')),
    switchOut.log
  )

  await fsp.writeFile(path.join(saves, 'GTASAsf2.b'), 'clean profile save')
  await activateProfile(adopted.profileId)
  check('switching back restores the profile mods', fs.existsSync(installedFile))
  check('switching back restores that profile saves', fs.existsSync(path.join(saves, 'GTASAsf1.b')))
  check('the other profile saves are not visible', !fs.existsSync(path.join(saves, 'GTASAsf2.b')))
  check(
    'the imported pre-Modão save survived the round trip unchanged',
    fs.existsSync(path.join(saves, 'GTASAsf3.b')) &&
      (await fsp.readFile(path.join(saves, 'GTASAsf3.b'), 'utf8')) === 'campaign from before Modão existed'
  )
  check(
    'the other profile saves are kept in its own store, not lost',
    fs.existsSync(path.join(Paths.profileSaves(second.id), 'GTASAsf2.b')),
    Paths.profileSaves(second.id)
  )
  check('both profiles exist', (await listProfiles()).length >= 2)

  // --- storage accounting and cache clearing ----------------------------------
  const cachedPage = path.join(Paths.httpCache(), 'e2e-cached-page.json')
  await fsp.writeFile(cachedPage, JSON.stringify({ url: 'https://example.invalid/', body: 'x'.repeat(8192) }))
  const quarantined = path.join(Paths.quarantine(), 'e2e-irreplaceable.bin')
  await fsp.writeFile(quarantined, 'a user file that must survive a cache clear')

  const storage = await storageReport()
  const totals = [storage.dbBytes, storage.storeBytes, storage.archivesBytes, storage.cacheBytes, storage.quarantineBytes, storage.snapshotBytes]
  check('every storage total is a non-negative number', totals.every((n) => Number.isFinite(n) && n >= 0), storage)
  check('storage report names a userData folder that exists', fs.existsSync(storage.userData), storage.userData)
  check('the snapshots taken during this run are accounted for', storage.snapshotBytes > 0, storage.snapshotBytes)
  check('the cached page is accounted for', storage.cacheBytes >= 8192, storage.cacheBytes)

  const cleared = await clearCache('http')
  check('clearing the HTTP cache frees at least the bytes it held', cleared.freed >= 8192, cleared)
  check('the HTTP cache is empty afterwards', (await walk(Paths.httpCache())).length === 0)
  const afterClear = await storageReport()
  check('clearing the HTTP cache did not touch quarantine', fs.existsSync(quarantined) && afterClear.quarantineBytes >= storage.quarantineBytes, {
    before: storage.quarantineBytes,
    after: afterClear.quarantineBytes
  })

  // --- uninstall restores the prior state -------------------------------------
  const uninstalled = await uninstall(newMod.installId)
  check(
    'uninstall keeps the file the user edited instead of deleting it',
    uninstalled.quarantined.length === 1,
    uninstalled.quarantined
  )
  const afterUninstall = await snapshotDir(game)
  check('uninstall restores the game folder byte-for-byte', sameTree(afterAdopt, afterUninstall), diff(afterAdopt, afterUninstall))
  check('displaced file restored with its original bytes', (await fsp.readFile(path.join(game, 'modloader', 'Old Cars', 'models', 'LOADSCS.txd'), 'utf8')) === 'old loadscreen')

  // --- sub-mods can be turned off and back on ---------------------------------
  // Nested folders inside a Mod Loader mod are units of their own. This mod also
  // ships an .asi, so it is materialised as per-file links rather than one
  // junction - exactly the case where a sub-mod folder can be removed on its own.
  const pack = path.join(tmp, 'Pack archive')
  const packRoot = path.join(pack, 'modloader', 'Sub Mod Pack')
  await fsp.mkdir(path.join(packRoot, 'models'), { recursive: true })
  await fsp.mkdir(path.join(packRoot, 'data'), { recursive: true })
  await fsp.writeFile(path.join(packRoot, 'models', 'wheel.dff'), 'a wheel model')
  await fsp.writeFile(path.join(packRoot, 'data', 'handling.dat'), 'handling lines')
  await fsp.writeFile(path.join(pack, 'pack.asi'), fakePe(2048, 0x60000000, 0x2102))

  const packPlan = await createPlan({
    archivePath: pack,
    profileId: adopted.profileId,
    modId: null,
    modVersionId: null,
    title: 'Sub Mod Pack',
    author: 'Unknown',
    sourceUrl: null
  })
  check(
    'the pack is materialised as per-file links, not one junction',
    packPlan.files.some((f) => f.destination === 'asi-plugin') && packPlan.files.some((f) => f.destination === 'modloader-folder'),
    packPlan.files.map((f) => `${f.destination} ${f.targetRelative}`)
  )
  const packApplied = await applyPlan(packPlan.planId, adopted.profileId)
  const packInstall = listInstalled(adopted.profileId).find((m) => m.installId === packApplied.installId)!
  const subOf = (mod: InstalledMod, rel: string): SubMod | undefined => mod.subMods.find((s) => s.relativePath === rel)
  check(
    'nested folders are reported as sub-mods',
    packInstall.subMods.map((s) => s.relativePath).join(',') === 'data,models',
    packInstall.subMods
  )
  check('a freshly installed sub-mod reports enabled', packInstall.subMods.every((s) => s.enabled === true), packInstall.subMods)

  const subFile = path.join(game, 'modloader', 'Sub Mod Pack', 'data', 'handling.dat')
  await setSubModEnabled(packApplied.installId, 'data', false)
  const afterDisable = listInstalled(adopted.profileId).find((m) => m.installId === packApplied.installId)!
  check('a disabled sub-mod reports enabled: false', subOf(afterDisable, 'data')?.enabled === false, afterDisable.subMods)
  check('its sibling is untouched', subOf(afterDisable, 'models')?.enabled === true, afterDisable.subMods)
  check('disabling a sub-mod removes only that folder from the game', !fs.existsSync(subFile))
  check('the rest of the mod stays materialised', fs.existsSync(path.join(game, 'modloader', 'Sub Mod Pack', 'models', 'wheel.dff')))

  await setSubModEnabled(packApplied.installId, 'data', true)
  const afterReEnable = listInstalled(adopted.profileId).find((m) => m.installId === packApplied.installId)!
  check('a disabled sub-mod can be re-enabled', subOf(afterReEnable, 'data')?.enabled === true, afterReEnable.subMods)
  check(
    're-enabling puts the files back with their own bytes',
    fs.existsSync(subFile) && (await fsp.readFile(subFile, 'utf8')) === 'handling lines',
    (await walk(path.join(game, 'modloader', 'Sub Mod Pack'))).map((f) => f.rel)
  )

  await uninstall(packApplied.installId)
  check(
    'uninstalling the per-file install restores the tree too',
    sameTree(afterAdopt, await snapshotDir(game)),
    diff(afterAdopt, await snapshotDir(game))
  )

  // --- a profile made by hand still finds what is already in the game folder ---
  // The first run adopts, but a user who adds the game later, creates a profile
  // themselves, or installs a mod outside Modão ends up with a full game
  // folder and an empty library. That gap is what this covers.
  await fsp.mkdir(path.join(game, 'modloader', 'Hand Installed Pack', 'models'), { recursive: true })
  await fsp.writeFile(path.join(game, 'modloader', 'Hand Installed Pack', 'models', 'sweet.dff'), 'installed outside Modão')
  await fsp.writeFile(path.join(game, 'scripts', 'HandDropped.asi'), fakePe(2048, 0x60000000, 0x2102))

  const byHand = await createProfile({ name: 'Made by hand' })
  const beforeAdopt = listInstalled(byHand.id)
  check('a profile created by hand starts empty', beforeAdopt.length === 0, beforeAdopt.length)

  const unmanaged = await unmanagedContent(byHand.id)
  check(
    'the mod folder dropped in by hand is reported as untracked',
    unmanaged.folders.includes('Hand Installed Pack'),
    unmanaged
  )
  check('the loose .asi is reported as untracked too', unmanaged.asi.includes('HandDropped.asi'), unmanaged.asi)
  check('the untracked total counts every kind', unmanaged.total === unmanaged.folders.length + unmanaged.asi.length + unmanaged.cleo.length)

  const gameBeforeScan = await snapshotDir(game)
  const scan = await adoptIntoProfile(byHand.id)
  check('scanning an existing profile adopts what it found', scan.adopted >= 1, scan.report)
  const afterScan = listInstalled(byHand.id)
  check(
    'the hand-installed mod now appears in that profile library',
    afterScan.some((m) => m.title === 'Hand Installed Pack'),
    afterScan.map((m) => m.title)
  )
  check(
    'scanning moved and changed nothing in the game folder',
    sameTree(gameBeforeScan, await snapshotDir(game)),
    diff(gameBeforeScan, await snapshotDir(game))
  )
  const afterUnmanaged = await unmanagedContent(byHand.id)
  check('nothing is reported as untracked after the scan', afterUnmanaged.total === 0, afterUnmanaged)
  const rescan = await adoptIntoProfile(byHand.id)
  check('a second scan adopts nothing twice', rescan.adopted === 0, rescan.report)
  check(
    'the active profile is untouched by scanning another one',
    (await listProfiles()).find((p) => p.isActive)?.id === adopted.profileId
  )

  // --- a switch must never lose a file it did not put there -----------------
  // The bug this covers: loose .asi and CLEO files adopted from the user's own
  // install had no store copy and no recorded hash, so a profile switch deleted
  // them outright and the quarantine folder caught almost none of them. The
  // install below is deliberately the shape that broke: plugins outside
  // modloader\, adopted rather than installed, with an accented folder name and
  // a hand-set priority, plus one file Modão was never told about.
  await fsp.writeFile(path.join(game, 'scripts', 'MixSets.asi'), fakePe(3000, 0x60000000, 0x2102))
  await fsp.writeFile(path.join(game, 'scripts', 'SALodLights.asi'), fakePe(3100, 0x60000000, 0x2102))
  await fsp.writeFile(path.join(game, 'cleo', 'CLEO+.cleo'), 'cleo plugin bytes')
  await fsp.writeFile(path.join(game, 'cleo', 'radar.cs'), 'cleo script bytes')
  await fsp.mkdir(path.join(game, 'modloader', 'Animações de Kung Fu melhoradas'), { recursive: true })
  await fsp.writeFile(path.join(game, 'modloader', 'Animações de Kung Fu melhoradas', 'kungfu.ifp'), 'animation bytes')

  const risky = await createProfile({ name: 'Real install' })
  await adoptIntoProfile(risky.id)
  const riskyLib = listInstalled(risky.id)
  const kungFu = riskyLib.find((m) => m.title.startsWith('Anima'))
  check('an accented mod folder is adopted under its real name', !!kungFu, riskyLib.map((m) => m.title))
  if (kungFu) setPriority(kungFu.installId, 70)

  // Added AFTER adoption, so no profile knows about it: the switch must leave it alone.
  await fsp.writeFile(path.join(game, 'scripts', 'Unmanaged.asi'), fakePe(1500, 0x60000000, 0x2102))

  const riskyFiles = ['scripts/MixSets.asi', 'scripts/SALodLights.asi', 'cleo/CLEO+.cleo', 'cleo/radar.cs']
  const riskyBytes = new Map<string, string>()
  for (const rel of riskyFiles) riskyBytes.set(rel, await sha256File(path.join(game, ...rel.split('/'))))
  const unmanagedHash = await sha256File(path.join(game, 'scripts', 'Unmanaged.asi'))

  await activateProfile(risky.id)
  check(
    'the adopted plugins are in the game folder while their profile is active',
    riskyFiles.every((rel) => fs.existsSync(path.join(game, ...rel.split('/')))),
    riskyFiles.filter((rel) => !fs.existsSync(path.join(game, ...rel.split('/'))))
  )

  // A dry run answers before anything moves.
  const empty = await createProfile({ name: 'Clean slate' })
  const beforeDryRun = await snapshotDir(game)
  const dry = await planSwitch(empty.id)
  check(
    'a dry run changes nothing at all',
    sameTree(beforeDryRun, await snapshotDir(game)),
    diff(beforeDryRun, await snapshotDir(game))
  )
  check(
    'the dry run names every file it would take out',
    riskyFiles.every((rel) => dry.outgoing.some((o) => o.relativePath === rel && o.action === 'snapshot-and-remove')),
    dry.outgoing.map((o) => `${o.action} ${o.relativePath}`)
  )
  check(
    'the dry run lists the unmanaged file as untouched',
    dry.unmanaged.includes('scripts/Unmanaged.asi'),
    dry.unmanaged
  )
  check('the dry run reports nothing unresolvable for an empty profile', dry.unresolved.length === 0, dry.unresolved)

  const switched = await activateProfile(empty.id)
  check('the switch verified', switched.verification?.ok === true, switched.verification?.problems)
  check('the switch was journalled', typeof switched.journalId === 'number', switched.journalId)

  check(
    'the unmanaged .asi was left exactly where it was',
    fs.existsSync(path.join(game, 'scripts', 'Unmanaged.asi')) &&
      (await sha256File(path.join(game, 'scripts', 'Unmanaged.asi'))) === unmanagedHash
  )

  const journal = (await listJournals()).find((j) => j.id === switched.journalId)!
  check('the journal holds a manifest entry per removed file', journal.manifest.length >= riskyFiles.length, journal.manifest.length)
  for (const rel of riskyFiles) {
    const entry = journal.manifest.find((m) => m.relativePath === rel)
    check(`the pre-switch backup holds ${rel}`, !!entry && fs.existsSync(entry.backupPath), entry)
    check(
      `the backup of ${rel} is byte-for-byte the file that was removed`,
      !!entry && (await sha256File(entry.backupPath)) === riskyBytes.get(rel),
      entry?.backupPath
    )
  }
  const verified = await verifySnapshot(journal.manifest)
  check('the whole snapshot re-verifies by hash', verified.ok, verified.problems)

  // Switching back has to bring every one of them home unchanged.
  await activateProfile(risky.id)
  for (const rel of riskyFiles) {
    const abs = path.join(game, ...rel.split('/'))
    check(
      `${rel} came back after switching to the profile and away again`,
      fs.existsSync(abs) && (await sha256File(abs)) === riskyBytes.get(rel),
      abs
    )
  }

  // modloader.ini: cp1252 on disk, the accented name intact, the priority kept,
  // and no line for a mod this profile does not have.
  const iniBytes = await fsp.readFile(path.join(game, 'modloader', 'modloader.ini'))
  check(
    'modloader.ini is written as Windows-1252, not UTF-8',
    iniBytes.includes(Buffer.from([0xe7, 0xf5])) && !iniBytes.includes(Buffer.from([0xc3, 0xa7])),
    iniBytes.toString('latin1').slice(0, 200)
  )
  const liveIni = await readIniFile(path.join(game, 'modloader', 'modloader.ini'))
  const liveBlock = readKeys(getSection(liveIni, 'Profiles.Real install.Priority'))
  check(
    'the accented folder name survives the round trip',
    'Animações de Kung Fu melhoradas' in liveBlock,
    Object.keys(liveBlock)
  )
  check(
    'the hand-set priority survived a switch away and back',
    liveBlock['Animações de Kung Fu melhoradas'] === '70',
    liveBlock
  )
  check(
    'no priority line is written for a mod that is not in this profile',
    !('Loadscreens 2K Definitive' in liveBlock),
    Object.keys(liveBlock)
  )
  check(
    'a strict read of the block sees only this profile, not the inherited defaults',
    !('Old Cars' in liveBlock),
    Object.keys(liveBlock)
  )

  // Restore previous state: roll the last switch back completely.
  const beforeRestore = await snapshotDir(game)
  await activateProfile(empty.id)
  const restore = await restorePreviousState()
  check('restoring reports what it put back', restore.restored >= riskyFiles.length, restore)
  check(
    'restoring rolls the switch back to the tree it found',
    sameTree(beforeRestore, await snapshotDir(game)),
    diff(beforeRestore, await snapshotDir(game))
  )
  check(
    'the profile that was active before is active again',
    (await listProfiles()).find((p) => p.isActive)?.id === risky.id
  )

  // --- an unmanaged file at a path the incoming profile writes ---------------
  // Unmanaged.asi above collides with nothing, which is exactly why the
  // destructive path stayed invisible for so long: it only opens when the
  // arriving profile wants a path the user already occupies. This is the field
  // failure in miniature - the user's own scripts\MixSets.asi, and a profile
  // that installs a MixSets.asi of its own on top of it.
  await activateProfile(empty.id)
  const ownMixSets = 'a MixSets.asi the user downloaded and dropped in by hand'
  const ownMixSetsPath = path.join(game, 'scripts', 'MixSets.asi')
  await fsp.writeFile(ownMixSetsPath, ownMixSets)
  const ownMixSetsHash = await sha256File(ownMixSetsPath)

  // The same collision one level up: a real modloader\<Folder>\ the user built
  // by hand, where the arriving profile puts a junction of the same name.
  // `createJunction` calls removeLinkOrDir, which is a recursive force remove,
  // so the whole tree went without ever being named.
  const handFolder = path.join(game, 'modloader', 'Animações de Kung Fu melhoradas')
  const handRel = 'modloader/Animações de Kung Fu melhoradas/by-hand.ifp'
  await fsp.mkdir(handFolder, { recursive: true })
  await fsp.writeFile(path.join(handFolder, 'by-hand.ifp'), 'animations the user made themselves')
  const handHash = await sha256File(path.join(handFolder, 'by-hand.ifp'))
  // And a file nested deeper, at the name the mod's own payload uses. Both are
  // untracked, so both have to come out file by file rather than the folder
  // being judged once and taken whole.
  const strayRel = 'modloader/Animações de Kung Fu melhoradas/extra/kungfu.ifp'
  await fsp.mkdir(path.join(handFolder, 'extra'), { recursive: true })
  await fsp.writeFile(path.join(handFolder, 'extra', 'kungfu.ifp'), 'a stray the user left inside that folder')
  const strayHash = await sha256File(path.join(handFolder, 'extra', 'kungfu.ifp'))

  const collide = await planSwitch(risky.id)
  check(
    'a colliding unmanaged file is still reported as unmanaged',
    collide.unmanaged.includes('scripts/MixSets.asi'),
    collide.unmanaged
  )
  check(
    'the dry run names the unmanaged file the switch would overwrite',
    collide.willBeOverwritten.includes('scripts/MixSets.asi'),
    collide.willBeOverwritten
  )
  check(
    'a real mod folder an incoming junction would replace is reported too',
    collide.unmanaged.includes(handRel) && collide.willBeOverwritten.includes(handRel),
    collide.willBeOverwritten
  )
  check(
    'every file inside it is reported, one by one',
    collide.unmanaged.includes(strayRel) && collide.willBeOverwritten.includes(strayRel),
    collide.willBeOverwritten
  )

  const collided = await activateProfile(risky.id)
  check('the colliding switch still verified', collided.verification?.ok === true, collided.verification?.problems)
  check(
    'the mod took the path it needed',
    fs.existsSync(ownMixSetsPath) && (await sha256File(ownMixSetsPath)) === riskyBytes.get('scripts/MixSets.asi'),
    await sha256File(ownMixSetsPath)
  )
  check(
    'the file the user had there is listed as quarantined',
    collided.quarantined.includes('scripts/MixSets.asi'),
    collided.quarantined
  )
  const displacedCopies = (await walk(path.join(Paths.quarantine(), 'displaced'))).filter((f) =>
    f.abs.toLowerCase().endsWith('mixsets.asi')
  )
  const displacedHashes = await Promise.all(displacedCopies.map((f) => sha256File(f.abs)))
  check(
    'the user’s own bytes are in quarantine, not gone',
    displacedHashes.includes(ownMixSetsHash),
    displacedCopies.map((f) => f.abs)
  )
  const collideJournal = (await listJournals()).find((j) => j.id === collided.journalId)!
  const collideEntry = collideJournal.manifest.find((m) => m.relativePath === 'scripts/MixSets.asi')
  check(
    'the overwritten file is in the switch snapshot as well',
    !!collideEntry && fs.existsSync(collideEntry.backupPath) && (await sha256File(collideEntry.backupPath)) === ownMixSetsHash,
    collideEntry
  )

  // The folder half of the same story.
  check(
    'the junction did take the folder',
    fs.existsSync(path.join(game, 'modloader', 'Animações de Kung Fu melhoradas', 'kungfu.ifp')),
    await fsp.readdir(path.join(game, 'modloader'))
  )
  check(
    'the displaced folder is listed as quarantined',
    collided.quarantined.includes('modloader/Animações de Kung Fu melhoradas'),
    collided.quarantined
  )
  const handCopies = (await walk(path.join(Paths.quarantine(), 'displaced'))).filter((f) =>
    f.abs.toLowerCase().endsWith('by-hand.ifp')
  )
  const handHashes = await Promise.all(handCopies.map((f) => sha256File(f.abs)))
  check(
    'the hand-made folder is in quarantine, not recursively removed',
    handHashes.includes(handHash),
    handCopies.map((f) => f.abs)
  )
  const handEntry = collideJournal.manifest.find((m) => m.relativePath === handRel)
  check(
    'the displaced folder is in the switch snapshot, file by file',
    !!handEntry && fs.existsSync(handEntry.backupPath) && (await sha256File(handEntry.backupPath)) === handHash,
    handEntry
  )
  const strayEntry = collideJournal.manifest.find((m) => m.relativePath === strayRel)
  check(
    'the stray nested inside it is in the snapshot too',
    !!strayEntry && fs.existsSync(strayEntry.backupPath) && (await sha256File(strayEntry.backupPath)) === strayHash,
    strayEntry
  )
  const strayCopies = (await walk(path.join(Paths.quarantine(), 'displaced'))).filter((f) =>
    f.abs.toLowerCase().includes('extra')
  )
  check(
    'and the stray is in quarantine with its own bytes',
    (await Promise.all(strayCopies.map((f) => sha256File(f.abs)))).includes(strayHash),
    strayCopies.map((f) => f.abs)
  )

  // And leaving the profile again hands the path back to its owner.
  await activateProfile(empty.id)
  check(
    'the displaced file is put back when the profile that took its path leaves',
    fs.existsSync(ownMixSetsPath) && (await sha256File(ownMixSetsPath)) === ownMixSetsHash,
    fs.existsSync(ownMixSetsPath) ? await sha256File(ownMixSetsPath) : 'missing'
  )
  await fsp.rm(ownMixSetsPath, { force: true })
  await activateProfile(risky.id)
  check(
    'the profile is whole again after all of that',
    riskyFiles.every((rel) => fs.existsSync(path.join(game, ...rel.split('/')))),
    riskyFiles.filter((rel) => !fs.existsSync(path.join(game, ...rel.split('/'))))
  )

  // "Restore previous state" while a profile that owns real files is active.
  // It used to vacate that profile with no snapshot set at all, so every
  // tracked real file was deleted outright - and an adopted one had no store
  // copy, no recorded hash and no quarantine entry to come back from. The
  // earlier restore test above cannot see this: it restores out of an empty
  // profile, where there is nothing to delete.
  const undone = await restorePreviousState()
  check(
    'the undo backs the active profile up before it vacates it',
    undone.log.some((l) => l.includes('before removing them')),
    undone.log
  )
  check(
    'the undo left the profile from before the switch active',
    (await listProfiles()).find((p) => p.isActive)?.id === empty.id,
    (await listProfiles()).find((p) => p.isActive)?.name
  )
  await activateProfile(risky.id)
  for (const rel of riskyFiles) {
    const abs = path.join(game, ...rel.split('/'))
    check(
      `${rel} survived being vacated by the undo`,
      fs.existsSync(abs) && (await sha256File(abs)) === riskyBytes.get(rel),
      abs
    )
  }

  // --- a mod that passes the plan and then does not arrive -------------------
  // The field failure: a mod was in the profile's mod set, was not materialised
  // by the switch, and nothing said so - the user found out in the game. The
  // pre-switch refusal above cannot catch this one, because the payload is
  // still there when the plan is made. So take it away after the plan has
  // passed and before the files are placed, which is exactly what a payload
  // deleted by a cleaner, a sync client or a failing disk looks like.
  const ghost = await createProfile({ name: 'Mod que some' })
  await activateProfile(ghost.id)
  const ghostSource = path.join(tmp, 'beta-gang')
  await fsp.mkdir(path.join(ghostSource, 'modloader', 'Beta Gang Members'), { recursive: true })
  await fsp.writeFile(path.join(ghostSource, 'modloader', 'Beta Gang Members', 'members.dat'), 'beta gang bytes')
  const ghostPlan = await createPlan({
    archivePath: ghostSource,
    profileId: ghost.id,
    modId: null,
    modVersionId: null,
    title: 'Beta Gang Members',
    author: 'Junior_Djjr',
    sourceUrl: null
  })
  const ghostInstall = await applyPlan(ghostPlan.planId, ghost.id)
  const ghostRow = getDb().prepare('SELECT store_key, folder_name FROM install WHERE id = ?').get(ghostInstall.installId) as {
    store_key: string | null
    folder_name: string | null
  }
  const ghostLabel = ghostRow.folder_name ?? 'Beta Gang Members'
  const ghostFiles = (
    getDb().prepare('SELECT relative_path FROM install_file WHERE install_id = ?').all(ghostInstall.installId) as {
      relative_path: string
    }[]
  ).map((r) => r.relative_path)

  // Back to the profile the user is really on, so the failing switch is a
  // switch away from a profile with files of its own - the state the rollback
  // has to put back.
  await activateProfile(risky.id)

  let vanished: unknown = null
  await activateProfile(ghost.id, (phase, done) => {
    // Between the plan and the placing: the store still held the payload when
    // planSwitch looked, and does not by the time materialise reads it.
    if (phase === 'link' && done === 0 && ghostRow.store_key) {
      for (const rel of ghostFiles) fs.rmSync(path.join(storeDir(ghostRow.store_key), ...rel.split('/')), { force: true })
    }
  }).catch((e) => {
    vanished = e
  })

  check('a mod that did not reach the game folder blocks the switch', vanished instanceof SwitchVerificationError, vanished)
  const vanishReport = vanished instanceof SwitchVerificationError ? vanished.verification : null
  check(
    'the blocking failure names the mod that did not arrive',
    !!vanishReport &&
      vanishReport.missingMods.some((m) => m.label === ghostLabel) &&
      vanishReport.blockingProblems.join(' ').includes(ghostLabel),
    vanishReport?.blockingProblems
  )
  check(
    'and it is an error the UI must show, not a line in a log',
    vanished instanceof Error && vanished.message.includes(ghostLabel),
    vanished instanceof Error ? vanished.message : vanished
  )
  check(
    'the profile that did not reconcile was NOT recorded active',
    (await listProfiles()).find((p) => p.isActive)?.id === risky.id,
    (await listProfiles()).find((p) => p.isActive)?.name
  )
  const ghostJournalId = vanished instanceof SwitchVerificationError ? vanished.journalId : -1
  const ghostJournal = (await listJournals()).find((j) => j.id === ghostJournalId)
  check(
    'the refused switch is journalled as failed, with the report attached',
    ghostJournal?.state === 'failed' && ghostJournal.verification !== null,
    ghostJournal?.state
  )

  // The way out the user is offered has to undo a switch that never became
  // active: the profile that landed is not the profile the DB calls active.
  const ghostUndo = await restorePreviousState()
  check(
    'the rollback vacates the profile that landed without ever activating',
    !fs.existsSync(path.join(game, 'modloader', ghostLabel)),
    ghostUndo.log
  )
  check(
    'the rollback says it removed that profile, not the one the DB called active',
    ghostUndo.log.some((l) => l.includes('Mod que some')),
    ghostUndo.log
  )
  check(
    'the profile from before the refused switch is active again',
    (await listProfiles()).find((p) => p.isActive)?.id === risky.id,
    (await listProfiles()).find((p) => p.isActive)?.name
  )
  for (const rel of riskyFiles) {
    const abs = path.join(game, ...rel.split('/'))
    check(
      `${rel} came back after undoing the refused switch`,
      fs.existsSync(abs) && (await sha256File(abs)) === riskyBytes.get(rel),
      abs
    )
  }

  // A mod whose payload has gone must block the switch rather than vanish.
  const orphan = await createProfile({ name: 'Broken payload', copyFrom: risky.id })
  const orphanInstall = listInstalled(orphan.id).find((m) => m.title.startsWith('Anima'))!
  const orphanKey = (getDb().prepare('SELECT store_key FROM install WHERE id = ?').get(orphanInstall.installId) as {
    store_key: string | null
  }).store_key
  if (orphanKey) await fsp.rm(storeDir(orphanKey), { recursive: true, force: true })
  const orphanPlan = await planSwitch(orphan.id)
  check('a mod with no payload is reported as unresolved', orphanPlan.unresolved.length >= 1, orphanPlan.unresolved)
  let blocked = false
  await activateProfile(orphan.id).catch(() => {
    blocked = true
  })
  check('a switch that would lose a mod refuses to run', blocked)
  check(
    'the refusal left the previous profile active and its files in place',
    (await listProfiles()).find((p) => p.isActive)?.id === risky.id &&
      riskyFiles.every((rel) => fs.existsSync(path.join(game, ...rel.split('/'))))
  )

  // --- two copies of one pack, and deleting the spare ------------------------
  // What actually destroyed a user's install: the same pack was in the profile
  // twice, one copy disabled. They installed it again, then deleted the
  // disabled duplicate to tidy up - and the uninstall removed every file the
  // copy that stayed was still providing, gta_sa.exe among them.
  const packSource = path.join(tmp, 'pack-essentials')
  await fsp.mkdir(path.join(packSource, 'modloader', 'Essentials'), { recursive: true })
  await fsp.writeFile(path.join(packSource, 'modloader', 'Essentials', 'core.dat'), 'shared payload')
  await fsp.writeFile(path.join(packSource, 'vorbisFile.dll'), 'asi loader')
  // The real pack ships the game executable. It must never be installed.
  await fsp.writeFile(path.join(packSource, 'gta_sa.exe'), 'the pack version of the exe')

  const exeBefore = await sha256File(path.join(game, 'gta_sa.exe'))

  const packPlanA = await createPlan({
    archivePath: packSource,
    profileId: risky.id,
    modId: null,
    modVersionId: null,
    title: 'Essentials',
    author: 'Junior_Djjr',
    sourceUrl: null
  })
  check(
    'pack: the game executable inside an archive is refused, not installed',
    !packPlanA.files.some((f) => f.targetRelative.toLowerCase() === 'gta_sa.exe'),
    packPlanA.files.map((f) => f.targetRelative)
  )
  check(
    'pack: and the refusal is explained rather than silent',
    packPlanA.warnings.some((w) => w.code === 'game-executable'),
    packPlanA.warnings.map((w) => w.code)
  )
  const packA = await applyPlan(packPlanA.planId, risky.id)
  check(
    'pack: the game executable is untouched by the install',
    (await sha256File(path.join(game, 'gta_sa.exe'))) === exeBefore
  )

  // Two DIFFERENT mods that ship the same file: removing one must leave what
  // the other still provides. (The same mod twice is no longer possible - a
  // second install replaces the first.)
  const otherSource = path.join(tmp, 'other-mod')
  await fsp.mkdir(path.join(otherSource, 'modloader', 'Other Mod'), { recursive: true })
  await fsp.writeFile(path.join(otherSource, 'modloader', 'Other Mod', 'own.dat'), 'its own file')
  await fsp.writeFile(path.join(otherSource, 'vorbisFile.dll'), 'asi loader')
  const otherPlan = await createPlan({
    archivePath: otherSource,
    profileId: risky.id,
    modId: null,
    modVersionId: null,
    title: 'Other Mod',
    author: 'Someone',
    sourceUrl: null
  })
  const other = await applyPlan(otherPlan.planId, risky.id)
  check('pack: a second mod shipping the same loader is installed alongside', other.installId !== packA.installId)

  const sharedFile = path.join(game, 'vorbisFile.dll')
  const sharedBytes = await sha256File(sharedFile)

  const removal = await uninstall(other.installId)
  check(
    'pack: removing one leaves the file the other still provides',
    fs.existsSync(sharedFile) && (await sha256File(sharedFile)) === sharedBytes,
    removal
  )
  check(
    'pack: and it says which files it kept and why',
    removal.kept.some((f) => f.toLowerCase().includes('vorbisfile.dll')),
    removal.kept
  )
  check(
    'pack: the mod folder the other copy owns is still there',
    fs.existsSync(path.join(game, 'modloader', 'Essentials', 'core.dat'))
  )
  check(
    'pack: and the game executable survived all of it',
    fs.existsSync(path.join(game, 'gta_sa.exe')) && (await sha256File(path.join(game, 'gta_sa.exe'))) === exeBefore
  )

  // --- one mod, one entry ----------------------------------------------------
  // A mod whose whole payload is a single .asi appeared three times: once as
  // itself, once because adoption re-indexed the file it had just placed, and
  // once more because installing it again added a second entry.
  const asiOnly = path.join(tmp, 'story-mode')
  await fsp.mkdir(asiOnly, { recursive: true })
  await fsp.writeFile(path.join(asiOnly, 'TrilogyChaosMod.SA.asi'), fakePe(4096, 0x60000000, 0x2102))

  const storyPlan = await createPlan({
    archivePath: asiOnly,
    profileId: risky.id,
    modId: null,
    modVersionId: null,
    title: 'Story Mode v2.0',
    author: 'Junior_Djjr',
    sourceUrl: null
  })
  const story = await applyPlan(storyPlan.planId, risky.id)
  const countNamed = (needle: string): number =>
    listInstalled(risky.id).filter((m) => m.title.toLowerCase().includes(needle.toLowerCase())).length

  check('one entry: the mod is installed once', countNamed('Story Mode') === 1, listInstalled(risky.id).map((m) => m.title))

  // Adoption must not claim the file the install just placed.
  const afterInstallScan = await adoptIntoProfile(risky.id)
  check(
    'one entry: adoption does not re-index a file an install already owns',
    countNamed('TrilogyChaosMod') === 0,
    listInstalled(risky.id).map((m) => m.title)
  )
  check('one entry: and it reports nothing adopted', afterInstallScan.adopted === 0, afterInstallScan.report)
  check(
    'one entry: the plugin is still in the game folder',
    fs.existsSync(path.join(game, 'scripts', 'TrilogyChaosMod.SA.asi'))
  )

  // Installing the same mod again replaces it rather than adding a second.
  const againPlan = await createPlan({
    archivePath: asiOnly,
    profileId: risky.id,
    modId: storyPlan.modId,
    modVersionId: storyPlan.modVersionId,
    title: 'Story Mode v2.0',
    author: 'Junior_Djjr',
    sourceUrl: null
  })
  const again = await applyPlan(againPlan.planId, risky.id)
  check('one entry: installing it again still leaves one entry', countNamed('Story Mode') === 1, listInstalled(risky.id).map((m) => m.title))
  check('one entry: and the file survived the replacement', fs.existsSync(path.join(game, 'scripts', 'TrilogyChaosMod.SA.asi')))
  void story
  void again

  // --- item 08: duplicate .asi through a junction, found by hash -------------
  // The field report: III.VC.SA.LimitAdjuster.asi lived in BOTH scripts\ and a
  // junctioned modloader\Open Limit Adjuster\, byte-identical. Two instances
  // patched the same limits and fought - the ped-model limit never took, and
  // the game crashed. A plain recursive scan reported "no duplicates" the
  // whole time because it never followed the junction; fsx.walk does, but
  // nothing pointed it at the game tree until now.
  const oaSource = path.join(tmp, 'Open Limit Adjuster payload')
  await fsp.mkdir(oaSource, { recursive: true })
  const adjusterBytes = fakePe(4096, 0x60000000, 0x2102)
  await fsp.writeFile(path.join(oaSource, 'III.VC.SA.LimitAdjuster.asi'), adjusterBytes)
  await createJunction(path.join(game, 'modloader', 'Open Limit Adjuster'), oaSource)
  await fsp.writeFile(path.join(game, 'scripts', 'III.VC.SA.LimitAdjuster.asi'), adjusterBytes)

  const dupReport = await runHealthCheck(risky.id)
  const dupCheck = dupReport.checks.find((c) => c.id === 'duplicate-asi')
  check('duplicate .asi: the copy reached only through a junction is not skipped', dupCheck?.status === 'fail', dupCheck)
  check(
    'duplicate .asi: both paths are named - the scripts\\ copy and the junctioned modloader\\ one',
    !!dupCheck?.items?.some(
      (i) =>
        i.includes(path.join('scripts', 'III.VC.SA.LimitAdjuster.asi')) &&
        i.includes(path.join('modloader', 'Open Limit Adjuster', 'III.VC.SA.LimitAdjuster.asi'))
    ),
    dupCheck?.items
  )

  // --- item 08: a second, DIFFERENT limit adjuster stacked on the first ------
  // The field install also had SimpleLimitAdjuster_Enex active alongside Open
  // Limit Adjuster; the CrashList warns explicitly that stacking limit
  // adjusters crashes the game. limitAdjusterNames() is a single boolean regex
  // used everywhere via .some() - this exercises the distinct-count path.
  await fsp.writeFile(path.join(game, 'scripts', 'SimpleLimitAdjuster_Enex.asi'), fakePe(2048, 0x60000000, 0x2102))
  const stackedReport = await runHealthCheck(risky.id)
  const stackedCheck = stackedReport.checks.find((c) => c.id === 'stacked-adjuster')
  check('stacked adjusters: two different products in one profile are flagged', stackedCheck?.status === 'fail', stackedCheck)
  check(
    'stacked adjusters: both products are named',
    !!stackedCheck?.items?.some((i) => i.includes('Open Limit Adjuster')) &&
      !!stackedCheck?.items?.some((i) => i.includes('SimpleLimitAdjuster')),
    stackedCheck?.items
  )

  // Cleaned up so nothing after this point inherits a game folder with two
  // limit adjusters fighting in it.
  await removeLinkOrDir(path.join(game, 'modloader', 'Open Limit Adjuster'))
  await fsp.rm(path.join(game, 'scripts', 'III.VC.SA.LimitAdjuster.asi'), { force: true })
  await fsp.rm(path.join(game, 'scripts', 'SimpleLimitAdjuster_Enex.asi'), { force: true })

  // --- item 08 review: two junctions onto ONE store folder --------------
  // storeKey() is slug+version+variant, so two installs of the same mod+version
  // share a single store folder and materialise as two junctions onto it. The
  // walk's cycle guard used to be a global log of every realpath visited, which
  // entered the first junction and returned immediately on the second - the
  // file was live at two game-relative paths and reported at neither.
  const twinSource = path.join(tmp, 'twin store payload')
  await fsp.mkdir(twinSource, { recursive: true })
  await fsp.writeFile(path.join(twinSource, 'TwinPlugin.asi'), fakePe(3072, 0x60000000, 0x2102))
  await createJunction(path.join(game, 'modloader', 'Alpha Mod'), twinSource)
  await createJunction(path.join(game, 'modloader', 'Beta Mod'), twinSource)
  const twinReport = await runHealthCheck(risky.id)
  const twinCheck = twinReport.checks.find((c) => c.id === 'duplicate-asi')
  check('two junctions, one target: the second junction is walked, not collapsed into the first', twinCheck?.status === 'fail', twinCheck)
  check(
    'two junctions, one target: both game-relative paths are named',
    !!twinCheck?.items?.some(
      (i) =>
        i.includes(path.join('modloader', 'Alpha Mod', 'TwinPlugin.asi')) &&
        i.includes(path.join('modloader', 'Beta Mod', 'TwinPlugin.asi'))
    ),
    twinCheck?.items
  )
  await removeLinkOrDir(path.join(game, 'modloader', 'Alpha Mod'))
  await removeLinkOrDir(path.join(game, 'modloader', 'Beta Mod'))

  // --- item 08 review: no ASI directory detected, plugins loose in the root --
  // The inverse of the field install. modloader.asi absent or undetected and
  // the .asi files sitting in the game root: scanning only scripts\, cleo\ and
  // modloader\ looked everywhere except where the plugins actually were and
  // reported a clean bill of health. `asiDirectory ?? path`, as everywhere else.
  const looseName = 'LooseRootPlugin.asi'
  const looseBytes = fakePe(2560, 0x60000000, 0x2102)
  await fsp.writeFile(path.join(game, looseName), looseBytes)
  await fsp.writeFile(path.join(game, 'scripts', looseName), looseBytes)
  const detectedCheck = await duplicateAssetCheck(installed)
  check(
    'loose root: with scripts\\ detected as the ASI directory the root copy is out of scope - it is the fallback that has to find it',
    !detectedCheck.items?.some((i) => i.includes(looseName)),
    detectedCheck.items
  )
  const looseGame = { ...installed, asiDirectory: null }
  const looseRels = (await scanGameTreeAssets(looseGame)).map((f) => f.rel)
  check(
    'loose root: with no ASI directory detected the game root is scanned',
    looseRels.includes(looseName) && looseRels.includes(path.join('scripts', looseName)),
    looseRels.filter((r) => r.includes('LooseRoot'))
  )
  const looseCheck = await duplicateAssetCheck(looseGame)
  check(
    'loose root: and the duplicate is reported instead of a clean bill of health',
    looseCheck.status === 'fail' && !!looseCheck.items?.some((i) => i.includes(path.join('scripts', looseName))),
    looseCheck
  )
  // --- item 08 review: the fallback walk is capped, and a partial scan says so
  // Making the game root a scan root means recursing a multi-gigabyte install
  // inside a check the user is waiting on, so the walk has a per-run budget.
  // What must never happen is a capped run dressing itself up as a clean folder.
  const cappedScan = await scanGameTree(looseGame, { maxFiles: 2 })
  check(
    'cap: the walk stops at the budget instead of scanning the whole install',
    cappedScan.capped && cappedScan.assets.length <= 2,
    { capped: cappedScan.capped, found: cappedScan.assets.length }
  )
  const cappedCheck = await duplicateAssetCheck(looseGame, { maxFiles: 2 })
  check(
    'cap: the partial scan is reported as partial, not as a clean bill of health',
    (cappedCheck.detail ?? '').includes(t('checks.scanCapped')),
    cappedCheck
  )
  const cappedStacked = await stackedAdjusterCheck(looseGame, { maxFiles: 2 })
  check(
    'cap: the stacked-adjuster check says the same about its own partial scan',
    (cappedStacked.detail ?? '').includes(t('checks.scanCapped')),
    cappedStacked
  )
  check(
    'cap: an uncapped scan of the same folder does not claim to be partial',
    !(looseCheck.detail ?? '').includes(t('checks.scanCapped')),
    looseCheck.detail
  )

  await fsp.rm(path.join(game, looseName), { force: true })
  await fsp.rm(path.join(game, 'scripts', looseName), { force: true })

  getDb().prepare('DELETE FROM profile').run()
  await fsp.rm(tmp, { recursive: true, force: true }).catch(() => undefined)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  return failures
}

/** A minimal but structurally valid PE image, so the real header reader can parse it. */
function fakePe(size: number, timestamp: number, characteristics: number): Buffer {
  const buf = Buffer.alloc(Math.max(size, 0x200))
  buf.writeUInt16LE(0x5a4d, 0) // MZ
  const peOff = 0x80
  buf.writeUInt32LE(peOff, 0x3c)
  buf.writeUInt32LE(0x00004550, peOff) // PE\0\0
  buf.writeUInt16LE(0x014c, peOff + 4) // i386
  buf.writeUInt32LE(timestamp, peOff + 8)
  buf.writeUInt16LE(characteristics, peOff + 22)
  return buf.subarray(0, size)
}

async function snapshotDir(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const f of await walk(dir)) {
    if (f.rel.toLowerCase().endsWith('modloader.ini')) continue // Modão owns this file by design
    out.set(f.rel.toLowerCase(), await sha256File(f.abs))
  }
  return out
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

function diff(a: Map<string, string>, b: Map<string, string>): string[] {
  const out: string[] = []
  for (const [k, v] of a) {
    if (!b.has(k)) out.push(`missing after: ${k}`)
    else if (b.get(k) !== v) out.push(`changed: ${k}`)
  }
  for (const k of b.keys()) if (!a.has(k)) out.push(`added: ${k}`)
  return out
}
