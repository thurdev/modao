/**
 * Load order, and the two folder-name prefixes Mod Loader itself reads.
 *
 * LOAD ORDER IS NOT PRIORITY. They are two different mechanisms that people
 * confuse constantly, and the app has to keep them apart in code as well as in
 * what it says:
 *
 *  - PRIORITY (1-100, default 50, 0 = the folder is not loaded, higher wins)
 *    decides WHO WINS A DUPLICATED FILE. It is written per folder into
 *    modloader.ini and it has no effect whatsoever on the order .asi plugins
 *    are loaded in.
 *  - LOAD ORDER is ALPHABETICAL, by the mod folder's own name, and decides
 *    WHICH .asi HOOKS THE GAME FIRST. The only lever on it is the folder name:
 *    "$" sorts before every letter and digit, so a folder called "$VHud" loads
 *    before "Arma", and a readme that says "this must load first" is asking for
 *    that prefix - never for a priority number.
 *
 * And one more spelling Mod Loader reads: a folder whose name starts with
 * ". " (DOT SPACE) is skipped entirely. That is Mod Loader's own documented
 * non-destructive disable, and it is what this app uses for its enable/disable
 * toggle. Disabling a mod renames a folder. It does not remove one file.
 *
 * Pure on purpose - no fs, no electron - so the unit suite can exercise it.
 */

/** Mod Loader skips any mod folder whose name starts with this. */
export const DISABLED_PREFIX = '. '

/** Sorts before every letter and digit, so the folder's .asi hooks first. */
export const LOAD_FIRST_PREFIX = '$'

/**
 * What a disabled LOOSE file is called. Mod Loader's ". " prefix is a folder
 * mechanism; a plugin sitting directly in the ASI directory or in cleo\ is
 * found by extension, so taking the extension away is the same idea - the
 * loader stops seeing it and every byte stays on disk.
 */
export const DISABLED_FILE_SUFFIX = '.disabled'

export interface FolderNameState {
  /** The name with every Modão/Mod Loader prefix taken off. */
  base: string
  /** Mod Loader will not read this folder. */
  disabled: boolean
  /** The folder is spelled so its .asi loads before the others. */
  loadFirst: boolean
}

export function isDisabledFolderName(name: string): boolean {
  return name.startsWith(DISABLED_PREFIX)
}

export function isLoadFirstFolderName(name: string): boolean {
  return name.startsWith(LOAD_FIRST_PREFIX)
}

/**
 * Reads a folder name the way Mod Loader does, prefixes and all.
 *
 * Both prefixes can be present at once - ". $VHud" is a load-first mod that is
 * currently switched off - and a user who typed them by hand is understood
 * exactly like a folder Modão spelled itself. That is the whole point of
 * recognising the prefix on read rather than only writing it.
 */
export function folderNameState(name: string): FolderNameState {
  let rest = name
  let disabled = false
  let loadFirst = false
  // A prefix may be repeated by hand (". . Foo"); each pass takes one off.
  for (let i = 0; i < 8; i++) {
    if (rest.startsWith(DISABLED_PREFIX)) {
      disabled = true
      rest = rest.slice(DISABLED_PREFIX.length)
      continue
    }
    if (rest.startsWith(LOAD_FIRST_PREFIX)) {
      loadFirst = true
      rest = rest.slice(LOAD_FIRST_PREFIX.length)
      continue
    }
    break
  }
  // A name that is nothing but prefixes is not a mod folder; keep it whole
  // rather than inventing an empty one.
  return rest ? { base: rest, disabled, loadFirst } : { base: name, disabled: false, loadFirst: false }
}

/** The folder name with Mod Loader's prefixes taken off. */
export function baseFolderName(name: string): string {
  return folderNameState(name).base
}

/** How a mod folder in this state has to be spelled on disk. */
export function spellFolderName(base: string, state: { enabled: boolean; loadFirst: boolean }): string {
  const core = `${state.loadFirst ? LOAD_FIRST_PREFIX : ''}${baseFolderName(base)}`
  return state.enabled ? core : `${DISABLED_PREFIX}${core}`
}

