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

export interface OrphanFinding {
  /** The config's file name, as it sits in the ASI directory. */
  config: string
  /** Its stem, which is the plugin's name minus the extension. */
  stem: string
  /** The plugin file this config belongs with, when the records name one. */
  plugin: string | null
  /** Where that plugin is now, game-relative, when the records name one. */
  pluginPath: string | null
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

export interface OrphanInput {
  /** File names directly inside the detected ASI directory. */
  entries: readonly string[]
  /** Where the ASI directory is, relative to the game folder ("scripts", or "" at the root). */
  asiRelative: string
  /** Every game-relative path this profile's installs claim. */
  tracked: readonly string[]
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

  const elsewhere = new Map<string, string>()
  for (const rel of input.tracked) {
    const p = rel.replace(/\\/g, '/')
    const name = p.split('/').pop() ?? p
    if (!PLUGIN_EXT.test(name)) continue
    if (dirOf(p) === asiDir) continue
    const stem = stemOf(name)
    if (!elsewhere.has(stem)) elsewhere.set(stem, p)
  }

  const out: OrphanFinding[] = []
  for (const name of input.entries) {
    if (!CONFIG_EXT.test(name)) continue
    const stem = stemOf(name)
    if (SHARED_STEMS.has(stem)) continue
    if (present.has(stem)) continue
    const pluginPath = elsewhere.get(stem) ?? null
    out.push({
      config: name,
      stem,
      plugin: pluginPath ? (pluginPath.split('/').pop() ?? null) : null,
      pluginPath,
      action: pluginPath ? 'move-back' : 'no-plugin'
    })
  }
  return out
}

/** The folder a finding's plugin is sitting in, spelled the way Windows does. */
export function orphanPluginFolder(f: OrphanFinding): string {
  if (!f.pluginPath) return ''
  return f.pluginPath.replace(/\//g, '\\').replace(/\\[^\\]*$/, '')
}
