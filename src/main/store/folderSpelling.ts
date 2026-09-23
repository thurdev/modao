import path from 'node:path'
import fsp from 'node:fs/promises'
import {
  DISABLED_FILE_SUFFIX,
  baseFolderName,
  canonicalGameRelative,
  folderNameState,
  folderSpellings,
  spellFolderName,
  type FolderNameState
} from '@shared/loadOrder'
import { exists, isDirectory, isLink, sha256File } from '../util/fsx'

/**
 * Disable by RENAME, which is what Mod Loader documents and what this whole
 * file exists to make structurally true.
 *
 * Nothing here removes a mod's content. Disabling a mod renames its folder to
 * ". <name>", which Mod Loader skips; enabling renames it back. A loose plugin
 * that is not in a mod folder gets the same treatment one level down - the
 * file keeps its bytes and loses the extension the loader scans for.
 *
 * The one thing that is ever removed is a backup Modão itself put back while
 * the mod was off, and only after its bytes have been compared against the
 * backup file it came from - which is still there. That check is in
 * `withdrawRestoredBackup` and it is the only `rm` in this module.
 *
 * No electron, no database: the unit suite runs these against a real temp
 * directory and asserts that a disable/enable round trip changes no byte.
 */

export type SpellingAction =
  | 'folder-renamed'
  | 'file-renamed'
  | 'backup-restored'
  | 'backup-withdrawn'
  | 'blocked'
  /** The folder is already spelled the way it should be. */
  | 'unchanged'
  /** No folder by that name, under any spelling, is in the game folder. */
  | 'absent'

export interface SpellingChange {
  action: SpellingAction
  from: string
  to: string
  /** Set on `blocked`: what stopped the rename, in words. */
  note?: string
}

/** One tracked file, as the install records it. */
export interface SpellingFile {
  relativePath: string
  backupPath: string | null
  sha256: string | null
}

export interface SpellingTarget {
  /** The mod folder this install owns in modloader\, canonical, when it owns one. */
  folderName: string | null
  files: readonly SpellingFile[]
  /** Whether the folder is spelled with the "$" load-first prefix. */
  loadFirst: boolean
}

function presentOnDisk(p: string): boolean {
  // A junction whose target is gone still occupies the name, and renaming it is
  // still the right move; `exists` follows the link and would say no.
  return exists(p) || isLink(p)
}

/** The name this mod folder currently goes by in modloader\, whatever its spelling. */
export async function findFolderSpelling(parentDir: string, base: string): Promise<string | null> {
  const want = baseFolderName(base).toLowerCase()
  const entries = await fsp.readdir(parentDir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    if (baseFolderName(e.name).toLowerCase() === want) return e.name
  }
  return null
}

/** Every mod folder in modloader\, read the way Mod Loader reads the names. */
export async function listModFolders(modloaderDir: string): Promise<(FolderNameState & { name: string })[]> {
  const entries = await fsp.readdir(modloaderDir, { withFileTypes: true }).catch(() => [])
  const out: (FolderNameState & { name: string })[] = []
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue
    const state = folderNameState(e.name)
    // A genuinely hidden folder (".git", ".variants") is not a disabled mod:
    // the disable prefix is a dot AND a space, and nothing else.
    if (!state.disabled && e.name.startsWith('.')) continue
    out.push({ name: e.name, ...state })
  }
  return out
}

/**
 * Renames one mod folder into the spelling its row demands.
 *
 * Refuses rather than overwrites: if both spellings somehow exist, the folder
 * is left exactly as it is and the caller is told. Two folders holding a mod's
 * files is a mess; one of them destroyed is a data loss.
 */
export async function applyFolderSpelling(
  modloaderDir: string,
  base: string,
  state: { enabled: boolean; loadFirst: boolean }
): Promise<SpellingChange> {
  const want = spellFolderName(base, state)
  const present = await findFolderSpelling(modloaderDir, base)
  if (present === null) return { action: 'absent', from: '', to: want }
  if (present === want) return { action: 'unchanged', from: present, to: want }
  const from = path.join(modloaderDir, present)
  const to = path.join(modloaderDir, want)
  if (presentOnDisk(to)) {
    return {
      action: 'blocked',
      from: present,
      to: want,
      note: `${want} already exists beside ${present}; Modão will not write over it`
    }
  }
  await fsp.rename(from, to)
  return { action: 'folder-renamed', from: present, to: want }
}