/** Every spelling of one mod folder that could legitimately be on disk. */
export function folderSpellings(base: string): string[] {
  const core = baseFolderName(base)
  return [
    core,
    `${LOAD_FIRST_PREFIX}${core}`,
    `${DISABLED_PREFIX}${core}`,
    `${DISABLED_PREFIX}${LOAD_FIRST_PREFIX}${core}`
  ]
}

export function isDisabledFileName(name: string): boolean {
  return name.toLowerCase().endsWith(DISABLED_FILE_SUFFIX)
}

export function baseFileName(name: string): string {
  return isDisabledFileName(name) ? name.slice(0, name.length - DISABLED_FILE_SUFFIX.length) : name
}

/**
 * A game-relative path in the ONE spelling the records use.
 *
 * `install_file` rows, `provides` rows and every ownership comparison are
 * written against the canonical name; the prefixes live on disk only. So
 * anything that reads a path off the filesystem - an adopt, a scan, a health
 * check - runs it through here first and a hand-disabled mod is recognised as
 * the mod it is instead of as a second mod called ". Foo".
 */
export function canonicalGameRelative(relativePath: string): string {
  const parts = relativePath.replace(/\\/g, '/').split('/')
  if (parts.length === 0) return relativePath
  if (parts[0].toLowerCase() === 'modloader') {
    // modloader/<mod>/... and modloader/<mod>/<sub-mod>/..., both of which Mod
    // Loader reads as folders and both of which can carry the prefix.
    if (parts.length > 1) parts[1] = baseFolderName(parts[1])
    if (parts.length > 2) parts[2] = baseFolderName(parts[2])
  }
  parts[parts.length - 1] = baseFileName(parts[parts.length - 1])
  return parts.join('/')
}

// ---------------------------------------------------------------------------
// Load order
// ---------------------------------------------------------------------------

/**
 * Mod Loader's own ordering: a plain case-insensitive ordinal comparison of the
 * folder names, which is why "$" (0x24, below every digit and letter) is the
 * prefix that loads first.
 *
 * Deliberately NOT localeCompare: ICU collation ignores leading punctuation, so
 * "$VHud" and "VHud" compare equal there and the one lever the user has over
 * load order would vanish.
 */
export function compareLoadOrder(a: string, b: string): number {
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x < y ? -1 : x > y ? 1 : 0
}

export interface LoadOrderInput {
  /** The canonical folder name, without prefixes. */
  folder: string
  enabled: boolean
  loadFirst: boolean
  /** Carried through untouched. Load order never reads it - that is the point. */
  priority: number
}

export interface LoadOrderEntry extends LoadOrderInput {
  /** The name as it is spelled in modloader\. */
  spelled: string
  /** 1-based position in Mod Loader's load order, or null when it is not loaded. */
  rank: number | null
}

/**
 * The profile's .asi load order.
 *
 * Priority is carried on every entry and read by nothing here. Two profiles
 * with the same folder names load in the same order whatever their priorities
 * are - that IS the rule this function exists to state, and the test that
 * swaps every priority and expects the same ranks is what holds it.
 *
 * A folder Mod Loader will not read - disabled by the ". " prefix, or set to
 * priority 0 - has no rank, because it is not in the load order at all.
 */
export function loadOrderOf(inputs: readonly LoadOrderInput[]): LoadOrderEntry[] {
  const entries = inputs.map((i) => ({
    ...i,
    folder: baseFolderName(i.folder),
    spelled: spellFolderName(i.folder, i),
    rank: null as number | null
  }))
  const loaded = entries
    .filter((e) => e.enabled && e.priority > 0)
    .sort((a, b) => compareLoadOrder(a.spelled, b.spelled))
  loaded.forEach((e, i) => {
    e.rank = i + 1
  })
  return entries.sort((a, b) => {
    if (a.rank !== null && b.rank !== null) return a.rank - b.rank
    if (a.rank !== null) return -1
    if (b.rank !== null) return 1
    return compareLoadOrder(a.spelled, b.spelled)
  })
}

// ---------------------------------------------------------------------------
// Early-hooking plugins: the ones that belong in the ASI directory
// ---------------------------------------------------------------------------

