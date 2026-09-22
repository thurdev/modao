import path from 'node:path'
import fsp from 'node:fs/promises'
import type { GameInstall, HealthCheck, HealthReport, TxdAnalysis } from '@shared/types'
import { getDb } from '../db'
import { t } from '../util/i18n'
import { limitAdjusterNames, readStreamIni, RISKY_STREAMING_MEMORY_MB, SAFE_STREAMING_MEMORY_MB } from '../game/streamIni'
import { reportFromGame } from './modloaderLog'
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

  // 7. Streaming memory: the crash that looks like a mod and is not one
  checks.push(await streamingMemoryCheck(profileId, game))

  // 8. What Mod Loader itself says happened
  checks.push(await modLoaderVerdictCheck(profileId, game))

  // 9. Configs whose plugin is gone
  checks.push(await orphanedConfigCheck(game))

  // 10. Frame limiter
  checks.push(await fpsCapCheck(game))

  // 11. Loose files that make the streamer crawl
  checks.push(await looseFileCheck(profileId))

  // 12. Oversized assets
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

/**
 * A repack's stream.ini asks for more memory than a 32-bit process has, and the
 * game dies inside the streamer on the first .IMG read. Nothing about the mods
 * is wrong, so nothing else in this panel would ever find it.
 */
async function streamingMemoryCheck(profileId: number, game: GameInstall): Promise<HealthCheck> {
  const reading = await readStreamIni(game.path)
  if (!reading.exists || reading.memoryMb === null) {
    return { id: 'stream-ini', title: t('checks.streamTitle'), status: 'skip', summary: t('checks.streamMissing') }
  }

  const adjuster = limitAdjusterNames()
  const rows = getDb()
    .prepare(
      `SELECT f.relative_path p FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.enabled = 1`
    )
    .all(profileId) as { p: string }[]
  const hasAdjuster = rows.some((r) => adjuster.test(r.p)) || (game.asiDirectory ? await asiDirHasAdjuster(game) : false)

  if (reading.memoryMb <= RISKY_STREAMING_MEMORY_MB) {
    return {
      id: 'stream-ini',
      title: t('checks.streamTitle'),
      status: 'pass',
      summary: t('checks.streamOk', { value: reading.memoryMb }),
      items: [reading.path]
    }
  }
  if (hasAdjuster) {
    return {
      id: 'stream-ini',
      title: t('checks.streamTitle'),
      status: 'warn',
      summary: t('checks.streamOkAdjuster', { value: reading.memoryMb }),
      items: [reading.path]
    }
  }
  return {
    id: 'stream-ini',
    title: t('checks.streamTitle'),
    status: 'fail',
    summary: t('checks.streamRisky', { value: reading.memoryMb }),
    detail: t('checks.streamRiskyDetail', { value: reading.memoryMb, safe: SAFE_STREAMING_MEMORY_MB }),
    items: [reading.path]
  }
}

/** An adjuster can also sit loose in the ASI directory, outside any profile. */
async function asiDirHasAdjuster(game: GameInstall): Promise<boolean> {
  const dir = game.asiDirectory ?? game.path
  if (!exists(dir)) return false
  const entries: string[] = await fsp.readdir(dir).catch(() => [])
  return entries.some((name) => limitAdjusterNames().test(name))
}

/**
 * Asks Mod Loader what it did with this profile's mods, instead of trusting the
 * install that put them there.
 */
async function modLoaderVerdictCheck(profileId: number, game: GameInstall): Promise<HealthCheck> {
  if (!game.supportsModLoader) {
    return { id: 'modloader-log', title: t('checks.modsTitle'), status: 'skip', summary: t('checks.modloaderNotApplicable') }
  }
  const expected = (
    getDb()
      .prepare('SELECT folder_name FROM install WHERE profile_id = ? AND enabled = 1 AND folder_name IS NOT NULL')
      .all(profileId) as { folder_name: string }[]
  ).map((r) => r.folder_name)

  const report = await reportFromGame(game.path, expected)
  if (!report) {
    return { id: 'modloader-log', title: t('checks.modsTitle'), status: 'skip', summary: t('checks.modsNoLog') }
  }

  const tracked = report.mods.filter((m) => expected.includes(m.folder))
  // Mod Loader's own verdict is the only source that says whether an install
  // WORKED, so it is what the app remembers about this mod.
  const { learnVerdict } = await import('../knowledge/learn')
  for (const m of tracked) learnVerdict(m.folder, { verdict: m.verdict, explanation: m.explanation })
  const bad = tracked.filter((m) => m.verdict !== 'active')
  const label: Record<string, string> = {
    active: t('checks.verdictActive'),
    inert: t('checks.verdictInert'),
    'mis-installed': t('checks.verdictMisInstalled'),
    unknown: t('checks.verdictUnknown')
  }

  return {
    id: 'modloader-log',
    title: t('checks.modsTitle'),
    status: bad.some((m) => m.verdict === 'mis-installed') ? 'fail' : bad.length ? 'warn' : 'pass',
    summary: bad.length
      ? t('checks.modsProblems', { bad: bad.length, count: tracked.length })
      : t('checks.modsAllActive', { count: tracked.length }),
    detail: t('checks.modsDetail'),
    items: bad.map((m) => `${m.folder} — ${label[m.verdict]}${m.explanation ? `: ${m.explanation}` : ''}`)
  }
}

