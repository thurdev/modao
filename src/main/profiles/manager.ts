import path from 'node:path'
import fsp from 'node:fs/promises'
import type { Profile, SnapshotEntry, SwitchVerification } from '@shared/types'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { exists, isDirectory, isLink, moveSafe, slugify, timestampSlug, walk } from '../util/fsx'
import { activeGame, requireActiveGame } from '../game/detect'
import { gameDefinition, type GameKind } from '@shared/games'
import { clampPriority } from '../game/modloaderIni'
import { providesKey } from '../conflicts'
import { ownedKey, storeDir } from '../store/contentStore'
import { dematerialiseProfile, iniProfileName, materialiseProfile, syncProfileIni } from './materialize'
import {
  ingestUnstoredInstalls,
  lastRestorableSwitch,
  listJournals,
  openJournal,
  planSwitch,
  recordManifest,
  recordVerification,
  restoreFromJournal,
  setJournalState,
  snapshotFiles,
  verifySnapshot,
  verifySwitch
} from './switchTx'
import { currentSlots, detectExistingSaves, importExistingSaves, listSnapshots, profileSavesDir, swapSaves } from './saves'

interface ProfileRow {
  id: number
  name: string
  game_kind: string | null
  color: string
  notes: string
  created_at: string
  last_played_at: string | null
  is_active: number
  game_id: number | null
}

const COLORS = ['#6c8cff', '#f5a524', '#41c7a0', '#e5646b', '#b07cf5', '#59b0f2']

/**
 * The profiles that belong to the game currently selected.
 *
 * A profile is a mod set for one game: a Vice City profile materialised into a
 * San Andreas folder would be nonsense, so the list the UI sees is scoped to the
 * active install. Profiles made before the app knew about other games carry no
 * game of their own and are treated as San Andreas, which is what they are.
 */
export async function listProfiles(scope: GameKind | 'all' = activeGame()?.kind ?? 'all'): Promise<Profile[]> {
  const db = getDb()
  const all = db.prepare('SELECT * FROM profile ORDER BY id').all() as ProfileRow[]
  const rows = scope === 'all' ? all : all.filter((r) => (r.game_kind ?? 'sa') === scope)
  const out: Profile[] = []
  for (const r of rows) {
    const counts = db
      .prepare('SELECT COUNT(*) total, COALESCE(SUM(enabled),0) enabled FROM install WHERE profile_id = ?')
      .get(r.id) as { total: number; enabled: number }
    const size = db
      .prepare('SELECT COALESCE(SUM(f.size),0) s FROM install_file f JOIN install i ON i.id = f.install_id WHERE i.profile_id = ?')
      .get(r.id) as { s: number }
    const snaps = await listSnapshots(r.id)
    const live = r.is_active ? await currentSlots(r.id) : null
    out.push({
      id: r.id,
      name: r.name,
      color: r.color,
      notes: r.notes,
      createdAt: r.created_at,
      lastPlayedAt: r.last_played_at,
      isActive: !!r.is_active,
      gameKind: (r.game_kind ?? 'sa') as GameKind,
      modCount: counts.total,
      enabledCount: counts.enabled,
      totalSize: size.s,
      saveCount: live ? live.slots.length : (snaps[0]?.slots.length ?? (await profileSlotCount(r.id)))
    })
  }
  return out
}

async function profileSlotCount(profileId: number): Promise<number> {
  const dir = Paths.profileSaves(profileId)
  if (!exists(dir)) return 0
  return (await walk(dir)).filter((f) => /GTASAsf\d\.b$/i.test(f.rel)).length
}

export async function activeProfile(): Promise<Profile | null> {
  const row = getDb().prepare('SELECT id FROM profile WHERE is_active = 1').get() as { id: number } | undefined
  if (!row) return null
  return (await listProfiles()).find((p) => p.id === row.id) ?? null
}

export async function createProfile(input: {
  name: string
  color?: string
  notes?: string
  copyFrom?: number
}): Promise<Profile> {
  const db = getDb()
  const game = activeGame()
  const now = new Date().toISOString()
  const profileCount = (db.prepare('SELECT COUNT(*) c FROM profile').get() as { c: number }).c
  const color = input.color ?? COLORS[profileCount % COLORS.length]
  const info = db
    .prepare('INSERT INTO profile (name, color, notes, created_at, is_active, game_id, game_kind) VALUES (?,?,?,?,0,?,?)')
    .run(input.name.trim() || 'New profile', color, input.notes ?? '', now, game?.id ?? null, game?.kind ?? 'sa')
  const id = Number(info.lastInsertRowid)

  if (input.copyFrom) copyInstalls(input.copyFrom, id)

  const anyActive = db.prepare('SELECT COUNT(*) c FROM profile WHERE is_active = 1').get() as { c: number }
  if (anyActive.c === 0) db.prepare('UPDATE profile SET is_active = 1 WHERE id = ?').run(id)

  return (await listProfiles()).find((p) => p.id === id)!
}

interface InstallRowFull {
  id: number
  mod_version_id: number
  destination_class: string
  variant_choice: string | null
  enabled: number
  priority: number
  store_key: string | null
  folder_name: string | null
  readme_text: string | null
  source_archive: string | null
}

/** The values a recreated install takes from elsewhere instead of from the row it is copied from. */
interface InstallOverride {
  enabled?: boolean
  priority?: number
  variantChoice?: string | null
}