async function renameFile(from: string, to: string): Promise<boolean> {
  if (!presentOnDisk(from) || isDirectory(from)) return false
  if (presentOnDisk(to)) return false
  await fsp.mkdir(path.dirname(to), { recursive: true })
  await fsp.rename(from, to)
  return true
}

/**
 * A file Modão restored from its own backup while the mod was off, and only
 * that.
 *
 * The path is removed only when its bytes still match the backup file it was
 * copied from AND that backup file is still there - so the content survives in
 * two places at the moment it goes, and a file the user edited in the meantime
 * is left alone and reported instead.
 */
async function withdrawRestoredBackup(abs: string, backupPath: string | null): Promise<SpellingChange | null> {
  if (!backupPath || !exists(backupPath) || isDirectory(backupPath)) return null
  if (!exists(abs) || isDirectory(abs)) return null
  const [here, there] = await Promise.all([sha256File(abs).catch(() => null), sha256File(backupPath).catch(() => null)])
  if (!here || !there || here !== there) return null
  await fsp.rm(abs, { force: true })
  return { action: 'backup-withdrawn', from: abs, to: backupPath }
}

/** Paths the mod folder's own rename already covers, so they are not touched one by one. */
function coveredByFolder(folderName: string | null, relativePath: string): boolean {
  if (!folderName) return false
  const canonical = canonicalGameRelative(relativePath).toLowerCase()
  return canonical.startsWith(`modloader/${baseFolderName(folderName).toLowerCase()}/`)
}

/**
 * Switches one install off without removing anything.
 *
 * The mod folder is renamed to ". <name>". Every loose file the install owns
 * outside that folder is renamed to "<name>.disabled", and anything it
 * displaced when it was written comes back from its backup - which is what
 * makes disabling a mod that overwrote a stock file actually restore the stock
 * file instead of leaving a hole.
 */
export async function disableOnDisk(gamePath: string, target: SpellingTarget): Promise<SpellingChange[]> {
  const changes: SpellingChange[] = []
  if (target.folderName) {
    changes.push(
      await applyFolderSpelling(path.join(gamePath, 'modloader'), target.folderName, {
        enabled: false,
        loadFirst: target.loadFirst
      })
    )
  }
  for (const f of target.files) {
    if (coveredByFolder(target.folderName, f.relativePath)) continue
    const canonical = canonicalGameRelative(f.relativePath)
    const abs = path.join(gamePath, canonical)
    const off = `${abs}${DISABLED_FILE_SUFFIX}`
    const movedAside = await renameFile(abs, off)
    if (movedAside) changes.push({ action: 'file-renamed', from: abs, to: off })
    else if (presentOnDisk(abs) && !isDirectory(abs)) {
      changes.push({ action: 'blocked', from: abs, to: off, note: 'a disabled copy is already there' })
      continue
    }
    // Only when this call actually took our file out of the way: the backup is
    // what belongs at that path while the mod is off, and putting it back at a
    // path we never occupied would be inventing a change nobody asked for.
    if (movedAside && f.backupPath && exists(f.backupPath) && !isDirectory(f.backupPath) && !presentOnDisk(abs)) {
      await fsp.mkdir(path.dirname(abs), { recursive: true })
      await fsp.copyFile(f.backupPath, abs)
      changes.push({ action: 'backup-restored', from: f.backupPath, to: abs })
    }
  }
  return changes
}

/**
 * Switches one install back on.
 *
 * The exact inverse: any backup Modão restored while the mod was off is
 * withdrawn (bytes verified against the backup that is still on disk), each
 * ".disabled" file gets its name back, and the mod folder loses the ". "
 * prefix - keeping "$" if the mod is spelled to load first.
 */
