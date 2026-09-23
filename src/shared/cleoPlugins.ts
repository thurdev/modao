/**
 * What each installed .cleo plugin needs from CLEO itself.
 *
 * The field report's fatal dialog - "The ordinal 22 could not be located in the
 * dynamic link library CLEO+.cleo" - is what a plugin built against a newer
 * CLEO does when it is loaded by an older one. The app used to know exactly one
 * rule, hardcoded: CLEO+ needs 4.4. That covers one plugin and no other, so the
 * next plugin with a floor of its own is invisible until it crashes.
 *
 * So the requirement is data, not code: every .cleo file in the profile is
 * matched against the version range its own mod declares (the `dependency` rows
 * the catalogue and the readme parser write), and a plugin that ships a
 * requirement nobody catalogued still lands on the short KNOWN table below. A
 * future plugin declaring ">= 5.0" is gated with no code change at all.
 */

import { satisfiesRange } from './versionRange'

/** One installed plugin, with whatever its mod says about CLEO. */
export interface InstalledCleoPlugin {
  /** Path as installed, e.g. "CLEO/CLEO+.cleo". */
  path: string
  /** Ranges declared against CLEO by this plugin's mod, e.g. [">=4.4"]. */
  declaredRanges?: readonly (string | null | undefined)[]
}

export interface CleoPluginVerdict {
  path: string
  /** The file name as it sits in cleo\. */
  name: string
  /** The range the plugin requires, e.g. ">=4.4". */
  range: string
  /** `declared` came from the plugin's own mod metadata; `known` from the table below. */
  source: 'declared' | 'known'
  /** null when CLEO is installed but its version could not be read. */
  satisfied: boolean | null
}

/**
 * Requirements that are field knowledge rather than catalogue data. Only a
 * plugin whose mod declares nothing falls back to this, and the list stays
 * short on purpose - anything else belongs in the dependency table, where
 * adding a plugin costs a row instead of a release.
 */
export const KNOWN_CLEO_REQUIREMENTS: readonly { match: RegExp; range: string }[] = [
  // CLEO+ against CLEO 4.3 throws the ordinal-22 dialog before the menu appears.
  { match: /^cleo\+?$|^cleo[_ -]?plus$/i, range: '>=4.4' }
]

/** Only real plugins: cleo\ also holds .ini, .fxt and saved .cs scripts. */
export function isCleoPlugin(relativePath: string): boolean {
  return /\.cleo$/i.test(relativePath ?? '')
}

/** File name with the .cleo extension removed, for matching and for display. */
export function cleoPluginName(relativePath: string): string {
  const base = (relativePath ?? '').split(/[\/]/).pop() ?? ''
  return base.replace(/\.cleo$/i, '')
}

function knownRangeFor(name: string): string | null {
  for (const rule of KNOWN_CLEO_REQUIREMENTS) if (rule.match.test(name)) return rule.range
  return null
}

/**
 * One verdict per plugin that states a requirement. Plugins that ask for
 * nothing are left out rather than reported as satisfied - there is nothing to
 * satisfy, and listing them would bury the one that matters.
 */
export function cleoPluginRequirements(
  plugins: readonly InstalledCleoPlugin[],
  installedCleoVersion: string | null
): CleoPluginVerdict[] {
  const out: CleoPluginVerdict[] = []
  const seen = new Set<string>()

  for (const plugin of plugins) {
    if (!isCleoPlugin(plugin.path)) continue
    const name = cleoPluginName(plugin.path)
    const key = name.toLowerCase()
    if (seen.has(key)) continue

    const declared = (plugin.declaredRanges ?? []).find((r) => typeof r === 'string' && r.trim() !== '')
    const range = declared ? declared.trim() : knownRangeFor(name)
    if (!range) continue

    seen.add(key)
    out.push({
      path: plugin.path,
      name,
      range,
      source: declared ? 'declared' : 'known',
      // An unreadable CLEO version is "unknown", never "fine": the whole point
      // of this check is that the failure it prevents is a fatal dialog.
      satisfied: installedCleoVersion ? satisfiesRange(installedCleoVersion, range) : null
    })
  }
  return out
}

/**
 * The health status for a set of verdicts. A plugin whose floor is above the
 * installed CLEO fails - that is the launch-blocking case; a requirement that
 * cannot be evaluated warns.
 */
export function cleoRequirementStatus(verdicts: readonly CleoPluginVerdict[]): 'pass' | 'warn' | 'fail' {
  if (verdicts.some((v) => v.satisfied === false)) return 'fail'
  if (verdicts.some((v) => v.satisfied === null)) return 'warn'
  return 'pass'
}
