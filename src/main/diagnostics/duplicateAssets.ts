import path from 'node:path'
import type { GameInstall, HealthCheck } from '@shared/types'
import { groupDuplicateAssets, type HashedAsset } from '@shared/duplicateAssets'
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

export interface ScannedAsset {
  /** Absolute path on disk. */
  abs: string
  /** Base file name. */
  name: string
  /** Game-relative path, for display and for matching against limit-adjuster names. */
  rel: string
}

function scanRoots(game: GameInstall): string[] {
  const candidates = [game.asiDirectory, path.join(game.path, 'scripts'), path.join(game.path, 'cleo'), path.join(game.path, 'modloader')]
  const seen = new Set<string>()
  const out: string[] = []
  for (const c of candidates) {
    if (!c) continue
    const key = c.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/**
 * Every .asi / .cleo plugin binary reachable from the game tree, following
 * junctions. Cycle safety is `walk()`'s own: it tracks each directory's
 * realpath as it recurses and refuses to enter one twice, so a junction that
 * loops back on itself (or on a parent) cannot spin the scan forever.
 */
export async function scanGameTreeAssets(game: GameInstall): Promise<ScannedAsset[]> {
  const out: ScannedAsset[] = []
  const seenAbs = new Set<string>()
  for (const root of scanRoots(game)) {
    if (!exists(root)) continue
    const files = await walk(root)
    for (const f of files) {
      if (!PLUGIN_BINARY.test(f.abs)) continue
      const key = f.abs.toLowerCase()
      if (seenAbs.has(key)) continue
      seenAbs.add(key)
      out.push({ abs: f.abs, name: path.basename(f.abs), rel: path.relative(game.path, f.abs) })
    }
  }
  return out
}

/**
 * Hash-based duplicate-.asi detection across the ASI directory, scripts\,
 * cleo\ and every materialised modloader\ folder. Keyed by file name +
 * content hash - deliberately not `providesKey`, which keys `scripts/x.asi`
 * and `modloader/<mod>/x.asi` apart and so cannot see this by construction.
 */
export async function duplicateAssetCheck(game: GameInstall): Promise<HealthCheck> {
  const scanned = await scanGameTreeAssets(game)
  const hashed: HashedAsset[] = []
  for (const f of scanned) {
    const hash = await sha256File(f.abs).catch(() => null)
    if (hash) hashed.push({ name: f.name, path: f.rel, hash })
  }
  const groups = groupDuplicateAssets(hashed)

  if (!groups.length) {
    return { id: 'duplicate-asi', title: t('checks.dupTitle'), status: 'pass', summary: t('checks.dupNone') }
  }
  return {
    id: 'duplicate-asi',
    title: t('checks.dupTitle'),
    status: 'fail',
    summary: t('checks.dupFound', { count: groups.length }),
    detail: t('checks.dupDetail'),
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
export async function stackedAdjusterCheck(game: GameInstall): Promise<HealthCheck> {
  const scanned = await scanGameTreeAssets(game)
  const products = identifyLimitAdjusters(scanned.map((f) => f.rel))

  if (products.length < 2) {
    return { id: 'stacked-adjuster', title: t('checks.stackedTitle'), status: 'pass', summary: t('checks.stackedNone') }
  }
  return {
    id: 'stacked-adjuster',
    title: t('checks.stackedTitle'),
    status: 'fail',
    summary: t('checks.stackedFound', { count: products.length }),
    detail: t('checks.stackedDetail'),
    items: products.map((p) => t('checks.stackedItem', { label: p.label, paths: [...new Set(p.matches)].join(' | ') }))
  }
}
