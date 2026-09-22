/**
 * The games Modão manages, and what is actually different about each of them.
 *
 * The three classic titles share one modding stack: an ASI loader, Mod Loader,
 * CLEO, and a save folder in Documents. The Definitive Edition shares none of
 * it - it is Unreal Engine, its mods are .pak files dropped in a folder, and it
 * has no Mod Loader, no priorities and no CrashList. Every place in the app that
 * would otherwise assume San Andreas asks this table instead.
 */
export type GameKind = 'sa' | 'iii' | 'vc' | 'sade'

export interface GameDefinition {
  kind: GameKind
  /** Full name, as the user would say it. */
  name: string
  /** Two or three letters, for chips and filters. */
  shortName: string
  /** The executables that identify the install, in the order to look for them. */
  exeNames: string[]
  /** The folder in Documents that holds its saves. */
  userFilesDir: string
  /** Save slot files inside that folder. */
  saveSlotPattern: RegExp
  /** Mod Loader (modloader.asi) supports this game. */
  supportsModLoader: boolean
  /** CLEO scripts (.cs/.cm) and CLEO plugins (.cleo) apply. */
  supportsCleo: boolean
  /** ASI plugins load at all. */
  supportsAsi: boolean
  /** Where Definitive Edition mods go, relative to the install root. */
  pakDir: string | null
  /** CrashList.txt indexes addresses for this executable. */
  hasCrashList: boolean
  /** Where installs of this game are usually found. */
  commonRoots: string[]
  /** How MixMods marks a post for this game, in titles and category names. */
  titleTags: string[]
  categoryHints: string[]
}

export const GAMES: Record<GameKind, GameDefinition> = {
  sa: {
    kind: 'sa',
    name: 'GTA: San Andreas',
    shortName: 'SA',
    exeNames: ['gta_sa.exe'],
    userFilesDir: 'GTA San Andreas User Files',
    saveSlotPattern: /^GTASAsf\d\.b$/i,
    supportsModLoader: true,
    supportsCleo: true,
    supportsAsi: true,
    pakDir: null,
    hasCrashList: true,
    commonRoots: [
      'C:\\Program Files (x86)\\Rockstar Games\\GTA San Andreas',
      'C:\\Program Files\\Rockstar Games\\GTA San Andreas',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto San Andreas',
      'C:\\Program Files (x86)\\Rockstar Games\\Launcher\\Grand Theft Auto San Andreas',
      'C:\\Games\\GTA San Andreas',
      'C:\\GTA San Andreas',
      'D:\\Games\\GTA San Andreas',
      'D:\\GTA San Andreas'
    ],
    titleTags: ['SA', 'GTA SA', 'SanAndreas', 'San Andreas'],
    categoryHints: ['gta-sa', 'gta sa', 'san andreas']
  },
  iii: {
    kind: 'iii',
    name: 'GTA III',
    shortName: 'III',
    exeNames: ['gta3.exe'],
    userFilesDir: 'GTA3 User Files',
    saveSlotPattern: /^GTA3sf\d\.b$/i,
    supportsModLoader: true,
    supportsCleo: true,
    supportsAsi: true,
    pakDir: null,
    hasCrashList: false,
    commonRoots: [
      'C:\\Program Files (x86)\\Rockstar Games\\GTAIII',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto 3',
      'C:\\Games\\GTA III',
      'D:\\Games\\GTA III'
    ],
    titleTags: ['III', 'GTA III', 'GTA3'],
    categoryHints: ['gta-iii', 'gta iii', 'iii –', 'iii -']
  },
  vc: {
    kind: 'vc',
    name: 'GTA: Vice City',
    shortName: 'VC',
    exeNames: ['gta-vc.exe', 'gta_vc.exe'],
    userFilesDir: 'GTA Vice City User Files',
    saveSlotPattern: /^GTAVCsf\d\.b$/i,
    supportsModLoader: true,
    supportsCleo: true,
    supportsAsi: true,
    pakDir: null,
    hasCrashList: false,
    commonRoots: [
      'C:\\Program Files (x86)\\Rockstar Games\\Grand Theft Auto Vice City',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Grand Theft Auto Vice City',
      'C:\\Games\\GTA Vice City',
      'D:\\Games\\GTA Vice City'
    ],
    titleTags: ['VC', 'GTA VC', 'Vice City'],
    categoryHints: ['gta-vc', 'gta vc', 'vice city', 'vc –', 'vc -']
  },
  sade: {
    kind: 'sade',
    name: 'GTA: San Andreas — Definitive Edition',
    shortName: 'SA:DE',
    // The launcher exe sits at the root; the game itself is under Gameface\.
    exeNames: ['Gameface\\Binaries\\Win64\\SanAndreas.exe', 'PlayGTASA.exe'],
    userFilesDir: 'Rockstar Games\\GTA San Andreas Definitive Edition',
    saveSlotPattern: /\.sav$/i,
    supportsModLoader: false,
    supportsCleo: false,
    supportsAsi: false,
    pakDir: 'Gameface\\Content\\Paks\\~mods',
    hasCrashList: false,
    commonRoots: [
      'C:\\Program Files\\Rockstar Games\\GTA San Andreas Definitive Edition',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\GTA San Andreas - Definitive',
      'D:\\Games\\GTA San Andreas Definitive Edition'
    ],
    titleTags: ['SA:DE', 'SADE', 'DE', 'Definitive'],
    categoryHints: ['gta-sa-de', 'sa:de', 'definitive']
  }
}

