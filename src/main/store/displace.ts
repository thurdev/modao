import path from 'node:path'
import fsp from 'node:fs/promises'
import { copyRecursive, exists, isDirectory, isLink, mirrorRecursive, removeLinkOrDir } from '../util/fsx'

/**
 * Whose file is the one already sitting at a target path, and what happens to
 * it when Modão needs that path.
 *
 * This lives apart from `contentStore` on purpose: it is the decision that once
 * destroyed 14 .asi files and 27 CLEO scripts in a single profile switch, so it
 * has to be reachable from a plain Node test. `contentStore` reaches Electron's
 * `app` through `Paths`, which a unit test cannot load; nothing here does.
 */

/** One file (or folder) moved aside so a mod could take its path. */
export interface DisplacedFile {
  relativePath: string
  backupPath: string
}

/** The user-visible copy of a displaced file. Quarantine is never cleared on its own. */
export interface QuarantinedFile {
  relativePath: string
  quarantinePath: string
}

/**
 * The single spelling every game-relative path is compared under. Mod Loader
 * paths reach us from SQLite, from the plan and from Windows itself, so they
 * are folded to lowercase with forward slashes before either side of an
 * ownership test looks at them.
 */
export function ownedKey(relativePath: string): string {
  return relativePath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
}

/**
 * Is what sits at this path Modão's own content?
 *
 * `ownedPaths` is every path the REST of the profile owns - never the paths of
 * the install now being written. An install's own target is exactly the path
 * whose current occupant has to be examined, so folding it into the owned set
 * would answer "ours" about a file Modão has never seen, and that is precisely
 * the bug that deleted a user's loose plugins.
 *
 * The owned set is a set of files, but a junction is placed at a folder
 * (`modloader/<mod>`), so the two are compared at the same granularity: a
 * folder is ours when any file we track lives inside it.
 */
export function isOwned(ownedPaths: Set<string>, relativePath: string): boolean {
  const key = ownedKey(relativePath)
  if (ownedPaths.has(key)) return true
  const prefix = `${key}/`
  for (const owned of ownedPaths) {
    if (owned.startsWith(prefix)) return true
  }
  return false
}

export interface DisplaceOptions {
  /** Absolute path in the game folder that is about to be written. */
  target: string
  /** The same path, game-relative, as it is recorded and compared. */
  relativePath: string
  /** Paths owned by the OTHER installs of this profile. */
  ownedPaths: Set<string>
  /** Where a displaced file is kept so it can be put back when the mod goes. */
  backupDir: string
  /** Where the user can find it themselves. Omitted only where there is no user-facing switch. */
  quarantineDir?: string
}

export interface DisplaceResult {
  backedUp: DisplacedFile | null
  quarantined: QuarantinedFile | null
}

/**
 * Anything already at the target that Modão did not put there is preserved,
 * never overwritten in place.
 *
 * Order matters and is the whole point: the copies are taken FIRST and the
 * removal only happens after both of them exist. An exception anywhere above
 * the removal leaves the user's file exactly where it was.
 *
 * A link is not user content: it points at the store (or at whatever another
 * tool linked), so there is nothing to copy and nothing to restore later, and
 * recording one would promise a restore that could not happen.
 */
export async function displaceForeign(opts: DisplaceOptions): Promise<DisplaceResult> {
  const nothing: DisplaceResult = { backedUp: null, quarantined: null }
  const linked = isLink(opts.target)
  if (!exists(opts.target) && !linked) return nothing
  if (linked || isOwned(opts.ownedPaths, opts.relativePath)) {
    await removeLinkOrDir(opts.target)
    return nothing
  }

  const backupPath = path.join(opts.backupDir, opts.relativePath)
  await fsp.mkdir(path.dirname(backupPath), { recursive: true })
  // A backup path repeats across switches, and an older copy of it may be
  // hardlinked into quarantine. Writing over it in place would rewrite that
  // quarantine entry too, so the old bytes are released first and this copy
  // gets an inode of its own.
  await fsp.rm(backupPath, { recursive: true, force: true })
  if (isDirectory(opts.target)) await copyRecursive(opts.target, backupPath)
  else await fsp.copyFile(opts.target, backupPath)

  let quarantined: QuarantinedFile | null = null
  if (opts.quarantineDir) {
    const quarantinePath = path.join(opts.quarantineDir, opts.relativePath)
    // Mirrored from the backup, not from the game folder: one set of bytes on
    // disk, reachable from both places, and the game file is read only once.
    await mirrorRecursive(backupPath, quarantinePath)
    quarantined = { relativePath: opts.relativePath, quarantinePath }
  }

  await removeLinkOrDir(opts.target)
  return { backedUp: { relativePath: opts.relativePath, backupPath }, quarantined }
}
