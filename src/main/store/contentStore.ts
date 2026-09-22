import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import type { GameInstall, PlannedFile } from '@shared/types'
import { Paths } from '../util/paths'
import {
  copyRecursive,
  createJunction,
  exists,
  isDirectory,
  isLink,
  linkOrCopyFile,
  removeLinkOrDir,
  sameVolume,
  sha256File,
  walk
} from '../util/fsx'

/**
 * Modão keeps exactly one copy of every mod payload in userData and
 * materialises the active profile into the game folder with links. Mod folders
 * routinely total several gigabytes, so nothing is ever duplicated per profile.
 */
export function storeKey(slug: string, versionLabel: string, variant: string | null): string {
  return crypto.createHash('sha256').update(`${slug}\u0000${versionLabel}\u0000${variant ?? ''}`).digest('hex').slice(0, 24)
}

export function storeDir(key: string): string {
  return path.join(Paths.storeMods(), key)
}

/** Copies the planned files out of the extraction staging area into the store. */
export async function ingest(
  key: string,
  extractRoot: string,
  files: PlannedFile[],
  onProgress?: (done: number, total: number) => void
): Promise<PlannedFile[]> {
  const dest = storeDir(key)
  await fsp.mkdir(dest, { recursive: true })
  const out: PlannedFile[] = []
  let done = 0
  for (const f of files) {
    const from = path.join(extractRoot, f.sourcePath)
    const to = path.join(dest, f.targetRelative)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
    const sha = await sha256File(to)
    out.push({ ...f, sha256: sha })
    onProgress?.(++done, files.length)
  }
  return out
}

export async function storeSize(key: string): Promise<number> {
  const dir = storeDir(key)
  if (!exists(dir)) return 0
  return (await walk(dir)).reduce((a, f) => a + f.size, 0)
}

export type MaterialiseMode = 'junction' | 'hardlink' | 'copy'

export interface MaterialiseResult {
  mode: MaterialiseMode
  files: number
  backedUp: { relativePath: string; backupPath: string }[]
}

/**
 * Places one install's files into the game folder.
 *
 * A mod folder with no overlay on top of it becomes a junction, which is
 * instant regardless of size. A mod that something overlays is materialised as
 * individual hardlinks so the overlay can replace a file without mutating the
 * shared store copy. Cross-volume installs fall back to copying.
 */
