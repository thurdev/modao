/**
 * Duplicate binary detection across the live game tree.
 *
 * The conflict index (`src/main/conflicts/index.ts`, `providesKey`) keys
 * `scripts/x.asi` and `modloader/<mod>/x.asi` differently on purpose - it
 * answers "which install wins this filename inside Mod Loader's own
 * resolution", and by that rule the two live in different namespaces. That
 * makes it structurally blind to the exact failure this module exists to
 * catch: the SAME plugin dropped in both places, patching the same limits
 * twice and fighting itself into a crash (0x004C67BB - a pedestrian-model
 * limit that never took effect, because two copies of
 * III.VC.SA.LimitAdjuster.asi were both live at once: one in scripts\ and one
 * junctioned in modloader\Open Limit Adjuster\).
 *
 * This module answers a different, simpler question: are the SAME BYTES
 * sitting at two or more paths, regardless of which directory convention put
 * them there? The key is file name + content hash, not a Mod-Loader-relative
 * path - two files with different names are never a "duplicate" here even if
 * byte-identical (that is a different, unbranded copy of the same plugin;
 * out of scope), and two files sharing a name but not their bytes are not a
 * duplicate either (that is an upgrade or a variant, not a fight).
 *
 * Free of Electron and of the filesystem: hashing and walking happen in
 * src/main/diagnostics/duplicateAssets.ts, which hands this module the
 * (name, path, hash) triples once the bytes have already been read - the
 * same split as ./crashlist.ts and ./upstream.ts.
 */

import { isDisabledFolderName } from './loadOrder'

/**
 * A path the walk reaches but Mod Loader never loads from.
 *
 * Two features that were reviewed apart meet here, and both of them put real
 * files under `modloader\` that the game will never see:
 *
 *  - DISABLING A MOD IS A FOLDER RENAME. Mod Loader skips any folder whose
 *    name starts with ". " and that is exactly what the enable/disable toggle
 *    writes - not one byte is moved, which is the whole point. So a mod the
 *    user switched OFF is still on disk, still walked, and still hashed.
 *  - AN UNCHOSEN VARIANT OPTION IS KEPT. Every option of a variant group is
 *    snapshotted into a hidden `.variants\` folder so a later switch never
 *    needs the archive again. It is content the user did not pick.
 *
 * Feeding either to the duplicate-.asi or stacked-adjuster scan turns a
 * deliberate, non-destructive "not this one" into a FAIL - and every fail on
 * this branch is a launch blocker. The user would be refused a launch over the
 * copy they turned off, with no way to act on it short of deleting the thing
 * the disable existed to preserve.
 *
 * Any component of the path decides it, not just the leaf: the disabled folder
 * is an ancestor of everything inside it. A loose file disabled by having its
 * extension taken away (`x.asi.disabled`) never reaches here at all - it stops
 * matching the plugin-binary extension, which is the same idea by other means.
 */
export function isInertScanPath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .some((part) => isDisabledFolderName(part) || part.toLowerCase() === VARIANT_SNAPSHOT_DIR)
}

/** The hidden store folder every unchosen variant option is kept in. */
const VARIANT_SNAPSHOT_DIR = '.variants'

export interface HashedAsset {
  /** Base file name, e.g. "III.VC.SA.LimitAdjuster.asi". */
  name: string
  /** Path as shown to the user - game-relative, so it reads the same on any machine. */
  path: string
  /** sha256 of the file's bytes. */
  hash: string
}

export interface DuplicateAssetGroup {
  fileName: string
  hash: string
  /** Every distinct path the same bytes were found at, two or more. */
  paths: string[]
}

/**
 * Groups by lower-cased file name + hash. A group is only reported when it
 * has two or more DISTINCT paths - the same path counted twice (e.g. because
 * two scan roots overlap) is not a duplicate of anything.
 */
export function groupDuplicateAssets(files: HashedAsset[]): DuplicateAssetGroup[] {
  const byKey = new Map<string, DuplicateAssetGroup>()
  for (const f of files) {
    const key = `${f.name.toLowerCase()}::${f.hash}`
    let group = byKey.get(key)
    if (!group) {
      group = { fileName: f.name, hash: f.hash, paths: [] }
      byKey.set(key, group)
    }
    if (!group.paths.includes(f.path)) group.paths.push(f.path)
  }
  return [...byKey.values()].filter((g) => g.paths.length > 1).sort((a, b) => a.fileName.localeCompare(b.fileName))
}