export const GAME_ORDER: GameKind[] = ['sa', 'sade', 'iii', 'vc']

export function gameDefinition(kind: GameKind | string | null | undefined): GameDefinition {
  const def = GAMES[(kind ?? 'sa') as GameKind]
  return def ?? GAMES.sa
}

export function isGameKind(value: unknown): value is GameKind {
  return typeof value === 'string' && value in GAMES
}

/**
 * Which games a catalogue post is for.
 *
 * MixMods states this in the post title - "[SA] VehFuncs", "[III|VC|SA]
 * CrashInfo", "[SA:DE] ..." - and again in the category list. The title prefix
 * is the stronger signal and is read first; categories fill in the posts whose
 * author did not use one. A post that names nothing recognisable is treated as
 * San Andreas, which is what the site is overwhelmingly about, and is flagged so
 * the UI can say it was inferred rather than stated.
 */
export function gamesOfMod(title: string, categories: string[] = []): { games: GameKind[]; inferred: boolean } {
  const found = new Set<GameKind>()

  const prefix = /^\s*\[([^\]]+)\]/.exec(title ?? '')?.[1]
  if (prefix) {
    for (const token of prefix.split(/[|,/]/).map((t) => t.trim())) {
      const upper = token.toUpperCase()
      if (/^SA[\s:-]*DE$/.test(upper) || upper === 'DE' || upper.includes('DEFINITIVE')) found.add('sade')
      else if (upper === 'SA' || upper.includes('SAN ANDREAS')) found.add('sa')
      else if (upper === 'III' || upper === 'GTA III' || upper === '3') found.add('iii')
      else if (upper === 'VC' || upper.includes('VICE')) found.add('vc')
    }
  }

  if (found.size === 0) {
    const haystack = categories.map((c) => c.toLowerCase())
    for (const kind of GAME_ORDER) {
      const def = GAMES[kind]
      if (haystack.some((c) => def.categoryHints.some((hint) => c.includes(hint)))) found.add(kind)
    }
    // "GTA SA" hints also match "GTA SA:DE"; the more specific one wins alone.
    if (found.has('sade') && found.has('sa') && !/\[/.test(title ?? '')) {
      const explicitlySa = categories.some((c) => /gta[\s-]*sa(?![\s-]*de)/i.test(c))
      if (!explicitlySa) found.delete('sa')
    }
  }

  if (found.size === 0) return { games: ['sa'], inferred: true }
  return { games: GAME_ORDER.filter((k) => found.has(k)), inferred: false }
}

/** The title with its "[SA]" style prefix removed, for display. */
export function titleWithoutGameTag(title: string): string {
  return (title ?? '').replace(/^\s*\[[^\]]{1,30}\]\s*/, '').trim() || title
}
