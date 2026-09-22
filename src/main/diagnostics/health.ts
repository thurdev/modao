import path from 'node:path'
import type { HealthCheck, HealthReport, TxdAnalysis } from '@shared/types'
import { getDb } from '../db'
import { t } from '../util/i18n'
import { gameDefinition } from '@shared/games'
import { exists, walk } from '../util/fsx'
import { requireActiveGame } from '../game/detect'
import { checkGameExe } from '../game/pe'
import { probeWriteAccess } from '../game/access'
import { listConflicts } from '../conflicts'
import { profileDependencyProblems } from '../deps/resolver'
import { analyzeTxd } from '../formats/txd'
import { storeDir } from '../store/contentStore'

/** The pre-launch check: everything that can be known before the game starts. */
export async function runHealthCheck(profileId: number): Promise<HealthReport> {
  const game = requireActiveGame()
  const checks: HealthCheck[] = []

  // 1. Executable
  try {
    // The exe to read is whichever one identifies this game; only San Andreas
    // has a known-good stock build to compare against.
    const exeName = gameDefinition(game.kind).exeNames[0]
    const verdict = await checkGameExe(path.join(game.path, exeName))
    checks.push({
      id: 'exe',
      title: t('checks.exeTitle'),
      status: game.kind !== 'sa' ? 'skip' : verdict.isV1UsOriginal ? 'pass' : 'warn',
      summary:
        game.kind !== 'sa'
          ? t('checks.exeOther', { game: game.gameName })
          : verdict.isV1UsOriginal
            ? t('checks.exeStock')
            : t('checks.exeNotStock'),
      detail: verdict.summary,
      items: [
        t('checks.exeSize', { size: verdict.pe.sizeBytes.toLocaleString() }),
        t('checks.exeTimestamp', { value: `0x${verdict.pe.timestamp.toString(16).toUpperCase()}` }),
        t('checks.exeSha', { value: verdict.pe.sha256.slice(0, 32) })
      ]
    })
    checks.push({
      id: 'laa',
      title: t('checks.laaTitle'),
      status: verdict.largeAddressAware ? 'pass' : 'warn',
      summary: verdict.largeAddressAware ? t('checks.laaSet') : t('checks.laaUnset'),
      detail: t('checks.laaDetail', {
        value: `0x${verdict.pe.characteristics.toString(16).padStart(4, '0')}`
      })
    })
  } catch (e) {
    checks.push({ id: 'exe', title: t('checks.exeTitle'), status: 'fail', summary: (e as Error).message })
  }

  // 2. Write access - nothing else matters if the folder is read-only
  const access = probeWriteAccess(game.path, true)
  checks.push({
    id: 'write-access',
    title: t('checks.writeTitle'),
    status: access.writable ? 'pass' : 'fail',
    summary: access.writable
      ? t('checks.writeOk', { path: access.probedPath })
      : t('checks.writeDenied', { path: access.probedPath, code: access.code ? ` (${access.code})` : '' }),
    detail: access.reason ?? undefined
  })

  // 3. Mod Loader and the ASI directory
  checks.push({
    id: 'modloader',
    title: t('checks.modloaderTitle'),
    status: !game.supportsModLoader ? 'skip' : game.hasModLoader ? 'pass' : 'fail',
    summary: !game.supportsModLoader
      ? t('checks.modloaderNotApplicable')
      : game.hasModLoader
        ? t('checks.modloaderInstalled', { version: game.modLoaderVersion ? ` (${game.modLoaderVersion})` : '' })
        : t('checks.modloaderMissing'),
    detail: game.hasModLoader || !game.supportsModLoader ? undefined : t('checks.modloaderDetail')
  })
  checks.push({
    id: 'asi',
    title: t('checks.asiTitle'),
    status: game.asiLoader ? 'pass' : 'warn',
    summary: game.asiLoader
      ? t('checks.asiPresent', {
          loader: path.basename(game.asiLoader),
          dir: asiLabel(game.path, game.asiDirectory)
        })
      : t('checks.asiMissing'),
    detail: t('checks.asiDetail')
  })

  // 3. CLEO against plugin requirements
  const cleoPlugins = getDb()
    .prepare(
      `SELECT f.relative_path FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.enabled = 1 AND lower(f.relative_path) LIKE 'cleo/%'`
    )
    .all(profileId) as { relative_path: string }[]
  const hasCleoPlus = cleoPlugins.some((p) => /cleo\+?\.cleo$/i.test(p.relative_path) || /cleo\+/i.test(p.relative_path))
  const cleoVersion = game.cleoVersion
  if (hasCleoPlus) {
    const major = Number.parseFloat((cleoVersion ?? '0').replace(/[^\d.]/g, '')) || 0
    checks.push({
      id: 'cleo-plus',
      title: t('checks.cleoPlusTitle'),
      status: major >= 4.4 ? 'pass' : 'fail',
      summary:
        major >= 4.4
          ? t('checks.cleoPlusOk', { version: cleoVersion ?? t('checks.unknown') })
          : t('checks.cleoPlusTooOld', { version: cleoVersion ?? t('checks.unknown') }),
      detail: major >= 4.4 ? undefined : t('checks.cleoPlusDetail')
    })
  } else {
    checks.push({
      id: 'cleo',
      title: t('checks.cleoTitle'),
      status: cleoVersion ? 'pass' : 'skip',
      summary: cleoVersion
        ? t('checks.cleoDetected', { version: cleoVersion, count: cleoPlugins.length })
        : t('checks.cleoMissing'),
      detail: cleoPlugins.length ? cleoPlugins.slice(0, 8).map((p) => p.relative_path).join(', ') : undefined
    })
  }

  // 4. Dependencies
  const depProblems = profileDependencyProblems(profileId, game)
  checks.push({
    id: 'dependencies',
    title: t('checks.depsTitle'),
    status: depProblems.some((d) => d.resolution === 'blocking') ? 'fail' : depProblems.length ? 'warn' : 'pass',
    summary: depProblems.length === 0 ? t('checks.depsOk') : t('checks.depsUnresolved', { count: depProblems.length }),
    items: depProblems.map(
      (d) =>
        `${d.kind === 'conflicts' ? t('checks.depsConflict') : t('checks.depsMissing')}: ${d.title}${d.note ? ` - ${d.note}` : ''}`
    )
  })

  // 5. File conflicts
  const conflicts = listConflicts(profileId)
  const unresolved = conflicts.filter((c) => !c.winner)
  checks.push({
    id: 'conflicts',
    title: t('checks.conflictsTitle'),
    status: unresolved.length ? 'warn' : conflicts.length ? 'pass' : 'pass',
    summary:
      conflicts.length === 0
        ? t('checks.conflictsNone')
        : t('checks.conflictsSome', { count: conflicts.length, resolved: conflicts.length - unresolved.length }),
    items: conflicts
      .slice(0, 10)
      .map(
        (c) =>
          `${c.relativePath} -> ${
            c.winner
              ? t('checks.conflictsWinner', { title: c.winner.title, priority: c.winner.priority })
              : t('checks.conflictsNoWinner')
          }`
      )
  })

  // 6. Textures
  const textureProblems = await scanTextures(profileId)
  checks.push({
    id: 'textures',
    title: t('checks.texturesTitle'),
    status: textureProblems.npot.length ? 'warn' : 'pass',
    summary: textureProblems.npot.length
      ? t('checks.texturesBad', { count: textureProblems.npot.length, scanned: textureProblems.scanned })
      : t('checks.texturesOk', { scanned: textureProblems.scanned }),
    detail: textureProblems.npot.length ? t('checks.texturesDetail') : undefined,
    items: textureProblems.npot.slice(0, 12)
  })

  // 7. Oversized assets
  checks.push(await oversizedCheck(profileId))

  const blocking = checks.filter((c) => c.status === 'fail').length
  const warnings = checks.filter((c) => c.status === 'warn').length
  return {
    generatedAt: new Date().toISOString(),
    profileId,
    gamePath: game.path,
    checks,
    ok: blocking === 0,
    blocking,
    warnings
  }
}

