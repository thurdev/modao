import path from 'node:path'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { timestampSlug } from '../util/fsx'
import { activeGame, requireActiveGame } from '../game/detect'
import { applyProfileToIni, readIniFile, writeIniFile } from '../game/modloaderIni'
import { dematerialise, materialise, ownedKey, quarantineEdited } from '../store/contentStore'

interface InstallRow {
  id: number
  store_key: string | null
  folder_name: string | null
  enabled: number
  priority: number
  destination_class: string
}

export function installsOf(profileId: number): InstallRow[] {
  return getDb().prepare('SELECT * FROM install WHERE profile_id = ? ORDER BY id').all(profileId) as InstallRow[]
}

/**
 * Every path the REST of this profile owns, in the one spelling ownership is
 * compared under - the same meaning the install path has always used.
 *
 * The install now being written must not be in here. Its own targets are
 * exactly the paths whose current occupant has to be looked at, and a switch
 * that handed in its own targets answered "already ours" about every one of
 * them: a user's loose scripts\MixSets.asi was force-removed with no backup,
 * no snapshot and no quarantine the moment a profile carrying a MixSets.asi
 * was materialised.
 */
function pathsOwnedByOtherInstalls(profileId: number, exceptInstallId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT f.relative_path p FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.id != ?`
    )
    .all(profileId, exceptInstallId) as { p: string }[]
  return new Set(rows.map((r) => ownedKey(r.p)))
}

/**
 * Where the user can find content a mod displaced from its own path. Stamped
 * with the moment it happened, so a later switch adds an entry rather than
 * writing over the one already there: quarantine keeps what it is given until
 * the user clears it.
 */
function displacedQuarantineDir(profileId: number, installId: number, at: string): string {
  return path.join(Paths.quarantine(), 'displaced', String(profileId), at, String(installId))
}

interface InstallFileRow {
  relative_path: string
  backup_path: string | null
  sha256: string | null
}

function filesOf(installId: number): InstallFileRow[] {
  return getDb()
    .prepare('SELECT relative_path, backup_path, sha256 FROM install_file WHERE install_id = ?')
    .all(installId) as InstallFileRow[]
}

/**
 * Writes the profile's priority block into modloader.ini and points Mod
 * Loader's own [Folder.Config] Profile at the same name, so the game and
 * Modão never disagree about load order.
 */
export async function syncProfileIni(profileId: number): Promise<string> {
  const game = activeGame()
  if (!game) return ''
  const db = getDb()
  const profile = db.prepare('SELECT name FROM profile WHERE id = ?').get(profileId) as { name: string } | undefined
  if (!profile) return ''
  const rows = db
    .prepare('SELECT folder_name, priority, enabled FROM install WHERE profile_id = ? AND folder_name IS NOT NULL')
    .all(profileId) as { folder_name: string; priority: number; enabled: number }[]

  const priorities: Record<string, number> = {}
  for (const r of rows) {
    // A disabled mod is written as 0, which is Mod Loader's own "ignore this" value.
    priorities[r.folder_name] = r.enabled ? r.priority : 0
  }
  const iniPath = path.join(game.path, 'modloader', 'modloader.ini')
  const ini = await readIniFile(iniPath)
  applyProfileToIni(ini, iniProfileName(profile.name), priorities)
  await writeIniFile(iniPath, ini)
  return iniPath
}

/** Mod Loader profile names are INI section fragments; keep them simple. */
export function iniProfileName(name: string): string {
  return name.replace(/[[\]=;#]/g, '').trim() || 'Default'
}

export async function materialiseProfile(
  profileId: number,
  onProgress?: (done: number, total: number, label: string) => void
): Promise<{ links: number; backedUp: number; quarantined: string[]; skipped: string[]; log: string[] }> {
  const game = requireActiveGame()
  const rows = installsOf(profileId).filter((r) => r.enabled)
  const log: string[] = []
  const quarantined: string[] = []
  const displacedAt = timestampSlug()
  const skipped: string[] = []
  let links = 0
  let backedUp = 0
  let done = 0
  for (const row of rows) {
    const files = filesOf(row.id).map((f) => f.relative_path)
    if (!row.store_key || files.length === 0) {
      // Adopted installs are already in place and have nothing to link; anything
      // else here would just not appear, so say which and why.
      if (files.length === 0) skipped.push(`${row.folder_name ?? `install ${row.id}`}: no files are recorded for it`)
      continue
    }
    const result = await materialise(game, row.store_key, files, {
      allowJunction: files.every((f) => f.startsWith('modloader/')),
      backupDir: path.join(Paths.profileBackups(profileId), String(row.id)),
      ownedPaths: pathsOwnedByOtherInstalls(profileId, row.id),
      quarantineDir: displacedQuarantineDir(profileId, row.id, displacedAt)
    })
    links += result.files
    backedUp += result.backedUp.length
    quarantined.push(...result.quarantined.map((q) => q.relativePath))
    if (result.backedUp.length) {
      const stmt = getDb().prepare('UPDATE install_file SET backup_path = ?, was_overwrite = 1 WHERE install_id = ? AND relative_path = ?')
      for (const b of result.backedUp) stmt.run(b.backupPath, row.id, b.relativePath)
    }
    log.push(`${row.folder_name ?? `install ${row.id}`}: ${result.mode} (${result.files} files)`)
    onProgress?.(++done, rows.length, row.folder_name ?? String(row.id))
  }
  await syncProfileIni(profileId)
  return { links, backedUp, quarantined, skipped, log }
}

/**
 * Vacates the game folder for a profile that is being switched away from.
 *
 * Nothing here removes a real file on trust. The caller hands in the set of
 * paths a verified snapshot already holds, and any file outside that set stays
 * exactly where it is and comes back in `leftInPlace`. Links are different:
 * they point at the store, so dropping one destroys nothing.
 *
 * A file whose bytes no longer match what Modão wrote was edited by the
 * user, so a copy also goes to quarantine - which is never cleared on its own -
 * before the link to it goes.
 */
export async function dematerialiseProfile(
  profileId: number,
  opts: { snapshotted?: Set<string> } = {},
  onProgress?: (done: number, total: number) => void
): Promise<{ removed: number; restored: number; quarantined: string[]; leftInPlace: string[] }> {
  const game = activeGame()
  if (!game) return { removed: 0, restored: 0, quarantined: [], leftInPlace: [] }
  const rows = installsOf(profileId)
  let removed = 0
  let restored = 0
  let done = 0
  const quarantined: string[] = []
  const leftInPlace: string[] = []
  const snapshotted = opts.snapshotted
  for (const row of rows) {
    const files = filesOf(row.id)
    quarantined.push(
      ...(await quarantineEdited(
        game.path,
        files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256 })),
        path.join(Paths.quarantine(), 'profile-switch', String(profileId), String(row.id))
      ))
    )
    const r = await dematerialise(
      game,
      files.map((f) => f.relative_path),
      files.filter((f) => f.backup_path).map((f) => ({ relativePath: f.relative_path, backupPath: f.backup_path! })),
      // No snapshot set means no verified copy of anything, so nothing real may
      // go. The caller gets every path back in `leftInPlace` and can say so.
      { mayRemoveFile: snapshotted ? (rel) => snapshotted.has(ownedKey(rel)) : () => false }
    )
    removed += r.removed
    restored += r.restored
    leftInPlace.push(...r.skipped)
    onProgress?.(++done, rows.length)
  }
  return { removed, restored, quarantined, leftInPlace }
}

/** Re-links one install after it was enabled or disabled, without touching the rest of the profile. */
export async function remateriliseInstall(installId: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM install WHERE id = ?').get(installId) as InstallRow & { profile_id: number }
  const game = requireActiveGame()
  const profile = db.prepare('SELECT is_active FROM profile WHERE id = ?').get(row.profile_id) as { is_active: number }
  if (!profile?.is_active) {
    await syncProfileIni(row.profile_id)
    return
  }
  const files = filesOf(installId)
  if (row.enabled) {
    if (!row.store_key) return
    await materialise(
      game,
      row.store_key,
      files.map((f) => f.relative_path),
      {
        allowJunction: files.every((f) => f.relative_path.startsWith('modloader/')),
        backupDir: path.join(Paths.profileBackups(row.profile_id), String(installId)),
        ownedPaths: pathsOwnedByOtherInstalls(row.profile_id, installId),
        quarantineDir: displacedQuarantineDir(row.profile_id, installId, timestampSlug())
      }
    )
  } else {
    // A file the user edited after it was written is theirs, not ours to drop,
    // whichever way it leaves the game folder. Uninstall has always done this;
    // disabling a mod is the same removal and used not to.
    await quarantineEdited(
      game.path,
      files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256 })),
      path.join(Paths.quarantine(), 'disabled', String(installId))
    )
    // Disabling one mod must not take files another install still provides -
    // and must not remove anything the store cannot put back.
    const shared = new Set(
      (
        db
          .prepare(
            `SELECT DISTINCT f.relative_path p FROM install_file f
               JOIN install i ON i.id = f.install_id
              WHERE i.profile_id = ? AND i.id != ? AND i.enabled = 1`
          )
          .all(row.profile_id, installId) as { p: string }[]
      ).map((r) => ownedKey(r.p))
    )
    const restorable = new Set(
      files.filter((f) => f.sha256 || row.store_key).map((f) => ownedKey(f.relative_path))
    )
    await dematerialise(
      game,
      files.map((f) => f.relative_path),
      files.filter((f) => f.backup_path).map((f) => ({ relativePath: f.relative_path, backupPath: f.backup_path! })),
      { mayRemoveFile: (rel) => !shared.has(ownedKey(rel)) && restorable.has(ownedKey(rel)) }
    )
  }
  await syncProfileIni(row.profile_id)
}
