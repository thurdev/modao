import path from 'node:path'
import fsp from 'node:fs/promises'
import { copyRecursive, exists, isDirectory, isLink, mirrorRecursive, removeLinkOrDir, walk } from '../util/fsx'

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
  backedUp: DisplacedFile[]
  quarantined: QuarantinedFile[]
}

/**
 * Anything already at the target that Modão did not put there is preserved,
 * never overwritten in place.
 *
 * Order matters and is the whole point: the copies are taken FIRST and the
 * removal only happens after every one of them exists. An exception anywhere
 * above the removal leaves the user's files exactly where they were.
 *
 * A link is not user content: it points at the store (or at whatever another
 * tool linked), so there is nothing to copy and nothing to restore later, and
 * recording one would promise a restore that could not happen.
 *
 * Ownership of a DIRECTORY is decided per file, not for the folder as a whole.
 * `isOwned` answers "yes" for a folder as soon as one tracked file lives inside
 * it, which is the right answer to "may Modão have this path" and the wrong
 * answer to "is everything in here Modão's". `scripts\` held managed plugins
 * and files nobody tracked side by side, and that is how both went. So a real
 * directory the profile only partly owns is walked, and every file in it that
 * no other install claims is copied out first.
 */
export async function displaceForeign(opts: DisplaceOptions): Promise<DisplaceResult> {
  const nothing: DisplaceResult = { backedUp: [], quarantined: [] }
  const linked = isLink(opts.target)
  if (!exists(opts.target) && !linked) return nothing
  if (linked) {
    await removeLinkOrDir(opts.target)
    return nothing
  }

  if (isOwned(opts.ownedPaths, opts.relativePath)) {
    // A file the profile owns is Modão's own content: the store holds those
    // bytes. No walk, no copy - the cheap answer, and the common one.
    if (!isDirectory(opts.target)) {
      await removeLinkOrDir(opts.target)
      return nothing
    }
    // A real folder is only cheap when it turns out to hold nothing unclaimed.
    // Junctions never reach here, so no ordinary switch pays for this walk.
    const out: DisplaceResult = { backedUp: [], quarantined: [] }
    for (const stray of await unclaimedInside(opts.target, opts.relativePath, opts.ownedPaths)) {
      const copied = await copyOut(stray.abs, stray.relativePath, opts)
      out.backedUp.push(copied.backedUp)
      if (copied.quarantined) out.quarantined.push(copied.quarantined)
    }
    await removeLinkOrDir(opts.target)
    return out
  }

  const copied = await copyOut(opts.target, opts.relativePath, opts)
  await removeLinkOrDir(opts.target)
  return { backedUp: [copied.backedUp], quarantined: copied.quarantined ? [copied.quarantined] : [] }
}

/** Every file under `dir` that no install of the profile claims. */
async function unclaimedInside(
  dir: string,
  relativePath: string,
  ownedPaths: Set<string>
): Promise<{ abs: string; relativePath: string }[]> {
  const base = relativePath.replace(/\\/g, '/').replace(/\/+$/, '')
  const out: { abs: string; relativePath: string }[] = []
  for (const f of await walk(dir)) {
    const rel = `${base}/${path.relative(dir, f.abs).replace(/\\/g, '/')}`
    if (ownedPaths.has(ownedKey(rel))) continue
    out.push({ abs: f.abs, relativePath: rel })
  }
  return out
}

/** Takes both copies of one path. Removes nothing; the caller does that after. */
async function copyOut(
  target: string,
  relativePath: string,
  opts: DisplaceOptions
): Promise<{ backedUp: DisplacedFile; quarantined: QuarantinedFile | null }> {
  const backupPath = path.join(opts.backupDir, relativePath)
  await fsp.mkdir(path.dirname(backupPath), { recursive: true })
  // A backup path repeats across switches, and an older copy of it may be
  // hardlinked into quarantine. Writing over it in place would rewrite that
  // quarantine entry too, so the old bytes are released first and this copy
  // gets an inode of its own.
  await fsp.rm(backupPath, { recursive: true, force: true })
  if (isDirectory(target)) await copyRecursive(target, backupPath)
  else await fsp.copyFile(target, backupPath)

  let quarantined: QuarantinedFile | null = null
  if (opts.quarantineDir) {
    const quarantinePath = path.join(opts.quarantineDir, relativePath)
    // Mirrored from the backup, not from the game folder: one set of bytes on
    // disk, reachable from both places, and the game file is read only once.
    await mirrorRecursive(backupPath, quarantinePath)
    quarantined = { relativePath, quarantinePath }
  }
  return { backedUp: { relativePath, backupPath }, quarantined }
}
