/**
 * What counts as having a requirement.
 *
 * A pack satisfies its own contents. The Essentials pack ships SilentPatch, a
 * limit adjuster, the Widescreen Fix and CLEO, so a mod that asks for any of
 * them is already answered by having the pack installed - the app asking for
 * them again sends the user hunting for mods they already have.
 *
 * Some requirements are a capability rather than a mod: "Open Limit Adjuster"
 * is one of three adjusters that do the job, and any ASI loader loads .asi
 * files. Those are matched as a group.
 */

/** A requirement, and every file or mod name that answers it. */
export interface Capability {
  id: string
  /** Names a readme might use for this requirement. */
  asked: RegExp
  /** File names, mod titles or folder names that provide it. */
  providedBy: RegExp
}

export const CAPABILITIES: Capability[] = [
  {
    id: 'limit-adjuster',
    asked: /(open ?limit ?adjuster|limit ?adjuster|fastman92)/i,
    providedBy: /(openlimitadjuster|open ?limit ?adjuster|fastman92|iii\.vc\.sa\.limitadjuster|limitadjuster)/i
  },
  {
    id: 'asi-loader',
    asked: /(asi ?loader|ultimate ?asi ?loader|silent'?s? ?asi ?loader)/i,
    providedBy: /(vorbisfile|vorbishooked|dinput8|dsound|ultimateasiloader|silent.*asi.*loader|asiloader)/i
  },
  {
    id: 'silentpatch',
    asked: /silent ?patch/i,
    providedBy: /(silentpatch)/i
  },
  {
    id: 'widescreen-fix',
    asked: /(widescreen ?fix)/i,
    providedBy: /(widescreenfix|gtasa\.widescreenfix)/i
  },
  {
    id: 'cleo-plus',
    asked: /cleo ?\+/i,
    providedBy: /(cleo\+|cleoplus)/i
  },
  {
    id: 'cleo',
    // CLEO+ is a different requirement, so it must not match here.
    asked: /^cleo( ?4(\.\d)?)?$/i,
    providedBy: /(cleo\.asi|cleo ?4|cleolibrary)/i
  },
  {
    id: 'mod-loader',
    asked: /(mod ?loader)/i,
    providedBy: /(modloader\.asi|mod ?loader)/i
  }
]

/** Everything a name could be spelled as, flattened for comparison. */
export function flattenName(value: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9+]/g, '')
}

/**
 * Is `requirement` answered by anything in `haves`?
 *
 * `haves` is every signal available: file paths installed in the profile, mod
 * titles, folder names, loose plugins in the ASI directory.
 */
export function requirementMet(requirement: string, haves: string[]): boolean {
  const needle = flattenName(requirement)
  if (!needle) return true

  const capability = CAPABILITIES.find((c) => c.asked.test(requirement))
  for (const have of haves) {
    if (flattenName(have).includes(needle)) return true
    if (capability?.providedBy.test(have)) return true
  }
  return false
}