/** Duplicating a profile duplicates rows only - the mod payloads stay shared in the store. */
function copyInstalls(fromId: number, toId: number): void {
  const ids = getDb().prepare('SELECT id FROM install WHERE profile_id = ? ORDER BY id').all(fromId) as { id: number }[]
  copyInstallRows(
    ids.map((r) => ({ installId: r.id })),
    toId
  )
}

/**
 * Recreates existing installs inside another profile by copying their rows.
 * Nothing is downloaded, extracted or written to the game folder: the payload
 * already lives once in the content store and every profile that uses it just
 * points at the same store key. Returns how many installs were recreated.
 */
function copyInstallRows(sources: { installId: number; override?: InstallOverride }[], toId: number): number {
  const db = getDb()
  const select = db.prepare('SELECT * FROM install WHERE id = ?')
  const selectFiles = db.prepare('SELECT relative_path, sha256, size, destination_class FROM install_file WHERE install_id = ?')
  const insert = db.prepare(
    `INSERT INTO install (profile_id, mod_version_id, installed_at, destination_class, variant_choice,
                          enabled, priority, store_key, folder_name, readme_text, source_archive)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  const insertFile = db.prepare(
    `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
     VALUES (?,?,?,?,0,NULL,?)`
  )
  const insertProvides = db.prepare('INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,?,?)')
  let copied = 0
  db.transaction(() => {
    for (const source of sources) {
      const i = select.get(source.installId) as InstallRowFull | undefined
      if (!i) continue
      const override = source.override ?? {}
      const newId = Number(
        insert.run(
          toId,
          i.mod_version_id,
          new Date().toISOString(),
          i.destination_class,
          override.variantChoice !== undefined ? override.variantChoice : i.variant_choice,
          override.enabled === undefined ? i.enabled : override.enabled ? 1 : 0,
          override.priority === undefined ? i.priority : clampPriority(override.priority),
          i.store_key,
          i.folder_name,
          i.readme_text,
          i.source_archive
        ).lastInsertRowid
      )
      const files = selectFiles.all(i.id) as {
        relative_path: string
        sha256: string
        size: number
        destination_class: string
      }[]
      for (const f of files) {
        insertFile.run(newId, f.relative_path, f.sha256, f.size, f.destination_class)
        insertProvides.run(newId, providesKey(f.relative_path), f.sha256, f.size)
      }
      copied++
    }
  })()
  return copied
}

export async function updateProfile(id: number, patch: { name?: string; color?: string; notes?: string }): Promise<Profile> {
  const db = getDb()
  const current = db.prepare('SELECT * FROM profile WHERE id = ?').get(id) as ProfileRow | undefined
  if (!current) throw new Error(`Profile #${id} no longer exists.`)
  db.prepare('UPDATE profile SET name = ?, color = ?, notes = ? WHERE id = ?').run(
    patch.name ?? current.name,
    patch.color ?? current.color,
    patch.notes ?? current.notes,
    id
  )
  if (current.is_active) await syncProfileIni(id)
  return (await listProfiles()).find((p) => p.id === id)!
}

export async function deleteProfile(id: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT is_active FROM profile WHERE id = ?').get(id) as { is_active: number } | undefined
  if (!row) return
  if (row.is_active) throw new Error('Switch to another profile before deleting this one.')
  // Saves and snapshots are never destroyed; they move to quarantine.
  const dir = Paths.profile(id)
  if (exists(dir)) await moveSafe(dir, path.join(Paths.quarantine(), 'profiles', `${id}-${Date.now()}`))
  db.prepare('DELETE FROM profile WHERE id = ?').run(id)
}

export interface ActivateResult {
  elapsedMs: number
  log: string[]
  /** The journal row this switch was recorded in, for "Restore previous state". */
  journalId: number | null
  verification: SwitchVerification | null
  /**
   * Game-relative paths of files that were copied to quarantine during this
   * switch, either because the user had edited them or because an incoming mod
   * needed their exact path. Quarantine is never cleared on its own.
   */
  quarantined: string[]
}

/**
 * A switch that materialised but did not reconcile: the game folder does not
 * hold what the profile says it holds.
 *
 * It carries the whole verification so the UI can name every mod that did not
 * arrive, and the journal id so the user can be offered the rollback. A mod
 * that vanished on a switch used to be a line in a log nobody opened, under a
 * profile the app had already recorded as active.
 */
export class SwitchVerificationError extends Error {
  readonly verification: SwitchVerification
  readonly log: string[]
  readonly journalId: number
  readonly profileId: number
  readonly profileName: string
  readonly previousProfileName: string | null

  constructor(args: {
    verification: SwitchVerification
    log: string[]
    journalId: number
    previousProfileName: string | null
  }) {
    super(
      `${args.verification.profileName} was not activated: the game folder does not hold what it says it holds.\n` +
        args.verification.blockingProblems.map((p) => `  - ${p}`).join('\n')
    )
    this.name = 'SwitchVerificationError'
    this.verification = args.verification
    this.log = args.log
    this.journalId = args.journalId
    this.profileId = args.verification.profileId
    this.profileName = args.verification.profileName
    this.previousProfileName = args.previousProfileName
  }
}

/**
 * Switching profiles, as a transaction.
 *
 *   1. plan      - work out every file that would move, touching nothing
 *   2. ingest    - copy anything adopted but not yet in the store, with hashes
 *   3. snapshot  - copy every file about to be removed or overwritten and verify
 *                  each copy by hash; abort here on any mismatch
 *   4. apply     - vacate, swap saves, materialise; only snapshotted files may
 *                  be removed, and unmanaged files are never touched
 *   5. verify    - the switch is not complete until the game folder holds what
 *                  the profile says it holds. Only then is the profile recorded
 *                  active; a failure here throws SwitchVerificationError and
 *                  leaves the previous profile active, with the journal in
 *                  place for "Restore previous state".
 *
 * Steps 1-3 change nothing in the game folder, so a failure before step 4 leaves
 * the install exactly as it was.
 */
export async function activateProfile(
  id: number,
  onProgress?: (phase: string, done: number, total: number) => void
): Promise<ActivateResult> {
  const db = getDb()
  const game = requireActiveGame()
  const t0 = Date.now()
  const log: string[] = []
  const current = db.prepare('SELECT id, name FROM profile WHERE is_active = 1').get() as { id: number; name: string } | undefined
  const target = db.prepare('SELECT id, name, game_kind FROM profile WHERE id = ?').get(id) as
    | { id: number; name: string; game_kind: string | null }
    | undefined
  if (!target) throw new Error('That profile no longer exists.')
  const targetGame = (target.game_kind ?? 'sa') as GameKind
  if (targetGame !== game.kind) {
    throw new Error(
      `${target.name} is a ${gameDefinition(targetGame).name} profile and the active install is ${game.gameName}. ` +
        'Switch to that game first.'
    )
  }
  if (current?.id === id) {
    return { elapsedMs: 0, log: [`${target.name} is already active.`], journalId: null, verification: null, quarantined: [] }
  }

  onProgress?.('plan', 0, 1)
  const plan = await planSwitch(id)
  if (plan.unresolved.length) {
    // Every one of these would silently fail to appear after the switch.
    throw new Error(
      `${plan.unresolved.length} mod(s) in ${target.name} cannot be materialised, so the switch was not started:\n` +
        plan.unresolved.map((u) => `  - ${u.label}: ${u.reason}`).join('\n')
    )
  }

  const journal = openJournal(current?.id ?? null, id)
  let snapshot: SnapshotEntry[] = []
  const quarantined: string[] = []

  /**
   * Copies every path out and proves the copy by hash before the switch is
   * allowed to touch any of them. Used for the outgoing profile's own files and
   * for the user's own files that an incoming mod is about to displace - the
   * second set used not to be snapshotted at all.
   */
  const snapshotAndVerify = async (relativePaths: string[]): Promise<void> => {
    const unique = [...new Set(relativePaths)]
    if (unique.length === 0) return
    snapshot = await snapshotFiles(game.path, unique, journal.snapshotDir)
    const verified = await verifySnapshot(snapshot)
    if (!verified.ok) {
      throw new Error(
        'The backup taken before the switch did not verify, so nothing was changed:\n  ' + verified.problems.slice(0, 5).join('\n  ')
      )
    }
    recordManifest(journal.id, snapshot)
    log.push(`Backed up ${snapshot.length} file(s) to ${journal.snapshotDir}, every copy verified by hash.`)
  }

  try {
    if (current) {
      onProgress?.('ingest', 0, 1)
      // Adopted content exists only in the game folder. It has to exist somewhere
      // else before that folder can be vacated - the absence of this step once
      // deleted every loose .asi and CLEO script a user had.
      const ingested = await ingestUnstoredInstalls(current.id, game.path, (d, t) => onProgress?.('ingest', d, t))
      if (ingested.ingested) {
        log.push(`Copied ${ingested.ingested} adopted mod(s) (${ingested.files} file(s)) into the Modão store.`)
      }
      for (const f of ingested.failed) log.push(`Note: ${f.label} - ${f.reason}`)

      onProgress?.('snapshot', 0, 1)
      // Re-planned after the ingest: adopted installs now have a store key, so
      // what is removable has changed since the plan the caller saw.
      const replan = await planSwitch(id)
      await snapshotAndVerify([
        ...replan.outgoing.filter((p) => p.action === 'snapshot-and-remove').map((p) => p.relativePath),
        ...replan.willBeOverwritten
      ])
      if (replan.willBeOverwritten.length) {
        log.push(
          `${replan.willBeOverwritten.length} file(s) you put in the game folder yourself sit where ${target.name} installs its own: ` +
            `${replan.willBeOverwritten.slice(0, 5).join(', ')}${replan.willBeOverwritten.length > 5 ? ', ...' : ''}. ` +
            'They were backed up and copied to quarantine before being replaced.'
        )
      }

      onProgress?.('unlink', 0, 1)
      const snapshotted = new Set(snapshot.map((e) => ownedKey(e.relativePath)))
      const out = await dematerialiseProfile(current.id, { snapshotted }, (d, t) => onProgress?.('unlink', d, t))
      log.push(`Removed ${out.removed} item(s) for ${current.name}; restored ${out.restored} displaced file(s).`)
      if (out.leftInPlace.length) {
        log.push(
          `${out.leftInPlace.length} file(s) stayed in the game folder because no verified backup of them exists: ` +
            `${out.leftInPlace.slice(0, 5).join(', ')}${out.leftInPlace.length > 5 ? ', ...' : ''}`
        )
      }
      if (out.quarantined.length) {
        quarantined.push(...out.quarantined)
        log.push(
          `${out.quarantined.length} file(s) you edited after installing were copied to quarantine before the link went: ` +
            `${out.quarantined.slice(0, 5).join(', ')}${out.quarantined.length > 5 ? ', ...' : ''}`
        )
      }
      const leftAlone = plan.unmanaged.filter((rel) => !plan.willBeOverwritten.includes(rel))
      if (leftAlone.length) {
        log.push(`${leftAlone.length} unmanaged file(s) in the game folder were left untouched.`)
      }
    } else if (plan.willBeOverwritten.length) {
      // No profile is active, so there is no outgoing snapshot - but the user's
      // own files at the incoming paths still need one.
      onProgress?.('snapshot', 0, 1)
      await snapshotAndVerify(plan.willBeOverwritten)
    }

    onProgress?.('saves', 0, 1)
    const swap = await swapSaves(current?.id ?? null, id)
    log.push(`Saves: ${swap.movedOut} file(s) stored for the outgoing profile, ${swap.movedIn} restored for ${target.name}.`)
    if (swap.rescuedSnapshotId !== null) {
      log.push('Saves that belonged to no profile were found in the live folder and snapshotted before the switch.')
    }

    onProgress?.('link', 0, 1)
    const inResult = await materialiseProfile(id, (d, t) => onProgress?.('link', d, t))
    log.push(...inResult.log)
    for (const s of inResult.skipped) log.push(`Not materialised - ${s}`)
    if (inResult.quarantined.length) {
      quarantined.push(...inResult.quarantined)
      log.push(
        `${inResult.quarantined.length} file(s) already in the game folder were copied to quarantine before ${target.name} took their path: ` +
          `${inResult.quarantined.slice(0, 5).join(', ')}${inResult.quarantined.length > 5 ? ', ...' : ''}`
      )
    }

    await syncProfileIni(id)
    setJournalState(journal.id, 'applied')

    // Reconciliation runs BEFORE the profile is recorded active. It used to run
    // after, so a mod that never reached the game folder left the app claiming
    // the broken profile was in place and the user found out in the game.
    // Nothing below this line happens unless the folder holds what the profile
    // says it holds.
    onProgress?.('verify', 0, 1)
    const verification = await verifySwitch(id)
    recordVerification(journal.id, verification)
    if (verification.blockingProblems.length) {
      log.push(`The switch was refused after materialising: ${verification.blockingProblems.join(' ')}`)
      throw new SwitchVerificationError({
        verification,
        log,
        journalId: journal.id,
        previousProfileName: current?.name ?? null
      })
    }

    db.transaction(() => {
      db.prepare('UPDATE profile SET is_active = 0').run()
      db.prepare('UPDATE profile SET is_active = 1 WHERE id = ?').run(id)
    })()
    setJournalState(journal.id, verification.ok ? 'verified' : 'failed', verification.ok ? null : verification.problems.join(' '))
    log.push(
      verification.ok
        ? `Verified: ${verification.modsMaterialised}/${verification.modsExpected} mod(s) in place, ` +
            `${verification.asiCount} .asi, ${verification.cleoPluginCount} CLEO plugin(s), ${verification.cleoScriptCount} CLEO script(s).`
        : `Switched. Notes that do not block the switch: ${verification.problems.join(' ')}`
    )

    return { elapsedMs: Date.now() - t0, log, journalId: journal.id, verification, quarantined }
  } catch (e) {
    setJournalState(journal.id, 'failed', (e as Error).message)
    throw e
  }
}

/**
 * Rolls a switch back to the state its snapshot recorded: whatever the switch
 * linked in is taken out, every file in the verified backup goes back where it
 * came from, the saves swap back, and the previous profile is active again.
 *
 * Vacating the profile whose files are in the game folder is the same removal a
 * switch does, so it gets the same interlock. It used to run with no options at
 * all, which meant no snapshot set, which meant every tracked real file of that
 * profile was deleted outright - and for an adopted install (no store copy, no
 * recorded hash) there was nothing anywhere to put back.
 *
 * "Whose files are in the game folder" is usually the active profile, but not
 * after a switch that materialised and then failed reconciliation: that profile
 * was never recorded active, so the DB still names the one before it while the
 * folder holds the one that failed. Undoing that switch has to vacate the
 * profile that actually landed.
 */
export async function restorePreviousState(journalId?: number): Promise<{ log: string[]; restored: number }> {
  const db = getDb()
  const journal = journalId ? listJournals(50).find((j) => j.id === journalId) ?? null : lastRestorableSwitch()
  if (!journal) throw new Error('There is no switch with a backup to restore from.')
  if (journal.fromProfileId === null) throw new Error('That switch had no previous profile to go back to.')

  const log: string[] = []
  const active = db.prepare('SELECT id, name FROM profile WHERE is_active = 1').get() as { id: number; name: string } | undefined
  // A journal that reached verification and still failed is exactly the
  // materialised-but-not-activated case; a failure before that point recorded
  // no verification and materialised nothing of the incoming profile.
  const landedButNotActive = journal.state === 'failed' && journal.verification !== null && journal.toProfileId !== active?.id
  const current = landedButNotActive
    ? (db.prepare('SELECT id, name FROM profile WHERE id = ?').get(journal.toProfileId) as { id: number; name: string } | undefined)
    : active
  if (current) {
    const game = requireActiveGame()
    // Adopted content exists only in the game folder; it has to exist somewhere
    // else before that folder can be vacated.
    const ingested = await ingestUnstoredInstalls(current.id, game.path)
    if (ingested.ingested) {
      log.push(`Copied ${ingested.ingested} adopted mod(s) (${ingested.files} file(s)) of ${current.name} into the Modão store first.`)
    }
    for (const f of ingested.failed) log.push(`Note: ${f.label} - ${f.reason}`)

    const undoDir = path.join(Paths.profileBackups(current.id), `undo-${String(journal.id).padStart(4, '0')}-${timestampSlug()}`)
    const live = (
      db
        .prepare(
          `SELECT DISTINCT f.relative_path p FROM install_file f JOIN install i ON i.id = f.install_id WHERE i.profile_id = ?`
        )
        .all(current.id) as { p: string }[]
    )
      .map((r) => r.p)
      .filter((rel) => {
        const abs = path.join(game.path, rel)
        return exists(abs) && !isLink(abs) && !isDirectory(abs)
      })
    const undo = await snapshotFiles(game.path, live, undoDir)
    const verified = await verifySnapshot(undo)
    if (!verified.ok) {
      throw new Error(
        `The backup of ${current.name} taken before the restore did not verify, so nothing was changed:\n  ` +
          verified.problems.slice(0, 5).join('\n  ')
      )
    }
    if (undo.length) log.push(`Backed up ${undo.length} file(s) of ${current.name} to ${undoDir} before removing them.`)

    const snapshotted = new Set(undo.map((e) => ownedKey(e.relativePath)))
    const out = await dematerialiseProfile(current.id, { snapshotted })
    log.push(`Removed ${out.removed} item(s) that ${current.name} had materialised.`)
    if (out.quarantined.length) {
      log.push(
        `${out.quarantined.length} file(s) you edited were copied to quarantine first: ` +
          `${out.quarantined.slice(0, 5).join(', ')}${out.quarantined.length > 5 ? ', ...' : ''}`
      )
    }
    if (out.leftInPlace.length) {
      log.push(
        `${out.leftInPlace.length} file(s) stayed in the game folder because no verified backup of them exists: ` +
          `${out.leftInPlace.slice(0, 5).join(', ')}${out.leftInPlace.length > 5 ? ', ...' : ''}`
      )
    }
  }
  const result = await restoreFromJournal(journal.id)
  log.push(`Restored ${result.restored} file(s) from ${journal.snapshotDir}.`)
  log.push(...result.problems.map((p) => `Problem: ${p}`))

  await swapSaves(current?.id ?? null, journal.fromProfileId)
  db.transaction(() => {
    db.prepare('UPDATE profile SET is_active = 0').run()
    db.prepare('UPDATE profile SET is_active = 1 WHERE id = ?').run(journal.fromProfileId)
  })()
  const name = (db.prepare('SELECT name FROM profile WHERE id = ?').get(journal.fromProfileId) as { name: string }).name
  log.push(`${name} is active again.`)
  return { log, restored: result.restored }
}

/** The snapshot label the user sees for the saves they already had. */
const ADOPTED_SAVES_LABEL = 'Imported from your existing install'

export interface AdoptResult {
  profileId: number
  adopted: number
  report: string[]
}

/**
 * Adopts an existing install: every folder already in modloader\ is indexed
 * in place. No file is moved, renamed or rewritten - the user's install is
 * treated as the source of truth, including its current modloader.ini
 * priorities.
 *
 * Save games get the same treatment. Whatever is already in
 * Documents\GTA San Andreas User Files is copied into the new profile and
 * snapshotted, so the first profile switch cannot hand the user's existing
 * campaign to the wrong profile. The live folder itself is only read.
 */
export async function adoptInstall(profileName: string, onProgress?: (done: number, total: number) => void): Promise<AdoptResult> {
  const game = requireActiveGame()
  const profile = await createProfile({ name: profileName, notes: `Adopted from ${game.path}` })
  const result = await adoptIntoProfile(profile.id, onProgress)

  const db = getDb()
  db.prepare('UPDATE profile SET is_active = 1 WHERE id = ?').run(profile.id)
  db.prepare('UPDATE profile SET is_active = 0 WHERE id != ?').run(profile.id)

  const report = [...result.report]
  const existingSaves = await detectExistingSaves()
  if (existingSaves.found && existingSaves.importedIntoProfileId === null) {
    const imported = await importExistingSaves(profile.id, ADOPTED_SAVES_LABEL)
    const what = [`${imported.slots} save slot(s)`]
    if (existingSaves.hasSettings) what.push('gta_sa.set')
    report.push(
      `Saves: copied ${what.join(' and ')} (${existingSaves.sizeBytes} bytes) from ${existingSaves.path} into ` +
        `${profileSavesDir(profile.id)} and kept snapshot #${imported.snapshotId} "${ADOPTED_SAVES_LABEL}". ` +
        'Your save folder was read only - nothing there was moved, renamed or deleted.'
    )
  } else if (existingSaves.found) {
    report.push(
      `Saves: the ${existingSaves.slots.length} save slot(s) in ${existingSaves.path} were already imported into profile ` +
        `#${existingSaves.importedIntoProfileId}; nothing was copied again.`
    )
  }

  return { profileId: profile.id, adopted: result.adopted, report }
}

/**
 * Indexes whatever is in the game folder into a profile that already exists.
 *
 * Adoption is not a first-run-only event: a user can add a game later, create a
 * profile by hand, or install mods outside Modão, and in every one of those
 * cases the game folder holds content no profile knows about. Folders this
 * profile already tracks are skipped, and so are the junctions Modão itself
 * materialised - those belong to a profile's store and adopting them would
 * index the same payload twice.
 */
export async function adoptIntoProfile(
  profileId: number,
  onProgress?: (done: number, total: number) => void
): Promise<AdoptResult> {
  const db = getDb()
  const game = requireActiveGame()
  const report: string[] = []
  const profile = db.prepare('SELECT id, name FROM profile WHERE id = ?').get(profileId) as
    | { id: number; name: string }
    | undefined
  if (!profile) throw new Error(`Profile #${profileId} no longer exists.`)

  const tracked = new Set(
    (db.prepare('SELECT folder_name FROM install WHERE profile_id = ? AND folder_name IS NOT NULL').all(profileId) as {
      folder_name: string
    }[]).map((r) => r.folder_name.toLowerCase())
  )

  const modloaderPath = path.join(game.path, 'modloader')
  const { readIniFile, readPriorities } = await import('../game/modloaderIni')
  const ini = await readIniFile(path.join(modloaderPath, 'modloader.ini'))
  // Read the block that belongs to this profile, not a hard-coded "Default":
  // whatever the user already set is what adoption must keep.
  const existingPriorities = readPriorities(ini, iniProfileName(profile.name), { inherit: true })

  const folders = exists(modloaderPath)
    ? (await fsp.readdir(modloaderPath, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    : []

  const now = new Date().toISOString()
  let adopted = 0
  let done = 0
  for (const folder of folders) {
    const abs = path.join(modloaderPath, folder.name)
    if (tracked.has(folder.name.toLowerCase())) {
      onProgress?.(++done, folders.length)
      continue
    }
    if (isLink(abs)) {
      // A junction here is a mod Modão materialised from its own store for
      // some profile; indexing it would duplicate that payload.
      report.push(`${folder.name}: already materialised by Modão, skipped`)
      onProgress?.(++done, folders.length)
      continue
    }
    const files = await walk(abs)
    if (files.length === 0) {
      report.push(`${folder.name}: empty, skipped`)
      onProgress?.(++done, folders.length)
      continue
    }
    const slug = `adopted-${slugify(folder.name)}`
    let mod = db.prepare('SELECT id FROM mod WHERE slug = ?').get(slug) as { id: number } | undefined
    if (!mod) {
      mod = {
        id: Number(
          db
            .prepare(
              `INSERT INTO mod (slug, title, author, category, source_url, description, first_seen_at, rating_inputs_json)
               VALUES (?,?,?,?,?,?,?,?)`
            )
            .run(slug, folder.name, 'Unknown', 'Adopted', '', 'Adopted from an existing install.', now, '{}').lastInsertRowid
        )
      }
    }
    const versionId = Number(
      db.prepare('INSERT INTO mod_version (mod_id, version_label, release_date, file_size) VALUES (?,?,?,?)').run(
        mod.id,
        'adopted',
        now,
        files.reduce((a, f) => a + f.size, 0)
      ).lastInsertRowid
    )
    const priority = existingPriorities[folder.name] ?? 50
    const installId = Number(
      db
        .prepare(
          `INSERT INTO install (profile_id, mod_version_id, installed_at, destination_class, variant_choice,
                                enabled, priority, store_key, folder_name, readme_text, source_archive)
           VALUES (?,?,?,?,NULL,1,?,NULL,?,NULL,NULL)`
        )
        .run(profileId, versionId, now, 'modloader-folder', priority, folder.name).lastInsertRowid
    )
    const insertFile = db.prepare(
      `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
       VALUES (?,?,NULL,?,0,NULL,'modloader-folder')`
    )
    const insertProvides = db.prepare('INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,NULL,?)')
    db.transaction(() => {
      for (const f of files) {
        const rel = `modloader/${folder.name}/${f.rel}`
        insertFile.run(installId, rel, f.size)
        insertProvides.run(installId, providesKey(rel), f.size)
      }
    })()
    adopted++
    report.push(`${folder.name}: ${files.length} files, priority ${priority}`)
    onProgress?.(++done, folders.length)
  }

  // Loose .asi / .cleo / .cs plugins already present are indexed too.
  const extra = await adoptLoosePlugins(profileId, game.path, game.asiDirectory ?? game.path)
  if (extra.length) report.push(...extra)

  db.prepare('UPDATE game_install SET adopted_at = ? WHERE id = ?').run(now, game.id)
  await syncProfileIni(profileId)

  return { profileId, adopted, report }
}

export interface UnmanagedContent {
  /** Mod Loader folders in the game that this profile does not track. */
  folders: string[]
  /** Loose .asi plugins in the detected ASI directory that this profile does not track. */
  asi: string[]
  /** .cleo plugins and .cs scripts in cleo\ that this profile does not track. */
  cleo: string[]
  total: number
}

/**
 * What is sitting in the game folder that the given profile knows nothing
 * about. Answering this is what lets the UI offer adoption at any time instead
 * of only on the very first run - a profile created by hand starts empty, and
 * without this the user sees a mod folder full of mods and a library that says
 * nothing is installed.
 */
export async function unmanagedContent(profileId: number): Promise<UnmanagedContent> {
  const game = activeGame()
  if (!game) return { folders: [], asi: [], cleo: [], total: 0 }
  const db = getDb()

  const trackedFolders = new Set(
    (db.prepare('SELECT folder_name FROM install WHERE profile_id = ? AND folder_name IS NOT NULL').all(profileId) as {
      folder_name: string
    }[]).map((r) => r.folder_name.toLowerCase())
  )
  const trackedFiles = new Set(
    (db
      .prepare(
        `SELECT lower(f.relative_path) p FROM install_file f JOIN install i ON i.id = f.install_id
          WHERE i.profile_id = ?`
      )
      .all(profileId) as { p: string }[]).map((r) => r.p)
  )

  const modloaderPath = path.join(game.path, 'modloader')
  const folders: string[] = []
  if (exists(modloaderPath)) {
    for (const e of await fsp.readdir(modloaderPath, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const abs = path.join(modloaderPath, e.name)
      if (trackedFolders.has(e.name.toLowerCase()) || isLink(abs)) continue
      const files = await walk(abs, { maxFiles: 1 })
      if (files.length > 0) folders.push(e.name)
    }
  }

  const loose = async (dir: string, match: RegExp, prefix: string): Promise<string[]> => {
    if (!exists(dir)) return []
    const out: string[] = []
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      if (!e.isFile() || !match.test(e.name)) continue
      if (e.name.toLowerCase() === 'modloader.asi') continue
      const rel = `${prefix}${e.name}`.toLowerCase()
      if (!trackedFiles.has(rel)) out.push(e.name)
    }
    return out
  }

  const asiDir = game.asiDirectory ?? game.path
  const asiPrefix = path.relative(game.path, asiDir).split(path.sep).join('/')
  const asi = await loose(asiDir, /\.asi$/i, asiPrefix ? `${asiPrefix}/` : '')
  const cleo = await loose(path.join(game.path, 'cleo'), /\.(cleo\d?|cs|cm)$/i, 'cleo/')

  return { folders, asi, cleo, total: folders.length + asi.length + cleo.length }
}

async function adoptLoosePlugins(profileId: number, gamePath: string, asiDir: string): Promise<string[]> {
  const db = getDb()
  const out: string[] = []
  const now = new Date().toISOString()

  // Files this profile already owns are not loose. Without this check, adoption
  // indexed a plugin an install had just placed as a mod of its own: a user
  // installed Story Mode, whose payload is scripts\TrilogyChaosMod.SA.asi, and
  // ended up with the mod and a second entry called TrilogyChaosMod.SA.asi.
  const tracked = new Set(
    (
      db
        .prepare(
          `SELECT lower(f.relative_path) p FROM install_file f
             JOIN install i ON i.id = f.install_id
            WHERE i.profile_id = ?`
        )
        .all(profileId) as { p: string }[]
    ).map((r) => r.p.replace(/\\/g, '/'))
  )
  const groups: { label: string; dir: string; match: RegExp; dest: string }[] = [
    { label: 'ASI plugins', dir: asiDir, match: /\.asi$/i, dest: 'asi-plugin' },
    { label: 'CLEO plugins', dir: path.join(gamePath, 'cleo'), match: /\.cleo\d?$/i, dest: 'cleo-plugin' },
    { label: 'CLEO scripts', dir: path.join(gamePath, 'cleo'), match: /\.(cs|cm)$/i, dest: 'cleo-script' }
  ]
  for (const g of groups) {
    if (!exists(g.dir)) continue
    const files = (await fsp.readdir(g.dir, { withFileTypes: true }))
      .filter((e) => e.isFile() && g.match.test(e.name) && e.name.toLowerCase() !== 'modloader.asi')
      .map((e) => e.name)
    for (const name of files) {
      // Already owned by an install in this profile: not loose, not adoptable.
      const owned = path.relative(gamePath, path.join(g.dir, name)).replace(/\\/g, '/').toLowerCase()
      if (tracked.has(owned)) continue
      const slug = `adopted-${slugify(name)}`
      let mod = db.prepare('SELECT id FROM mod WHERE slug = ?').get(slug) as { id: number } | undefined
      if (!mod) {
        mod = {
          id: Number(
            db
              .prepare(
                `INSERT INTO mod (slug, title, author, category, source_url, description, first_seen_at, rating_inputs_json)
                 VALUES (?,?,?,?,?,?,?,?)`
              )
              .run(slug, name, 'Unknown', 'Adopted', '', `Adopted ${g.label.toLowerCase()} found in the game folder.`, now, '{}')
              .lastInsertRowid
          )
        }
      }
      const abs = path.join(g.dir, name)
      const size = (await fsp.stat(abs)).size
      const versionId = Number(
        db.prepare('INSERT INTO mod_version (mod_id, version_label, release_date, file_size) VALUES (?,?,?,?)').run(mod.id, 'adopted', now, size)
          .lastInsertRowid
      )
      const installId = Number(
        db
          .prepare(
            `INSERT INTO install (profile_id, mod_version_id, installed_at, destination_class, variant_choice,
                                  enabled, priority, store_key, folder_name, readme_text, source_archive)
             VALUES (?,?,?,?,NULL,1,50,NULL,NULL,NULL,NULL)`
          )
          .run(profileId, versionId, now, g.dest).lastInsertRowid
      )
      const rel = path.relative(gamePath, abs).replace(/\\/g, '/')
      db.prepare(
        `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
         VALUES (?,?,NULL,?,0,NULL,?)`
      ).run(installId, rel, size, g.dest)
      db.prepare('INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,NULL,?)').run(
        installId,
        providesKey(rel),
        size
      )
    }
    const adoptedHere = files.filter(
      (name) => !tracked.has(path.relative(gamePath, path.join(g.dir, name)).replace(/\\/g, '/').toLowerCase())
    ).length
    if (adoptedHere) out.push(`${g.label}: adopted ${adoptedHere}`)
  }
  return out
}

// ---------------------------------------------------------------------------
// Export / import
// ---------------------------------------------------------------------------

export interface ProfileManifest {
  format: 'modao-profile'
  version: 1
  exportedAt: string
  profile: { name: string; color: string; notes: string }
  mods: {
    slug: string
    title: string
    author: string
    sourceUrl: string
    versionLabel: string
    priority: number
    enabled: boolean
    variantChoice: string | null
    destinationClass: string
  }[]
}

export function buildManifest(profileId: number): ProfileManifest {
  const db = getDb()
  const p = db.prepare('SELECT * FROM profile WHERE id = ?').get(profileId) as ProfileRow | undefined
  if (!p) throw new Error(`Profile #${profileId} no longer exists; there is nothing to export.`)
  const rows = db
    .prepare(
      `SELECT m.slug, m.title, m.author, m.source_url, mv.version_label, i.priority, i.enabled,
              i.variant_choice, i.destination_class
         FROM install i
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ? ORDER BY m.title`
    )
    .all(profileId) as {
    slug: string
    title: string
    author: string
    source_url: string
    version_label: string
    priority: number
    enabled: number
    variant_choice: string | null
    destination_class: string
  }[]
  return {
    format: 'modao-profile',
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: { name: p.name, color: p.color, notes: p.notes },
    mods: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      author: r.author,
      sourceUrl: r.source_url,
      versionLabel: r.version_label,
      priority: r.priority,
      enabled: !!r.enabled,
      variantChoice: r.variant_choice,
      destinationClass: r.destination_class
    }))
  }
}