function asiLabel(gamePath: string, asiDir: string | null): string {
  if (!asiDir) return t('checks.asiUnknown')
  const rel = path.relative(gamePath, asiDir)
  return rel === '' ? t('checks.asiGameRoot') : `${rel}\\`
}

interface TextureScan {
  scanned: number
  npot: string[]
  analyses: TxdAnalysis[]
}

export async function scanTextures(profileId: number, budget = 60): Promise<TextureScan> {
  const rows = getDb()
    .prepare(
      `SELECT i.store_key, f.relative_path FROM install_file f
         JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.enabled = 1 AND lower(f.relative_path) LIKE '%.txd'`
    )
    .all(profileId) as { store_key: string | null; relative_path: string }[]

  const game = requireActiveGame()
  const out: TextureScan = { scanned: 0, npot: [], analyses: [] }
  for (const row of rows.slice(0, budget)) {
    const file = row.store_key
      ? path.join(storeDir(row.store_key), row.relative_path)
      : path.join(game.path, row.relative_path)
    if (!exists(file)) continue
    const a = await analyzeTxd(file).catch(() => null)
    if (!a) continue
    out.scanned++
    out.analyses.push(a)
    for (const t of a.nonPowerOfTwo) {
      out.npot.push(`${row.relative_path}: ${t.name} is ${t.width}x${t.height}`)
    }
  }
  return out
}

async function oversizedCheck(profileId: number): Promise<HealthCheck> {
  const rows = getDb()
    .prepare('SELECT store_key, folder_name FROM install WHERE profile_id = ? AND enabled = 1 AND store_key IS NOT NULL')
    .all(profileId) as { store_key: string; folder_name: string | null }[]
  const big: string[] = []
  let total = 0
  for (const r of rows) {
    const files = await walk(storeDir(r.store_key))
    const size = files.reduce((a, f) => a + f.size, 0)
    total += size
    if (size > 512 * 1024 * 1024) big.push(`${r.folder_name ?? r.store_key}: ${(size / 1024 ** 3).toFixed(2)} GB`)
  }
  return {
    id: 'size',
    title: t('checks.sizeTitle'),
    status: big.length ? 'warn' : 'pass',
    summary: t('checks.sizeSummary', { size: (total / 1024 ** 3).toFixed(2) }),
    detail: big.length ? t('checks.sizeDetail') : undefined,
    items: big
  }
}