export type EarlyHookRole = 'input' | 'loader' | 'limit-adjuster' | 'patch'

export interface EarlyHookSeed {
  pattern: RegExp
  role: EarlyHookRole
  /**
   * The plugin ships NOTHING of its own, so it can be placed in the ASI
   * directory without separating it from files it needs. Only a `bare` plugin
   * is ever moved; an early hooker that carries data (GInput's pad textures,
   * VHud's ~250 files) stays with its files and gets advice instead. Lifting
   * one of those out is the exact mistake `@shared/asiData` exists to undo.
   */
  bare: boolean
  why: string
}

/**
 * The seed list. A learned rule grows it - see `matchEarlyHook`'s `learned`
 * argument, which `src/main/knowledge` fills from the rules written when a
 * person moves a plugin by hand.
 *
 * Every entry that was in `classify.ts`'s BARE_ASI_LOADERS is here with
 * `bare: true` and the same pattern; nothing about that decision changed.
 */
export const EARLY_HOOK_SEEDS: readonly EarlyHookSeed[] = [
  { pattern: /^modloader\.asi$/i, role: 'loader', bare: true, why: 'Mod Loader itself' },
  { pattern: /^cleo\.asi$/i, role: 'loader', bare: true, why: 'the CLEO runtime' },
  { pattern: /^ultimateasiloader/i, role: 'loader', bare: true, why: 'an .asi loader' },
  { pattern: /^asiloader/i, role: 'loader', bare: true, why: 'an .asi loader' },
  { pattern: /^silentpatch/i, role: 'patch', bare: true, why: 'patches the executable before anything else runs' },
  { pattern: /^.*limitadjuster.*$/i, role: 'limit-adjuster', bare: true, why: 'raises engine limits at startup' },
  { pattern: /^iii\.vc\.sa\./i, role: 'limit-adjuster', bare: true, why: 'raises engine limits at startup' },
  { pattern: /^widescreenfix/i, role: 'patch', bare: true, why: 'patches the renderer before the game starts' },
  { pattern: /^gtasa?\.?fusionfix/i, role: 'patch', bare: true, why: 'patches the renderer before the game starts' },
  { pattern: /^(sa)?memoryfix/i, role: 'patch', bare: true, why: 'patches allocations before the game starts' },
  // Early hookers that DO ship files. Advice only - never moved.
  { pattern: /^ginput/i, role: 'input', bare: false, why: 'hooks the pad before the game reads input' },
  { pattern: /^project2dfx/i, role: 'patch', bare: false, why: 'hooks the draw distance code at startup' },
  { pattern: /^skygfx/i, role: 'patch', bare: false, why: 'hooks the renderer at startup' }
]

/** A rule the knowledge store learned, in the shape `matchEarlyHook` reads. */
export interface LearnedEarlyHook {
  /** The plugin file name, as it was seen. */
  plugin: string
  role: EarlyHookRole
  bare: boolean
}

export interface EarlyHookMatch {
  role: EarlyHookRole
  bare: boolean
  why: string
  source: 'seed' | 'learned'
}

/**
 * Is this .asi an early hooker, and may it be moved to the ASI directory?
 *
 * `learned` is the growth path: the seed list is a starting point, not a closed
 * set, and a rule written from a person's own correction outranks it.
 */
export function matchEarlyHook(fileName: string, learned: readonly LearnedEarlyHook[] = []): EarlyHookMatch | null {
  const name = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName
  for (const l of learned) {
    if (l.plugin.toLowerCase() === name.toLowerCase()) {
      return { role: l.role, bare: l.bare, why: 'a plugin you placed there yourself', source: 'learned' }
    }
  }
  for (const s of EARLY_HOOK_SEEDS) {
    if (s.pattern.test(name)) return { role: s.role, bare: s.bare, why: s.why, source: 'seed' }
  }
  return null
}

/** True only for an early hooker that ships nothing of its own. */
export function belongsInAsiDirectory(fileName: string, learned: readonly LearnedEarlyHook[] = []): boolean {
  return matchEarlyHook(fileName, learned)?.bare === true
}