export interface ImportResult {
  profileId: number
  /** Mods recreated into the new profile from a payload that was already in the local store. */
  resolved: number
  /** Mods the catalogue knows but this machine holds no payload for; the UI offers them for download. */
  needsDownload: string[]
  /** Slugs the catalogue does not know at all. */
  unresolved: string[]
}

/**
 * Import re-resolves each mod from the catalog; binaries are never shipped in
 * the archive. A mod whose payload is already in the local content store -
 * because another profile installed it - is recreated here by copying its rows,
 * so the import costs no download and no extraction: every profile that uses a
 * payload points at the same store key. The manifest's own priority, enabled
 * and variant values win over the install the rows are copied from.
 *
 * The version label is preferred but not required: labels in this scene are
 * unreliable, and a payload of the same mod already on disk is still better
 * than sending the user to download one. Anything that cannot be recreated is
 * reported rather than silently counted as success.
 */
export async function importManifest(manifest: ProfileManifest): Promise<ImportResult> {
  if (manifest.format !== 'modao-profile') throw new Error('That file is not a Modão profile export.')
  const db = getDb()
  const profile = await createProfile({
    name: `${manifest.profile.name} (imported)`,
    color: manifest.profile.color,
    notes: manifest.profile.notes
  })
  const localPayloads = db.prepare(
    `SELECT i.id AS install_id, i.store_key
       FROM install i
       JOIN mod_version mv ON mv.id = i.mod_version_id
      WHERE mv.mod_id = ? AND i.store_key IS NOT NULL
      ORDER BY CASE WHEN mv.version_label = ? THEN 0 ELSE 1 END, i.id DESC`
  )
  const unresolved: string[] = []
  const needsDownload: string[] = []
  const sources: { installId: number; override: InstallOverride }[] = []
  for (const m of manifest.mods) {
    const mod = db.prepare('SELECT id FROM mod WHERE slug = ?').get(m.slug) as { id: number } | undefined
    if (!mod) {
      unresolved.push(`${m.title} (${m.slug}) - not in the catalog`)
      continue
    }
    const candidates = localPayloads.all(mod.id, m.versionLabel) as { install_id: number; store_key: string }[]
    const local = candidates.find((c) => exists(storeDir(c.store_key)))
    if (!local) {
      needsDownload.push(`${m.title} (${m.slug}) ${m.versionLabel} - in the catalog, but no copy on this machine yet`)
      continue
    }
    sources.push({
      installId: local.install_id,
      override: { enabled: m.enabled, priority: m.priority, variantChoice: m.variantChoice }
    })
  }
  const resolved = copyInstallRows(sources, profile.id)
  // Only an active profile owns modloader.ini; an imported one is written when it is switched to.
  if (resolved && profile.isActive) await syncProfileIni(profile.id)
  return { profileId: profile.id, resolved, needsDownload, unresolved }
}