export async function materialise(
  game: GameInstall,
  key: string,
  targets: string[],
  opts: { allowJunction: boolean; backupDir: string; ownedPaths: Set<string> }
): Promise<MaterialiseResult> {
  const src = storeDir(key)
  const backedUp: MaterialiseResult['backedUp'] = []
  const folderTargets = new Set<string>()
  for (const t of targets) {
    const m = /^modloader\/([^/]+)\//.exec(t)
    if (m) folderTargets.add(`modloader/${m[1]}`)
  }

  const canJunction =
    opts.allowJunction &&
    folderTargets.size > 0 &&
    targets.every((t) => [...folderTargets].some((f) => t.startsWith(`${f}/`)))

  if (canJunction) {
    for (const folder of folderTargets) {
      const link = path.join(game.path, folder)
      await backupIfForeign(link, opts.backupDir, opts.ownedPaths, backedUp, folder)
      await createJunction(link, path.join(src, folder))
    }
    return { mode: 'junction', files: targets.length, backedUp }
  }

  let mode: MaterialiseMode = sameVolume(src, game.path) ? 'hardlink' : 'copy'
  for (const t of targets) {
    const from = path.join(src, t)
    const to = path.join(game.path, t)
    if (!exists(from)) continue
    await backupIfForeign(to, opts.backupDir, opts.ownedPaths, backedUp, t)
    mode = await linkOrCopyFile(from, to)
  }
  return { mode, files: targets.length, backedUp }
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
 * The owned set is a set of files, but a junction is placed at a folder
 * (`modloader/<mod>`), so the two are compared at the same granularity: a
 * folder is ours when any file we track lives inside it. Without this a
 * junction target could never match, and every mod folder Modão had itself
 * written would be treated as a foreign file and "backed up" on every switch.
 */
function isOwned(ownedPaths: Set<string>, relativePath: string): boolean {
  const key = ownedKey(relativePath)
  if (ownedPaths.has(key)) return true
  const prefix = `${key}/`
  for (const owned of ownedPaths) {
    if (owned.startsWith(prefix)) return true
  }
  return false
}

/**
 * Anything already at the target that Modão did not put there is preserved,
 * never overwritten in place - but only a copy that actually happened is
 * recorded as a backup. A link is not user content: it points at the store (or
 * at whatever another tool linked), so there is nothing to copy and nothing to
 * restore later, and recording one would promise a restore that could not
 * happen.
 */
async function backupIfForeign(
  target: string,
  backupDir: string,
  ownedPaths: Set<string>,
  log: MaterialiseResult['backedUp'],
  relativePath: string
): Promise<void> {
  const linked = isLink(target)
  if (!exists(target) && !linked) return
  if (linked || isOwned(ownedPaths, relativePath)) {
    await removeLinkOrDir(target)
    return
  }
  const backupPath = path.join(backupDir, relativePath)
  await fsp.mkdir(path.dirname(backupPath), { recursive: true })
  // An exception here aborts before the removal: nothing goes that was not copied first.
  if (isDirectory(target)) await copyRecursive(target, backupPath)
  else await fsp.copyFile(target, backupPath)
  log.push({ relativePath, backupPath })
  await removeLinkOrDir(target)
}

/** One install-tracked file, as Modão recorded it at the moment it wrote it. */
export interface TrackedFile {
  relativePath: string
  sha256: string | null
}

/**
 * Nothing Modão removes from the game folder is simply deleted once the user
 * has touched it. Before an install's files are unlinked - by an uninstall, or
 * by a profile switch vacating the folder - each one is compared against the
 * hash recorded when it was written. A file that still matches is ours to
 * remove, because the store holds the same bytes. A file whose bytes differ
 * belongs to whoever edited it, so a copy is taken into the quarantine folder
 * before it goes.
 *
 * A file with no recorded hash (an adopted install, indexed in place) is left
 * alone: with nothing to compare against, "changed" cannot be established.
 *
 * Returns the relative paths that were quarantined.
 */
export async function quarantineEdited(gamePath: string, files: TrackedFile[], quarantineDir: string): Promise<string[]> {
  const quarantined: string[] = []
  for (const f of files) {
    if (!f.sha256) continue
    const abs = path.join(gamePath, f.relativePath)
    if (!exists(abs) || isDirectory(abs)) continue
    const current = await sha256File(abs).catch(() => null)
    if (!current || current === f.sha256) continue
    const dest = path.join(quarantineDir, f.relativePath)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(abs, dest)
    quarantined.push(f.relativePath)
  }
  return quarantined
}

/**
 * Removes one install's files from the game folder, restoring anything it
 * displaced.
 *
 * `mayRemoveFile` is the safety interlock: a real file is only ever removed
 * when the caller can say, for that exact path, that a verified copy exists
 * somewhere else. Anything it refuses is left where it is and reported, because
 * a file Modão cannot put back is a file Modão must not take away.
 */
export async function dematerialise(
  game: GameInstall,
  targets: string[],
  backups: { relativePath: string; backupPath: string }[],
  opts: { mayRemoveFile?: (relativePath: string) => boolean } = {}
): Promise<{ removed: number; restored: number; skipped: string[] }> {
  let removed = 0
  const skipped: string[] = []
  const folders = new Set<string>()
  for (const t of targets) {
    const m = /^modloader\/([^/]+)/.exec(t)
    if (m) folders.add(`modloader/${m[1]}`)
  }
  // Junctioned mod folders disappear in one step; never recurse into the target.
  for (const folder of folders) {
    const p = path.join(game.path, folder)
    if (isLink(p)) {
      await removeLinkOrDir(p)
      removed++
    }
  }
  for (const t of targets) {
    const p = path.join(game.path, t)
    if (!exists(p) || isDirectory(p)) continue
    // A link points at the store; the content survives its removal.
    if (!isLink(p) && opts.mayRemoveFile && !opts.mayRemoveFile(t)) {
      skipped.push(t)
      continue
    }
    await fsp.rm(p, { force: true })
    removed++
  }
  for (const folder of folders) {
    await pruneEmpty(path.join(game.path, folder))
  }
  let restored = 0
  for (const b of backups) {
    const to = path.join(game.path, b.relativePath)
    if (!exists(b.backupPath)) continue
    await fsp.mkdir(path.dirname(to), { recursive: true })
    if (isDirectory(b.backupPath)) await copyRecursive(b.backupPath, to)
    else await fsp.copyFile(b.backupPath, to)
    restored++
  }
  return { removed, restored, skipped }
}

async function pruneEmpty(dir: string): Promise<void> {
  if (!exists(dir) || isLink(dir) || !isDirectory(dir)) return
  const entries = await fsp.readdir(dir)
  for (const e of entries) {
    const p = path.join(dir, e)
    if (isDirectory(p) && !isLink(p)) await pruneEmpty(p)
  }
  const left = await fsp.readdir(dir)
  if (left.length === 0) await fsp.rmdir(dir).catch(() => undefined)
}