export async function enableOnDisk(gamePath: string, target: SpellingTarget): Promise<SpellingChange[]> {
  const changes: SpellingChange[] = []
  for (const f of target.files) {
    if (coveredByFolder(target.folderName, f.relativePath)) continue
    const canonical = canonicalGameRelative(f.relativePath)
    const abs = path.join(gamePath, canonical)
    const off = `${abs}${DISABLED_FILE_SUFFIX}`
    if (!presentOnDisk(off)) continue
    const withdrawn = await withdrawRestoredBackup(abs, f.backupPath)
    if (withdrawn) changes.push(withdrawn)
    if (presentOnDisk(abs)) {
      changes.push({
        action: 'blocked',
        from: off,
        to: abs,
        note: 'something else is at that path now; the disabled copy was left where it is'
      })
      continue
    }
    if (await renameFile(off, abs)) changes.push({ action: 'file-renamed', from: off, to: abs })
  }
  if (target.folderName) {
    changes.push(
      await applyFolderSpelling(path.join(gamePath, 'modloader'), target.folderName, {
        enabled: true,
        loadFirst: target.loadFirst
      })
    )
  }
  return changes
}

/**
 * Is this recorded path in the game folder under ANY spelling Mod Loader reads?
 *
 * The records are canonical; the disk may carry a ". " disable prefix, a "$"
 * load-first prefix, or a ".disabled" suffix. Anything that asks "is this file
 * still there" has to ask it this way, or a mod the user switched off - or set
 * to load first - reads as a mod whose files have vanished, and the app starts
 * refusing switches and forgetting installs over a rename.
 */
export function resolveSpelledPath(gamePath: string, relativePath: string): string | null {
  const canonical = canonicalGameRelative(relativePath)
  const parts = canonical.split('/')
  const candidates = new Set<string>([canonical, `${canonical}${DISABLED_FILE_SUFFIX}`])
  if (parts.length > 1 && parts[0].toLowerCase() === 'modloader') {
    for (const folder of folderSpellings(parts[1])) {
      const rest = parts.slice(2)
      candidates.add(['modloader', folder, ...rest].join('/'))
      // ...and the sub-mod one level down, which carries the prefix too.
      if (rest.length > 1) {
        for (const sub of folderSpellings(rest[0])) {
          candidates.add(['modloader', folder, sub, ...rest.slice(1)].join('/'))
        }
      }
    }
  }
  for (const c of candidates) {
    const abs = path.join(gamePath, c)
    if (presentOnDisk(abs)) return abs
  }
  return null
}

/** As above, when only the yes/no is wanted. */
export function existsUnderAnySpelling(gamePath: string, relativePath: string): boolean {
  return resolveSpelledPath(gamePath, relativePath) !== null
}

/**
 * Puts every spelling back to canonical, for the callers that address the game
 * folder by the recorded path: an uninstall, a rollback, a profile switch
 * vacating the folder. None of them knows about prefixes, and none of them
 * should have to.
 */
export async function normaliseOnDisk(gamePath: string, target: SpellingTarget): Promise<SpellingChange[]> {
  return enableOnDisk(gamePath, { ...target, loadFirst: false })
}

/**
 * Turns one nested sub-mod on or off. Mod Loader treats a folder inside a mod
 * folder as its own unit, so the same ". " prefix applies one level down -
 * which is what replaced an `fsp.rm` that deleted straight through the junction
 * into Modão's own content store.
 */
export async function setSubFolderEnabled(
  gamePath: string,
  folderName: string,
  relativePath: string,
  enabled: boolean
): Promise<SpellingChange> {
  const modloaderDir = path.join(gamePath, 'modloader')
  const spelled = (await findFolderSpelling(modloaderDir, folderName)) ?? folderName
  const parts = canonicalGameRelative(relativePath).split('/').filter(Boolean)
  if (parts.length === 0) return { action: 'absent', from: '', to: '' }
  // Only the last segment carries the prefix; the ones above it are ordinary
  // folders that have to be walked in whatever spelling they already have.
  let dir = path.join(modloaderDir, spelled)
  for (const segment of parts.slice(0, -1)) {
    dir = path.join(dir, (await findFolderSpelling(dir, segment)) ?? segment)
  }
  return applyFolderSpelling(dir, parts[parts.length - 1], { enabled, loadFirst: false })
}
