/**
 * Where an .asi's sidecar data has to sit, decided by the plugin's own strings.
 *
 * GTA San Andreas runs with its working directory set to the GAME ROOT, and Mod
 * Loader never changes it. So when a plugin's binary carries the literal
 * "VHud\data\blips.dat" or "models\x360btns.txd", that is a path resolved from
 * the game folder - not from wherever the .asi happens to have been copied.
 *
 * VHud is the case this was written for: the .asi went to scripts\ while
 * blips\, map\, data\ and fonts\ stayed in modloader\VHud\, Mod Loader printed
 * "No handler or callme" for ~250 files, and the HUD never appeared. GInput is
 * the same shape with a vanilla folder name: its strings name
 * models\x360btns.txd, models\ps3btns.txd, models\sixaxis.txd and
 * models\pcbtns.txd, and without them at <game root>\models\ it prints
 * "GInput could not load pad button textures... The game will now close."
 *
 * Nothing here touches the .asi itself. A plugin is never lifted away from the
 * files it ships with, and the data is never dragged next to a separated .asi -
 * both of those are the mistake this module exists to undo.
 *
 * Pure on purpose: no fs, no electron, so the unit suite can exercise it.
 */

export interface DataPlacement {
  /** Path inside the mod folder the classifier would otherwise have used. */
  bundlePath: string
  /** Game-root-relative path the plugin actually opens. */
  rootTarget: string
  /** The literal string inside the binary that decided it. */
  reason: string
}

/** A trailing "%s", "*" or "?" means the plugin enumerates a directory. */
const WILDCARD = /[%*?]/
/** A last segment that looks like a file name rather than a folder. */
const FILE_EXT = /\.[A-Za-z0-9_]{1,6}$/

function normalise(p: string): string {
  return p
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
}

interface Reference {
  /** Lower-cased full path, when the string names one file. */
  file: string | null
  /** Lower-cased directory, when the string names a folder or enumerates one. */
  dir: string | null
  /** The string as the binary spells it, for the warning that explains this. */
  raw: string
}

/**
 * Reads the plugin's path strings into the two things worth matching against:
 * a file it opens by name, or a directory it reads out of.
 */
function references(binaryPaths: string[]): Reference[] {
  const out: Reference[] = []
  for (const raw of binaryPaths) {
    const slashed = raw.replace(/\\/g, '/')
    if (!slashed.includes('/')) continue
    // A drive letter or an absolute path says nothing about this install.
    if (/^[A-Za-z]:/.test(slashed) || slashed.startsWith('/')) continue
    const norm = normalise(slashed)
    if (!norm) continue
    const segments = norm.split('/')
    const last = segments[segments.length - 1]
    if (WILDCARD.test(last)) {
      const dir = segments.slice(0, -1).join('/')
      if (dir) out.push({ file: null, dir, raw })
      continue
    }
    if (FILE_EXT.test(last)) {
      out.push({ file: norm, dir: null, raw })
      continue
    }
    out.push({ file: null, dir: norm, raw })
  }
  return out
}

/**
 * Which of a mod folder's files the plugin opens from the game root instead.
 *
 * `bundleFiles` are paths relative to `modloader/<bundleName>/`. A plugin names
 * its data either the way the mod folder is laid out ("models\x360btns.txd",
 * GInput) or with its own folder in front ("VHud\data\blips.dat", VHud), so
 * both readings are tried - and whichever one the binary agrees with IS the
 * game-root-relative path, because that is the string the plugin passes to the
 * game's file APIs.
 */
export function gameRootPlacements(
  binaryPaths: string[],
  bundleName: string,
  bundleFiles: string[]
): DataPlacement[] {
  const refs = references(binaryPaths)
  if (refs.length === 0) return []

  const out: DataPlacement[] = []
  for (const rel of bundleFiles) {
    const candidates = bundleName ? [rel, `${bundleName}/${rel}`] : [rel]
    let placed: DataPlacement | null = null
    for (const candidate of candidates) {
      const c = normalise(candidate)
      if (!c) continue
      for (const ref of refs) {
        const hit =
          (ref.file !== null && ref.file === c) ||
          (ref.dir !== null && (c === ref.dir || c.startsWith(`${ref.dir}/`)))
        if (!hit) continue
        placed = { bundlePath: rel, rootTarget: candidate, reason: ref.raw }
        break
      }
      if (placed) break
    }
    if (placed) out.push(placed)
  }
  return out
}
