import path from 'node:path'
import type { GameInstall, HealthCheck } from '@shared/types'
import { groupDuplicateAssets, isInertScanPath, type HashedAsset } from '@shared/duplicateAssets'
import { identifyLimitAdjusters } from '@shared/limitAdjusters'
import { exists, sha256File, walk } from '../util/fsx'
import { t } from '../util/i18n'

/**
 * The scan item-08 of the field audit found missing: nothing pointed
 * `walk()` (src/main/util/fsx.ts, already follows directory junctions) at the
 * live game tree. `adoptIntoProfile` reads only modloader\ and deliberately
 * skips junctions - correct for adoption, but it means neither side of a
 * scripts\ + modloader\<mod>\ duplicate is ever seen by anything.
 *
 * This scans every place a plugin binary can legally live: the ASI directory
 * actually detected (never assumed to be the game root - some installs load
 * from scripts\), scripts\ itself, cleo\, and modloader\ - which walk()
 * follows straight through every materialised mod folder, junctioned or not.
 * Roots are de-duplicated (a repack's ASI directory usually IS scripts\), and
 * so are the files themselves: a file reachable from two scanned roots is
 * still one file, not a duplicate of itself.
 */
const PLUGIN_BINARY = /\.(asi|cleo\d?)$/i

/**
 * Files walked per run, shared across the roots. Generous enough that a normal
 * install - even a heavily modded one - is scanned whole, low enough that a
 * pathological tree cannot hang the health check. `logs.ts` caps its own walk
 * the same way.
 */
const MAX_SCANNED_FILES = 20000

export interface ScannedAsset {
  /** Absolute path on disk. */
  abs: string
  /** Base file name. */
  name: string
  /** Game-relative path, for display and for matching against limit-adjuster names. */
  rel: string
}

export interface GameTreeScan {
  assets: ScannedAsset[]
  /** True when the per-run file cap stopped the walk before the tree was exhausted. */
  capped: boolean
}

/**
 * The ASI directory is used exactly as DETECTED, never assumed - but when
 * detection yields nothing (no modloader.asi, or an install that never had
 * one), the plugins are loose in the game root, and scanning only
 * scripts\/cleo\/modloader\ would look at everything except where they
 * actually are and report a clean bill of health. `game.asiDirectory ??
 * game.path` is the same fallback every other ASI-directory call site uses
 * (health.ts:357, engine.ts:775, switchTx.ts:601, manager.ts:797).
 *
 * Nested roots are dropped, not merely identical ones. Those call sites read
 * shallowly; this one recurses, so when the fallback makes the game root a
 * root, scripts\, cleo\ and modloader\ are all INSIDE it and walking them
 * again would walk the same subtrees a second time for nothing. De-duplicating
 * the roots before the walk, rather than the files after it, is what keeps the
 * fallback cheap.
 */
export function scanRoots(gamePath: string, asiDirectory: string | null): string[] {
  const candidates = [asiDirectory ?? gamePath, path.join(gamePath, 'scripts'), path.join(gamePath, 'cleo'), path.join(gamePath, 'modloader')]
  const key = (p: string): string => path.resolve(p).toLowerCase()
  const unique = [...new Map(candidates.filter((c): c is string => !!c).map((c) => [key(c), c])).values()]
  return unique.filter((c) => !unique.some((other) => key(other) !== key(c) && key(c).startsWith(key(other) + path.sep)))
}

/**
 * Every .asi / .cleo plugin binary reachable from the game tree, following
 * junctions. Cycle safety is `walk()`'s own: it tracks the realpath chain of
 * the directories it is currently inside and refuses to re-enter one of its
 * own ancestors, so a junction that loops back on itself (or on a parent)
 * cannot spin the scan forever - while two separate junctions onto the same
 * store folder are still both walked, because each is a real, live location
 * the file loads from.
 *
 * The walk is capped: a health check the user is waiting on must not turn into
 * a multi-minute stall on an unusual install (the game root is a root whenever
 * no ASI directory was detected, and a modded GTA tree can be very large). The
 * budget is shared across the roots, and when it runs out the scan says so -
 * `capped` - so a partial scan is never reported as a clean bill of health.
 */
