/**
 * An .ini in the ASI directory with no .asi beside it.
 *
 * Harmless to the game and a trap for whoever is diagnosing it: the file reads
 * as evidence that a plugin is installed when it is not. The field report's
 * install had accumulated SilentPatchSA.ini, MixSets.ini, SALodLights.ini/.dat,
 * ped_spec.ini, GInputSA.ini and FramerateVigilante.ini that way.
 *
 * Detecting it is half the answer. The other half is WHERE THE PLUGIN WENT: an
 * orphaned GInputSA.ini almost always means GInputSA.asi was moved into
 * modloader\GInputSA\, which is exactly the mistake item 12 is about - an
 * early-hooking plugin belongs in the ASI directory. So the finding names the
 * .asi and the folder it is sitting in, and the app can offer to move it back.
 *
 * Pure: the caller hands in a directory listing and the profile's recorded
 * paths, so the unit suite can exercise every branch with no filesystem.
 */

/** Configs the game or Mod Loader itself owns; their "plugin" is not an .asi. */
const SHARED_STEMS = new Set(['stream', 'modloader', 'cleo', 'gta_sa', 'settings'])

const PLUGIN_EXT = /\.(asi|dll)$/i
const CONFIG_EXT = /\.(ini|json|cfg|dat)$/i

export type OrphanAction =
  /** The plugin is on record somewhere else; offer to bring it back. */
  | 'move-back'
  /** Nothing in this profile ships a plugin by that name. */
  | 'no-plugin'

/**
 * An install whose records put the plugin exactly where the finding says it is.
 *
 * A move-back rewrites rows, and rows belong to installs, not to paths. The
 * same mod installed in two profiles has two sets of rows carrying the SAME
 * relative_path, so "update every row with this path" silently rewrites the
 * other profile's copy to a layout its own store has no file at. The finding
 * therefore carries who it is allowed to touch, and the caller scopes its
 * UPDATE to exactly that.
 */
export interface OrphanOwner {
  installId: number
  profileId: number
}

export interface OrphanFinding {
  /** The config's file name, as it sits in the ASI directory. */
  config: string
  /** Its stem, which is the plugin's name minus the extension. */
  stem: string
  /** The plugin file this config belongs with, when the records name one. */
  plugin: string | null
  /** Where that plugin is now, game-relative, when the records name one. */
  pluginPath: string | null
  /**
   * Every install whose rows claim `pluginPath` - the only rows a move-back may
   * rewrite. Empty when no plugin was found (`action === 'no-plugin'`).
   */
  owners: OrphanOwner[]
  action: OrphanAction
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]*$/, '').toLowerCase()
}

/** The directory a game-relative path sits in, "" for the game root. */
function dirOf(relativePath: string): string {
  const p = relativePath.replace(/\\/g, '/')
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i).toLowerCase()
}

/** One recorded file, with the install and profile whose row records it. */
export interface TrackedFile {
  /** The game-relative path the row claims. */
  relativePath: string
  /** The install whose row claims it. */
  installId: number
  /** The profile that install belongs to. */
  profileId: number
}

export interface OrphanInput {
  /** File names directly inside the detected ASI directory. */
  entries: readonly string[]
  /** Where the ASI directory is, relative to the game folder ("scripts", or "" at the root). */
  asiRelative: string
  /** Every recorded file in scope, each carrying the install and profile that owns it. */
  tracked: readonly TrackedFile[]
}

/**
 * The orphans, each with the plugin it belongs with when one can be found.
 *
 * A plugin that is ALREADY in the ASI directory is never an orphan's answer -
 * then the config is not orphaned in the first place. The search is for a
 * plugin of the same stem recorded anywhere else, which is how
 * "GInputSA.ini has no plugin" becomes "GInputSA.asi is in modloader/GInputSA".
 */
export function findOrphanConfigs(input: OrphanInput): OrphanFinding[] {
  const asiDir = input.asiRelative.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase()
  const present = new Set(input.entries.filter((f) => PLUGIN_EXT.test(f)).map(stemOf))

  // First path recorded for a stem wins, and every install that records THAT
  // path is an owner. An install recording the same stem at a different path
  // describes a different file, which this move does not touch, so it is not an
  // owner and its rows stay as they are.
  const elsewhere = new Map<string, { path: string; owners: OrphanOwner[] }>()
  for (const row of input.tracked) {
    const p = row.relativePath.replace(/\\/g, '/')
    const name = p.split('/').pop() ?? p
    if (!PLUGIN_EXT.test(name)) continue
    if (dirOf(p) === asiDir) continue
    const stem = stemOf(name)
    const hit = elsewhere.get(stem)
    if (!hit) {
      elsewhere.set(stem, { path: p, owners: [{ installId: row.installId, profileId: row.profileId }] })
    } else if (hit.path === p && !hit.owners.some((o) => o.installId === row.installId)) {
      hit.owners.push({ installId: row.installId, profileId: row.profileId })
    }
  }

  const out: OrphanFinding[] = []
  for (const name of input.entries) {
    if (!CONFIG_EXT.test(name)) continue
    const stem = stemOf(name)
    if (SHARED_STEMS.has(stem)) continue
    if (present.has(stem)) continue
    const hit = elsewhere.get(stem) ?? null
    out.push({
      config: name,
      stem,
      plugin: hit ? (hit.path.split('/').pop() ?? null) : null,
      pluginPath: hit ? hit.path : null,
      owners: hit ? hit.owners.slice() : [],
      action: hit ? 'move-back' : 'no-plugin'
    })
  }
  return out
}

/**
 * The profiles whose records put this finding's plugin where it is.
 *
 * More than one means the same mod is installed in several profiles, and the
 * one file on disk cannot be attributed to any of them: a move-back then has no
 * safe scope and must refuse rather than guess.
 */
export function orphanOwningProfiles(f: OrphanFinding): number[] {
  return [...new Set(f.owners.map((o) => o.profileId))]
}

/** The folder a finding's plugin is sitting in, spelled the way Windows does. */
export function orphanPluginFolder(f: OrphanFinding): string {
  if (!f.pluginPath) return ''
  return f.pluginPath.replace(/\//g, '\\').replace(/\\[^\\]*$/, '')
}