/**
 * An .ini whose .asi is gone. Harmless to the game, and a trap for whoever is
 * diagnosing it: the file reads as evidence that a mod is installed when it is
 * not. After an uninstall these are exactly what is left behind.
 */
async function orphanedConfigCheck(game: GameInstall): Promise<HealthCheck> {
  const dir = game.asiDirectory ?? game.path
  if (!game.supportsAsi || !exists(dir)) {
    return { id: 'orphan-config', title: t('checks.orphanTitle'), status: 'skip', summary: t('checks.orphanNone') }
  }
  const entries: string[] = await fsp.readdir(dir).catch(() => [])
  const plugins = new Set(
    entries.filter((f) => /\.(asi|dll)$/i.test(f)).map((f) => f.replace(/\.(asi|dll)$/i, '').toLowerCase())
  )
  const orphans = entries.filter((f) => {
    if (!/\.(ini|json|cfg|dat)$/i.test(f)) return false
    const stem = f.replace(/\.(ini|json|cfg|dat)$/i, '').toLowerCase()
    // A config shared by the game itself is not an orphan.
    if (['stream', 'modloader', 'cleo', 'gta_sa', 'settings'].includes(stem)) return false
    return !plugins.has(stem)
  })

  return {
    id: 'orphan-config',
    title: t('checks.orphanTitle'),
    status: orphans.length ? 'warn' : 'pass',
    summary: orphans.length ? t('checks.orphanFound', { count: orphans.length }) : t('checks.orphanNone'),
    detail: orphans.length ? t('checks.orphanDetail') : undefined,
    items: orphans.slice(0, 12)
  }
}

/** Frame limiters worth reading, and the key each one keeps the number under. */
const FPS_SOURCES: { file: string; key: RegExp }[] = [
  { file: 'SilentPatchSA.ini', key: /^framelimit/i },
  { file: 'MixSets.ini', key: /^(fpslimit|framelimit)/i },
  { file: 'modloader/modloader.ini', key: /^(fpslimit|framelimit)/i }
]

/**
 * GTA SA ties physics and mission scripts to the framerate: above 60 the
 * handling model misbehaves and some missions cannot be finished. A limiter set
 * higher is a bug report waiting to happen, and it looks like a mod problem.
 */
async function fpsCapCheck(game: GameInstall): Promise<HealthCheck> {
  let found: { value: number; file: string } | null = null
  for (const source of FPS_SOURCES) {
    const file = path.join(game.asiDirectory ?? game.path, source.file)
    const alt = path.join(game.path, source.file)
    const target = exists(file) ? file : exists(alt) ? alt : null
    if (!target) continue
    const text = await fsp.readFile(target, 'latin1').catch(() => '')
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z]+)\s*=\s*(\d+)/.exec(line)
      if (m && source.key.test(m[1])) {
        const value = Number.parseInt(m[2], 10)
        if (Number.isFinite(value) && value > 0) found = { value, file: target }
      }
    }
  }
  if (!found) {
    return { id: 'fps-cap', title: t('checks.fpsTitle'), status: 'skip', summary: t('checks.fpsUnknown') }
  }
  return {
    id: 'fps-cap',
    title: t('checks.fpsTitle'),
    status: found.value > 60 ? 'warn' : 'pass',
    summary: found.value > 60 ? t('checks.fpsHigh', { value: found.value }) : t('checks.fpsOk', { value: found.value }),
    detail: found.value > 60 ? t('checks.fpsDetail') : undefined,
    items: [found.file]
  }
}

/** Above this many loose files in one mod folder, the streamer starts to hurt. */
const LOOSE_FILE_LIMIT = 300

async function looseFileCheck(profileId: number): Promise<HealthCheck> {
  const rows = getDb()
    .prepare(
      `SELECT i.folder_name f, COUNT(*) c FROM install_file fi
         JOIN install i ON i.id = fi.install_id
        WHERE i.profile_id = ? AND i.enabled = 1 AND i.folder_name IS NOT NULL
          AND (lower(fi.relative_path) LIKE '%.dff' OR lower(fi.relative_path) LIKE '%.txd')
        GROUP BY i.folder_name HAVING c > ?`
    )
    .all(profileId, LOOSE_FILE_LIMIT) as { f: string; c: number }[]

  return {
    id: 'loose-files',
    title: t('checks.looseTitle'),
    status: rows.length ? 'warn' : 'pass',
    summary: rows.length
      ? t('checks.looseFound', { count: rows.length, limit: LOOSE_FILE_LIMIT })
      : t('checks.looseOk'),
    detail: rows.length ? t('checks.looseDetail') : undefined,
    items: rows.map((r) => `${r.f}: ${r.c}`)
  }
}
