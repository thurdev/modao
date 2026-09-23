import path from 'node:path'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { timestampSlug } from '../util/fsx'
import { activeGame, requireActiveGame } from '../game/detect'
import { applyProfileToIni, readIniFile, writeIniFile } from '../game/modloaderIni'
import { dematerialise, materialise, ownedKey, quarantineEdited } from '../store/contentStore'
import { applyFolderSpelling, disableOnDisk, normaliseOnDisk } from '../store/folderSpelling'
import { loadOrderOf, spellFolderName, type LoadOrderEntry } from '@shared/loadOrder'

interface InstallRow {
  id: number
  store_key: string | null
  folder_name: string | null
  enabled: number
  priority: number
  load_first: number
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

/** How one install's mod folder is spelled in modloader\ right now. */
export function spelledFolderOf(row: { folder_name: string | null; enabled: number; load_first: number }): string | null {
  if (!row.folder_name) return null
  return spellFolderName(row.folder_name, { enabled: !!row.enabled, loadFirst: !!row.load_first })
}

/**
 * The profile's .asi LOAD ORDER, which is not its priority order.
 *
 * Alphabetical by the mod folder's spelled name, "$" first. Priority rides
 * along on every entry and decides nothing here - it answers a different
 * question (who wins a duplicated file) and the two are kept apart on purpose.
 */
export function profileLoadOrder(profileId: number): LoadOrderEntry[] {
  const rows = getDb()
    .prepare(
      `SELECT folder_name, priority, enabled, load_first FROM install
        WHERE profile_id = ? AND folder_name IS NOT NULL`
    )
    .all(profileId) as { folder_name: string; priority: number; enabled: number; load_first: number }[]
  return loadOrderOf(
    rows.map((r) => ({
      folder: r.folder_name,
      enabled: !!r.enabled,
      loadFirst: !!r.load_first,
      priority: r.priority
    }))
  )
}

/**
 * Writes the profile's priority block into modloader.ini and points Mod
 * Loader's own [Folder.Config] Profile at the same name, so the game and
 * Modão never disagree about which mod wins a duplicated file.
 */
export async function syncProfileIni(profileId: number): Promise<string> {
  const game = activeGame()
  if (!game) return ''
  const db = getDb()
  const profile = db.prepare('SELECT name FROM profile WHERE id = ?').get(profileId) as { name: string } | undefined
  if (!profile) return ''
  const rows = db
    .prepare('SELECT folder_name, priority, enabled, load_first FROM install WHERE profile_id = ? AND folder_name IS NOT NULL')
    .all(profileId) as { folder_name: string; priority: number; enabled: number; load_first: number }[]

  const priorities: Record<string, number> = {}
  for (const r of rows) {
    // Keyed by the name the folder actually has on disk: Mod Loader matches a
    // priority line to a folder by string, so a "$VHud" folder needs a "$VHud"
    // line or the number is silently applied to nothing.
    //
    // A disabled mod is still written as 0 - Mod Loader's own "ignore this"
    // value - as a second signal beside the ". " prefix that already stops it
    // being read. Two independent mechanisms both saying off, neither of which
    // removes a file.
    priorities[spelledFolderOf(r) ?? r.folder_name] = r.enabled ? r.priority : 0
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
    // Defensive, and cheap: a folder left wearing a prefix from a previous run
    // would be materialised beside itself under its canonical name.
    if (row.folder_name) {
      await applyFolderSpelling(path.join(game.path, 'modloader'), row.folder_name, { enabled: true, loadFirst: false })
    }
    const result = await materialise(game, row.store_key, files, {
      allowJunction: files.every((f) => f.startsWith('modloader/')),
      backupDir: path.join(Paths.profileBackups(profileId), String(row.id)),
      ownedPaths: pathsOwnedByOtherInstalls(profileId, row.id),
      quarantineDir: displacedQuarantineDir(profileId, row.id, displacedAt)
    })
    // Materialise always writes the canonical folder name; the "$" load-first
    // spelling is applied afterwards, in one rename, so only one place in the
    // app has to know how a folder is spelled.
    if (row.folder_name && row.load_first) {
      await applyFolderSpelling(path.join(game.path, 'modloader'), row.folder_name, { enabled: true, loadFirst: true })
    }
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
    // A mod this profile has switched OFF is already sitting in modloader\ as
    // ". <name>", which Mod Loader does not read. There is nothing to vacate,
    // nothing is in the incoming profile's way (". Foo" and "Foo" are different
    // names), and leaving it alone is what makes disable survive a profile
    // round trip with no file touched. Switching away used to remove it.
    if (!row.enabled) {
      onProgress?.(++done, rows.length)
      continue
    }
    // Everything below addresses the game folder by the recorded path, so a
    // "$" load-first folder gets its plain name back first.
    if (row.load_first) {
      await normaliseOnDisk(game.path, { folderName: row.folder_name, files: [], loadFirst: false })
    }
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

/**
 * Puts one install's game-folder state back in line with its row, without
 * touching the rest of the profile.
 *
 * DISABLING IS A RENAME. It removes nothing. Mod Loader skips any folder whose
 * name starts with ". " (dot space), so switching a mod off renames
 * modloader\<Mod> to modloader\. <Mod> and switching it back on renames it
 * home. Every byte stays where it was, the junction into the content store is
 * never unlinked, and a multi-gigabyte mod goes off and on in one filesystem
 * operation.
 *
 * This used to call `dematerialise`, which removed the materialised files and
 * leaned on the store to put them back. That was recoverable for a store-backed
 * install and silently nothing at all for an adopted one - an adopted loose
 * .asi has no store payload and no recorded hash, so the interlock refused
 * every path, nothing moved, and the call reported success while the plugin
 * went on loading. Both of those problems are gone because the mechanism is
 * gone: nothing in the disable path can remove a file any more.
 */
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
  const target = {
    folderName: row.folder_name,
    loadFirst: !!row.load_first,
    files: files.map((f) => ({ relativePath: f.relative_path, backupPath: f.backup_path, sha256: f.sha256 }))
  }
  if (row.enabled) {
    // EVERY spelling comes off first, the "$" included. `materialise` writes
    // the canonical paths its records name whatever is already on disk, so a
    // folder left spelled "$Mod" here would end up beside a second, canonical
    // copy of the same mod rather than being renamed into it.
    await normaliseOnDisk(game.path, target)
    if (row.store_key) {
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
    }
    // And the load-first spelling goes back on afterwards, once the canonical
    // names are populated - for an adopted install too, which has no store
    // payload to materialise but still owns a folder that can be renamed.
    if (row.load_first && row.folder_name) {
      await applyFolderSpelling(path.join(game.path, 'modloader'), row.folder_name, {
        enabled: true,
        loadFirst: true
      })
    }
  } else {
    await disableOnDisk(game.path, target)
  }
  await syncProfileIni(row.profile_id)
}

/**
 * Puts an install's folders and files back under the names its records use.
 *
 * For the callers that address the game folder by the recorded path and know
 * nothing about prefixes: an uninstall, a rollback. Returns what it renamed.
 */
export async function normaliseInstallSpelling(installId: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM install WHERE id = ?').get(installId) as
    | (InstallRow & { profile_id: number })
    | undefined
  if (!row) return
  const game = activeGame()
  if (!game) return
  const files = filesOf(installId)
  await normaliseOnDisk(game.path, {
    folderName: row.folder_name,
    loadFirst: false,
    files: files.map((f) => ({ relativePath: f.relative_path, backupPath: f.backup_path, sha256: f.sha256 }))
  })
}