export async function scanGameTree(game: GameInstall, opts: { maxFiles?: number } = {}): Promise<GameTreeScan> {
  const out: ScannedAsset[] = []
  const seenAbs = new Set<string>()
  let remaining = Math.max(1, opts.maxFiles ?? MAX_SCANNED_FILES)
  let capped = false
  for (const root of scanRoots(game.path, game.asiDirectory)) {
    if (remaining <= 0) {
      capped = true
      break
    }
    if (!exists(root)) continue
    const files = await walk(root, { maxFiles: remaining })
    // A walk that came back exactly full may have stopped short; counted as
    // capped deliberately, since overstating completeness is the failure mode
    // that matters here.
    if (files.length >= remaining) capped = true
    remaining -= files.length
    for (const f of files) {
      if (!PLUGIN_BINARY.test(f.abs)) continue
      const key = f.abs.toLowerCase()
      if (seenAbs.has(key)) continue
      const rel = path.relative(game.path, f.abs)
      // On disk but not loaded: a mod the user DISABLED (Mod Loader's own ". "
      // folder rename - every byte deliberately kept) and the hidden
      // `.variants\` snapshot of the options nobody chose. Both are reachable
      // through the same junctions this walk follows on purpose, and counting
      // them would let a duplicate-.asi or stacked-adjuster FAIL - a launch
      // blocker - be raised over content the user switched off or never
      // picked. See `isInertScanPath`.
      if (isInertScanPath(rel)) continue
      seenAbs.add(key)
      out.push({ abs: f.abs, name: path.basename(f.abs), rel })
    }
  }
  return { assets: out, capped }
}

/** The assets alone, for callers that do not care whether the cap was reached. */
export async function scanGameTreeAssets(game: GameInstall): Promise<ScannedAsset[]> {
  return (await scanGameTree(game)).assets
}

/**
 * Hash-based duplicate-.asi detection across the ASI directory, scripts\,
 * cleo\ and every materialised modloader\ folder. Keyed by file name +
 * content hash - deliberately not `providesKey`, which keys `scripts/x.asi`
 * and `modloader/<mod>/x.asi` apart and so cannot see this by construction.
 */
export async function duplicateAssetCheck(game: GameInstall, opts: { maxFiles?: number } = {}): Promise<HealthCheck> {
  const scan = await scanGameTree(game, opts)
  const hashed: HashedAsset[] = []
  for (const f of scan.assets) {
    const hash = await sha256File(f.abs).catch(() => null)
    if (hash) hashed.push({ name: f.name, path: f.rel, hash })
  }
  const groups = groupDuplicateAssets(hashed)
  // A partial scan never presents itself as complete - the same rule the
  // upstream check follows (upstream.ts:312-319), and it matters most on the
  // branch that otherwise reads as "nothing to worry about".
  const cappedNote = scan.capped ? t('checks.scanCapped') : undefined

  if (!groups.length) {
    return { id: 'duplicate-asi', title: t('checks.dupTitle'), status: 'pass', summary: t('checks.dupNone'), detail: cappedNote }
  }
  return {
    id: 'duplicate-asi',
    title: t('checks.dupTitle'),
    status: 'fail',
    summary: t('checks.dupFound', { count: groups.length }),
    detail: [t('checks.dupDetail'), ...(cappedNote ? [cappedNote] : [])].join(' '),
    items: groups.map((g) => t('checks.dupItem', { name: g.fileName, count: g.paths.length, paths: g.paths.join(' | ') }))
  }
}

/**
 * Flags two or more DIFFERENT limit adjusters materialised at once - Open
 * Limit Adjuster and SimpleLimitAdjuster_Enex were both active in the field
 * install, and the CrashList warns explicitly that stacking limit adjusters
 * crashes the game. `limitAdjusterNames()` is a single boolean regex, used
 * everywhere else via `.some()`; this counts distinct products instead, over
 * the same junction-resolving scan `duplicateAssetCheck` uses, so a loose
 * file in scripts\ and one buried in a junctioned modloader\ folder are both
 * seen.
 */
export async function stackedAdjusterCheck(game: GameInstall, opts: { maxFiles?: number } = {}): Promise<HealthCheck> {
  const scan = await scanGameTree(game, opts)
  const products = identifyLimitAdjusters(scan.assets.map((f) => f.rel))
  const cappedNote = scan.capped ? t('checks.scanCapped') : undefined

  if (products.length < 2) {
    return { id: 'stacked-adjuster', title: t('checks.stackedTitle'), status: 'pass', summary: t('checks.stackedNone'), detail: cappedNote }
  }
  return {
    id: 'stacked-adjuster',
    title: t('checks.stackedTitle'),
    status: 'fail',
    summary: t('checks.stackedFound', { count: products.length }),
    detail: [t('checks.stackedDetail'), ...(cappedNote ? [cappedNote] : [])].join(' '),
    items: products.map((p) => t('checks.stackedItem', { label: p.label, paths: [...new Set(p.matches)].join(' | ') }))
  }
}
