import path from 'node:path'
import fsp from 'node:fs/promises'
import type { GameInstall, HealthCheck, HealthReport, TxdAnalysis } from '@shared/types'
import { getDb } from '../db'
import { t } from '../util/i18n'
import { limitAdjusterNames, readStreamIni, RISKY_STREAMING_MEMORY_MB, SAFE_STREAMING_MEMORY_MB } from '../game/streamIni'
import { reportFromGame } from './modloaderLog'
import { outdatedBuildCheck } from './upstream'
import { resolveExeName } from '@shared/games'
import { exists, isLink, moveSafe, timestampSlug, walk } from '../util/fsx'
import { Paths } from '../util/paths'
import {
  findOrphanConfigs,
  orphanOwningProfiles,
  orphanPluginFolder,
  type OrphanFinding
} from '@shared/orphanConfigs'
import { requireActiveGame } from '../game/detect'
import { checkGameExe } from '../game/pe'
import { cachedWriteAccess, probeWriteAccess } from '../game/access'
import { checkGameRunning, gameExeNames } from '../game/running'
import { cleoPluginRequirements, cleoRequirementStatus } from '@shared/cleoPlugins'
import { listConflicts, listHookCollisions, providesKey } from '../conflicts'
import { profileDependencyProblems } from '../deps/resolver'
import { isUnsatisfiedHardDependency } from '@shared/dependencyGraph'
import { analyzeTxd } from '../formats/txd'
import { storeDir } from '../store/contentStore'
import { duplicateAssetCheck, stackedAdjusterCheck } from './duplicateAssets'

/**
 * The pre-launch check: everything that can be known before the game starts.
 *
 * `profileId` may be null. Having no active profile is a reachable state, and
 * it used to mean no check ran at all - which left the one failure this whole
 * panel was written for, a stream.ini asking for more memory than a 32-bit
 * process has, entirely unguarded. It is fatal with or without a profile
 * pointing at it. So the game-level checks run either way and only the
 * profile-scoped ones stand down.
 */
export async function runHealthCheck(profileId: number | null): Promise<HealthReport> {
  const game = requireActiveGame()
  const checks: HealthCheck[] = []
  /** A check that reads a profile's installs, with no profile to read. */
  const needsProfile = (id: string, title: string): HealthCheck => ({
    id,
    title,
    status: 'skip',
    summary: t('checks.noProfile')
  })

  // 1. Executable
  //
  // Every `fail` in this report is a launch blocker (see @shared/launchGate), so
  // a finding here has to be one that genuinely predicts a crash - or a game
  // that runs fine gets refused. Two did:
  //
  //  - this check read `exeNames[0]` while planLaunch searches the whole list,
  //    so a Vice City install named gta_vc.exe (the second entry) or an SA:DE
  //    install started from PlayGTASA.exe reported "no executable" and was
  //    refused a launch of the executable the launch had just found. It asks
  //    the same question as the launch now.
  //  - and a header this parser cannot read is not a crash: it is a build it
  //    does not recognise. That is a `warn`. A missing executable is still a
  //    `fail`, though planLaunch refuses on it first, with its own message.
  const exeName = resolveExeName(game.kind, (name) => exists(path.join(game.path, name)))
  try {
    if (!exeName) throw new Error(t('messages.game.exeNotFound', { game: game.gameName, path: game.path }))
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
    checks.push({
      id: 'exe',
      title: t('checks.exeTitle'),
      status: exeName ? 'warn' : 'fail',
      summary: (e as Error).message
    })
  }

  // 2. Is the game open right now?
  //
  // Asked here, and asked first, because half this panel depends on the answer
  // and because the user should learn it from a check rather than from being
  // refused an install three clicks later.
  const running = await checkGameRunning(game)
  checks.push({
    id: 'game-running',
    title: t('checks.runningTitle'),
    status: running.allowed ? 'pass' : 'warn',
    summary: running.allowed
      ? t('checks.runningClosed', { exe: gameExeNames(game.kind)[0] })
      : running.assumed
        ? t('checks.runningAssumed', { exe: running.exe ?? gameExeNames(game.kind)[0] })
        : t('checks.runningOpen', { exe: running.exe ?? gameExeNames(game.kind)[0], pid: running.process?.pid ?? 0 }),
    detail: running.allowed ? undefined : t('checks.runningDetail')
  })

  // 3. Write access - nothing else matters if the folder is read-only.
  //
  // With the game up the probe is deliberately not taken: it writes a file into
  // modloader\, which Mod Loader watches and hot-reloads, and that is the very
  // hazard the check above exists to name. So the answer is `unknown` and says
  // so. It used to render as a plain `pass`, which is a never-taken probe
  // presented as a clean bill of health.
  if (!running.allowed) {
    const stale = cachedWriteAccess(game.path)
    checks.push({
      id: 'write-access',
      title: t('checks.writeTitle'),
      status: 'unknown',
      summary: t('checks.writeUnknownRunning'),
      detail: t('checks.writeUnknownDetail'),
      items: stale
        ? [
            stale.writable
              ? t('checks.writeOk', { path: stale.probedPath })
              : t('checks.writeDenied', { path: stale.probedPath, code: stale.code ? ` (${stale.code})` : '' })
          ]
        : undefined
    })
  } else {
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
  }

  // 3. Mod Loader and the ASI directory
  //
  // `warn`, not `fail`: a `fail` refuses the launch now, and a vanilla GTA SA
  // with no Mod Loader in it runs perfectly well. Modão cannot install into it
  // until Mod Loader is there - which is what the detail says - but refusing to
  // start an unmodded game someone has just added is a refusal of something
  // that was never going to crash.
  checks.push({
    id: 'modloader',
    title: t('checks.modloaderTitle'),
    status: !game.supportsModLoader ? 'skip' : game.hasModLoader ? 'pass' : 'warn',
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

  // CLEO against every plugin's own requirement
  checks.push(profileId === null ? needsProfile('cleo', t('checks.cleoTitle')) : cleoCheck(profileId, game))

  // 4. Dependencies
  if (profileId === null) checks.push(needsProfile('dependencies', t('checks.depsTitle')))
  else {
    const depProblems = profileDependencyProblems(profileId, game)
    checks.push({
      id: 'dependencies',
      title: t('checks.depsTitle'),
      // The SAME predicate the launch gate refuses on. It used to be
      // `resolution === 'blocking'` here and `blocking || missing` there
      // (dependencyLaunchBlockers), so the spec's own motivating case - Proper
      // Shaders with neither SilentPatch nor Open Limit Adjuster, both merely
      // `missing` - produced a report with no fail in it: Health said "Ready to
      // launch", hid "Launch anyway" because it only renders on !ok, and Play
      // refused every time. A refusal the user cannot see is a refusal the user
      // cannot answer.
      status: depProblems.some(isUnsatisfiedHardDependency) ? 'fail' : depProblems.length ? 'warn' : 'pass',
      summary: depProblems.length === 0 ? t('checks.depsOk') : t('checks.depsUnresolved', { count: depProblems.length }),
      items: depProblems.map(
        (d) =>
          `${d.kind === 'conflicts' ? t('checks.depsConflict') : t('checks.depsMissing')}: ${d.title}${d.note ? ` - ${d.note}` : ''}`
      )
    })
  }

  // 5. File conflicts
  if (profileId === null) checks.push(needsProfile('conflicts', t('checks.conflictsTitle')))
  else {
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
              // A split model has no winner BECAUSE each mod wins one half of it - the
              // opposite of "every claimant is disabled or priority 0", which is what
              // conflictsNoWinner says. Rendering that here would restate the exact
              // conflation rule 4 exists to prevent, on the one screen that never
              // reads @shared/splitModels's distinction from the streaming budget.
              c.kind === 'split-model'
                ? t('conflicts.splitModelHint')
                : c.winner
                  ? t('checks.conflictsWinner', { title: c.winner.title, priority: c.winner.priority })
                  : t('checks.conflictsNoWinner')
            }`
        )
    })
  }

  // 6. Textures
  if (profileId === null) checks.push(needsProfile('textures', t('checks.texturesTitle')))
  else {
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
  }

  // 7. Streaming memory: the crash that looks like a mod and is not one.
  // Game-level, and the reason this function accepts a null profile at all.
  checks.push(await streamingMemoryCheck(profileId, game))

  // 8. What Mod Loader itself says happened
  checks.push(
    profileId === null
      ? needsProfile('modloader-log', t('checks.modsTitle'))
      : await modLoaderVerdictCheck(profileId, game)
  )

  // 9. Configs whose plugin is gone
  checks.push(await orphanedConfigCheck(game, profileId))

  // 10. Frame limiter
  checks.push(await fpsCapCheck(game))

  // 11. Loose files that make the streamer crawl
  checks.push(profileId === null ? needsProfile('loose-files', t('checks.looseTitle')) : await looseFileCheck(profileId))

  // 12. Oversized assets
  checks.push(profileId === null ? needsProfile('size', t('checks.sizeTitle')) : await oversizedCheck(profileId))

  // 13. Is the build simply old? The cheapest suspect in any crash, and the one
  // the field report found last after days of bisecting.
  checks.push(profileId === null ? needsProfile('upstream', t('checks.upstreamTitle')) : await outdatedBuildCheck(profileId))

  // 14. Two mods hooking the same address - invisible to the file-conflict
  // check above, since both .asi files install cleanly.
  checks.push(profileId === null ? needsProfile('hook-collision', t('checks.hookTitle')) : await hookCollisionCheck(profileId))

  // 15. The same plugin binary sitting at two paths at once - byte-identical
  // copies in scripts\ and a junctioned modloader\ folder both patch the same
  // limits and fight (see src/main/diagnostics/duplicateAssets.ts).
  checks.push(await duplicateAssetCheck(game))

  // 16. Two DIFFERENT limit adjusters materialised in one profile - the
  // CrashList warns explicitly that stacking them crashes the game.
  checks.push(await stackedAdjusterCheck(game))

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

/**
 * Every installed .cleo plugin against the CLEO that will load it.
 *
 * The requirement is read per plugin, from the version range that plugin's own
 * mod declares - so a plugin published tomorrow with a floor of its own is
 * gated by a catalogue row rather than by a release of this app. CLEO+ is the
 * one case that predates any catalogue and is kept as field knowledge in
 * `KNOWN_CLEO_REQUIREMENTS`: against CLEO 4.3 it dies at startup with "The
 * ordinal 22 could not be located in the dynamic link library CLEO+.cleo".
 */
function cleoCheck(profileId: number, game: GameInstall): HealthCheck {
  const rows = getDb()
    .prepare(
      // The subject is bound BY ID OR BY SLUG, exactly as `resolveDependencies`
      // binds it. The dependency migration deliberately kept subject-slug rows
      // for mods the bundled catalogue has never heard of - `mod_id` is
      // nullable and `mod_slug` carries them - so a locally installed plugin's
      // declared CLEO range lives on a row with no `mod_id` at all. Joining on
      // `mod_id` alone dropped it silently, and this check is a launch gate:
      // the fatal CLEO mismatch it exists to catch went unreported for exactly
      // the mods that are not in the catalogue.
      `SELECT DISTINCT f.relative_path p, d.version_range r
         FROM install_file f
         JOIN install i ON i.id = f.install_id
         LEFT JOIN mod_version mv ON mv.id = i.mod_version_id
         LEFT JOIN mod sm ON sm.id = mv.mod_id
         LEFT JOIN dependency d
                ON (d.mod_id = mv.mod_id OR (d.mod_slug IS NOT NULL AND d.mod_slug = sm.slug))
               AND d.kind = 'requires'
               AND lower(coalesce((SELECT m.slug FROM mod m WHERE m.id = d.requires_mod_id), d.requires_slug, ''))
                   IN ('cleo', 'cleo4', 'cleo-library', 'cleolibrary')
        WHERE i.profile_id = ? AND i.enabled = 1
          AND (lower(f.relative_path) LIKE 'cleo/%' OR lower(f.relative_path) LIKE '%.cleo')`
    )
    .all(profileId) as { p: string; r: string | null }[]

  // One entry per file, carrying every range its mod declares against CLEO.
  const declared = new Map<string, string[]>()
  const paths: string[] = []
  for (const row of rows) {
    if (!declared.has(row.p)) {
      declared.set(row.p, [])
      paths.push(row.p)
    }
    if (row.r) declared.get(row.p)!.push(row.r)
  }

  const cleoVersion = game.cleoVersion
  const version = cleoVersion ?? t('checks.unknown')
  const verdicts = cleoPluginRequirements(
    paths.map((p) => ({ path: p, declaredRanges: declared.get(p) })),
    cleoVersion
  )

  if (verdicts.length === 0) {
    return {
      id: 'cleo',
      title: t('checks.cleoTitle'),
      status: cleoVersion ? 'pass' : 'skip',
      summary: cleoVersion ? t('checks.cleoDetected', { version: cleoVersion, count: paths.length }) : t('checks.cleoMissing'),
      detail: paths.length ? paths.slice(0, 8).join(', ') : undefined
    }
  }

  const status = cleoRequirementStatus(verdicts)
  const failing = verdicts.filter((v) => v.satisfied === false)
  const unknown = verdicts.filter((v) => v.satisfied === null)
  const first = failing[0] ?? unknown[0]

  return {
    id: 'cleo',
    title: t('checks.cleoTitle'),
    status,
    summary:
      status === 'fail'
        ? t('checks.cleoPluginTooOld', { count: failing.length, name: first.name, range: first.range, version })
        : status === 'warn'
          ? t('checks.cleoPluginUnknown', { count: unknown.length, name: first.name, range: first.range })
          : t('checks.cleoPluginsOk', { version, count: verdicts.length }),
    detail:
      status === 'fail'
        ? failing.some((v) => /^cleo\+?$|^cleo[_ -]?plus$/i.test(v.name))
          ? t('checks.cleoPlusDetail')
          : t('checks.cleoPluginDetail')
        : undefined,
    items: verdicts.map((v) => t('checks.cleoPluginItem', { name: v.name, range: v.range, version, path: v.path }))
  }
}

/**
 * A plugin-sdk .asi built with no source encodes the addresses it hooks as
 * mangled template args in its own symbol table. Two mods hooking the same
 * one never show up in the file-conflict check - both binaries install fine
 * - so this is the only place the app can catch it.
 */
async function hookCollisionCheck(profileId: number): Promise<HealthCheck> {
  const collisions = await listHookCollisions(profileId)
  return {
    id: 'hook-collision',
    title: t('checks.hookTitle'),
    status: collisions.length ? 'warn' : 'pass',
    summary: collisions.length ? t('checks.hookFound', { count: collisions.length }) : t('checks.hookNone'),
    detail: collisions.length ? t('checks.hookDetail') : undefined,
    items: collisions.map((c) => `${c.address}: ${[...new Set(c.claimants.map((x) => x.title))].join(' vs ')}`)
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
async function streamingMemoryCheck(profileId: number | null, game: GameInstall): Promise<HealthCheck> {
  const reading = await readStreamIni(game.path)
  if (!reading.exists || reading.memoryMb === null) {
    return { id: 'stream-ini', title: t('checks.streamTitle'), status: 'skip', summary: t('checks.streamMissing') }
  }

  const adjuster = limitAdjusterNames()
  // With no profile there are no tracked installs to look through - only the
  // ASI directory, which is where a loose adjuster would sit anyway.
  const rows = (
    profileId === null
      ? []
      : getDb()
          .prepare(
            `SELECT f.relative_path p FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.enabled = 1`
          )
          .all(profileId)
  ) as { p: string }[]
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
async function orphanedConfigCheck(game: GameInstall, profileId: number | null): Promise<HealthCheck> {
  const dir = game.asiDirectory ?? game.path
  if (!game.supportsAsi || !exists(dir)) {
    return { id: 'orphan-config', title: t('checks.orphanTitle'), status: 'skip', summary: t('checks.orphanNone') }
  }
  const findings = await orphanFindings(game, profileId)
  const reunitable = findings.filter((f) => f.action === 'move-back')

  return {
    id: 'orphan-config',
    title: t('checks.orphanTitle'),
    status: findings.length ? 'warn' : 'pass',
    summary: findings.length ? t('checks.orphanFound', { count: findings.length }) : t('checks.orphanNone'),
    detail: findings.length
      ? reunitable.length
        ? `${t('checks.orphanDetail')} ${t('checks.orphanReunite', { count: reunitable.length })}`
        : t('checks.orphanDetail')
      : undefined,
    items: findings.slice(0, 12).map((f) =>
      f.action === 'move-back'
        ? t('checks.orphanItemMoveBack', {
            config: f.config,
            plugin: f.plugin ?? '',
            folder: orphanPluginFolder(f),
            where: asiRelativeOf(game).replace(/\//g, '\\') || '.'
          })
        : t('checks.orphanItemNoPlugin', { config: f.config, plugin: `${f.stem}.asi` })
    )
  }
}

/** Where the detected ASI directory sits, relative to the game folder. */
function asiRelativeOf(game: GameInstall): string {
  const dir = game.asiDirectory ?? game.path
  return path.relative(game.path, dir).split(path.sep).join('/')
}

/**
 * The orphans and, for each, where its plugin actually went.
 *
 * Shared by the check and by the fix it offers, so the two can never describe
 * different files. Every recorded path is carried with the install and profile
 * that owns it: the fix rewrites rows, and a row is owned by an install, never
 * by a path that several profiles can spell identically.
 */
export async function orphanFindings(game: GameInstall, profileId: number | null): Promise<OrphanFinding[]> {
  const dir = game.asiDirectory ?? game.path
  if (!game.supportsAsi || !exists(dir)) return []
  const entries: string[] = await fsp.readdir(dir).catch(() => [])
  type TrackedRow = { relative_path: string; install_id: number; profile_id: number }
  const select = `SELECT f.relative_path, f.install_id, i.profile_id FROM install_file f
                    JOIN install i ON i.id = f.install_id`
  const tracked = (
    profileId === null
      ? (getDb().prepare(select).all() as TrackedRow[])
      : (getDb().prepare(`${select} WHERE i.profile_id = ?`).all(profileId) as TrackedRow[])
  ).map((r) => ({ relativePath: r.relative_path, installId: r.install_id, profileId: r.profile_id }))
  return findOrphanConfigs({ entries, asiRelative: asiRelativeOf(game), tracked })
}

/**
 * Puts an orphan's plugin back in the ASI directory - or, when no plugin
 * exists anywhere, puts the stray config in quarantine.
 *
 * NOTHING IS DELETED. A plugin is MOVED, and the records that name its old path
 * are rewritten in the same transaction so the database still describes the
 * disk. A config with no plugin is MOVED to the quarantine folder, which is
 * never cleared on its own, so a config that turns out to matter is one copy
 * away.
 *
 * A plugin sitting inside a junctioned mod folder is refused, not moved: that
 * folder IS Modão's content store, and moving a file out of it would take the
 * only copy with it. The user is told where it is and left to decide.
 *
 * THE REWRITE IS SCOPED TO THE INSTALLS THAT OWN THE PATH, never to the path
 * alone. The same mod in two profiles gives two sets of rows spelling the same
 * relative_path, and `UPDATE ... WHERE relative_path = ?` would rewrite the
 * other profile's copy to a layout its own store has no file at - that install
 * then never materialises and reads as unresolved, with no way back but a
 * reinstall. And when the owning rows span MORE THAN ONE PROFILE the single
 * file on disk cannot be attributed to any of them, so the move is refused
 * outright rather than guessed. That is the usual state with `profileId ===
 * null`, where the findings are drawn from every install in the database.
 */
export async function reuniteOrphans(profileId: number | null): Promise<{ moved: string[]; quarantined: string[]; refused: string[] }> {
  const game = requireActiveGame()
  const asiDir = game.asiDirectory ?? game.path
  const db = getDb()
  const moved: string[] = []
  const quarantined: string[] = []
  const refused: string[] = []

  for (const f of await orphanFindings(game, profileId)) {
    if (f.action === 'no-plugin') {
      const from = path.join(asiDir, f.config)
      if (!exists(from)) continue
      const to = path.join(Paths.quarantine(), 'orphan-config', timestampSlug(), f.config)
      await moveSafe(from, to)
      quarantined.push(`${f.config} → ${to}`)
      continue
    }
    const from = path.join(game.path, f.pluginPath!.replace(/\//g, path.sep))
    const to = path.join(asiDir, f.plugin!)
    if (!exists(from)) {
      refused.push(`${f.plugin} is on record at ${f.pluginPath} but is not there any more`)
      continue
    }
    if (exists(to)) {
      refused.push(`${f.plugin} is already in the ASI directory; the records say it is also at ${f.pluginPath}`)
      continue
    }
    const modFolder = /^modloader\/([^/]+)\//.exec(f.pluginPath!)?.[1]
    if (modFolder && isLink(path.join(game.path, 'modloader', modFolder))) {
      refused.push(
        `${f.plugin} is inside modloader\\${modFolder}\\, which is a link into Modão's content store. ` +
          'Moving it out would take the only copy; move it by hand if that is what you want.'
      )
      continue
    }
    // Nothing moves until the rows that describe it can be named.
    const ownerIds = f.owners.map((o) => o.installId)
    if (ownerIds.length === 0) {
      refused.push(t('checks.orphanRefusedUnowned', { plugin: f.plugin!, path: f.pluginPath!.replace(/\//g, '\\') }))
      continue
    }
    const owningProfiles = orphanOwningProfiles(f)
    if (owningProfiles.length > 1) {
      refused.push(t('checks.orphanRefusedShared', { plugin: f.plugin!, count: String(owningProfiles.length) }))
      continue
    }
    await moveSafe(from, to)
    const newRel = path.relative(game.path, to).split(path.sep).join('/')
    const scope = ownerIds.map(() => '?').join(',')
    db.transaction(() => {
      db.prepare(
        `UPDATE install_file SET relative_path = ? WHERE relative_path = ? AND install_id IN (${scope})`
      ).run(newRel, f.pluginPath, ...ownerIds)
      db.prepare(`UPDATE provides SET relative_path = ? WHERE relative_path = ? AND install_id IN (${scope})`).run(
        providesKey(newRel),
        providesKey(f.pluginPath!),
        ...ownerIds
      )
    })()
    moved.push(`${f.pluginPath} → ${newRel}`)
  }
  return { moved, quarantined, refused }
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
