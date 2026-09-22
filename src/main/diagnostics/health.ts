import path from 'node:path'
import type { HealthCheck, HealthReport, TxdAnalysis } from '@shared/types'
import { getDb } from '../db'
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
    const verdict = await checkGameExe(path.join(game.path, 'gta_sa.exe'))
    checks.push({
      id: 'exe',
      title: 'Game executable',
      status: verdict.isV1UsOriginal ? 'pass' : 'warn',
      summary: verdict.isV1UsOriginal
        ? 'v1.0 US, unmodified (14,383,616 bytes, PE timestamp 0x427101CA)'
        : 'Not a stock v1.0 US executable',
      detail: verdict.summary,
      items: [
        `Size: ${verdict.pe.sizeBytes.toLocaleString()} bytes (v1.0 US is 14,383,616)`,
        `PE timestamp: 0x${verdict.pe.timestamp.toString(16).toUpperCase()} (v1.0 US is 0x427101CA)`,
        `SHA-256: ${verdict.pe.sha256.slice(0, 32)}...`
      ]
    })
    checks.push({
      id: 'laa',
      title: 'LARGE_ADDRESS_AWARE',
      status: verdict.largeAddressAware ? 'pass' : 'warn',
      summary: verdict.largeAddressAware
        ? 'Set - the game can address up to 4 GB'
        : 'Not set - the game is limited to 2 GB, which large texture packs exhaust',
      detail: `PE Characteristics word: 0x${verdict.pe.characteristics.toString(16).padStart(4, '0')} (LAA is bit 0x0020). Modão never patches the executable; use an external patcher if you want this changed.`
    })
  } catch (e) {
    checks.push({ id: 'exe', title: 'Game executable', status: 'fail', summary: (e as Error).message })
  }

  // 2. Write access - nothing else matters if the folder is read-only
  const access = probeWriteAccess(game.path, true)
  checks.push({
    id: 'write-access',
    title: 'Write access to the game folder',
    status: access.writable ? 'pass' : 'fail',
    summary: access.writable
      ? `Modão can write to ${access.probedPath}`
      : `Windows denies writes to ${access.probedPath}${access.code ? ` (${access.code})` : ''}`,
    detail: access.reason ?? undefined
  })

  // 3. Mod Loader and the ASI directory
  checks.push({
    id: 'modloader',
    title: 'Mod Loader',
    status: game.hasModLoader ? 'pass' : 'fail',
    summary: game.hasModLoader ? `Installed${game.modLoaderVersion ? ` (${game.modLoaderVersion})` : ''}` : 'Not installed',
    detail: game.hasModLoader ? undefined : 'Without Mod Loader nothing in modloader\\ is loaded by the game.'
  })
  checks.push({
    id: 'asi',
    title: 'ASI loader and directory',
    status: game.asiLoader ? 'pass' : 'warn',
    summary: game.asiLoader
      ? `${path.basename(game.asiLoader)} present; .asi plugins load from ${asiLabel(game.path, game.asiDirectory)}`
      : 'No ASI loader found - .asi plugins will not load',
    detail:
      'The ASI directory is detected from where modloader.asi actually lives rather than assumed: some installs load from the game root, repacks often load from scripts\\.'
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
      title: 'CLEO+ version gate',
      status: major >= 4.4 ? 'pass' : 'fail',
      summary: major >= 4.4 ? `CLEO ${cleoVersion} satisfies CLEO+` : `CLEO+ is installed but CLEO ${cleoVersion ?? 'unknown'} is too old`,
      detail:
        major >= 4.4
          ? undefined
          : 'CLEO+ against CLEO 4.3 fails at startup with a fatal dialog: "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo". Update CLEO to 4.4 or newer.'
    })
  } else {
    checks.push({
      id: 'cleo',
      title: 'CLEO',
      status: cleoVersion ? 'pass' : 'skip',
      summary: cleoVersion ? `CLEO ${cleoVersion} detected, ${cleoPlugins.length} file(s) in cleo\\` : 'CLEO not installed',
      detail: cleoPlugins.length ? cleoPlugins.slice(0, 8).map((p) => p.relative_path).join(', ') : undefined
    })
  }

  // 4. Dependencies
  const depProblems = profileDependencyProblems(profileId, game)
  checks.push({
    id: 'dependencies',
    title: 'Dependencies',
    status: depProblems.some((d) => d.resolution === 'blocking') ? 'fail' : depProblems.length ? 'warn' : 'pass',
    summary: depProblems.length === 0 ? 'Every requirement is satisfied' : `${depProblems.length} unresolved`,
    items: depProblems.map((d) => `${d.kind === 'conflicts' ? 'Conflict' : 'Missing'}: ${d.title}${d.note ? ` - ${d.note}` : ''}`)
  })

  // 5. File conflicts
  const conflicts = listConflicts(profileId)
  const unresolved = conflicts.filter((c) => !c.winner)
  checks.push({
    id: 'conflicts',
    title: 'File conflicts',
    status: unresolved.length ? 'warn' : conflicts.length ? 'pass' : 'pass',
    summary:
      conflicts.length === 0
        ? 'No duplicated files between mods'
        : `${conflicts.length} duplicated path(s); ${conflicts.length - unresolved.length} resolved by priority`,
    items: conflicts.slice(0, 10).map((c) => `${c.relativePath} -> ${c.winner ? `${c.winner.title} wins (priority ${c.winner.priority})` : 'no winner: every claimant is disabled or priority 0'}`)
  })

  // 6. Textures
  const textureProblems = await scanTextures(profileId)
  checks.push({
    id: 'textures',
    title: 'Texture dimensions',
    status: textureProblems.npot.length ? 'warn' : 'pass',
    summary: textureProblems.npot.length
      ? `${textureProblems.npot.length} non-power-of-two texture(s) across ${textureProblems.scanned} .txd file(s)`
      : `${textureProblems.scanned} .txd file(s) scanned, all dimensions are powers of two`,
    detail: textureProblems.npot.length
      ? 'Non-power-of-two textures are a documented cause of crashes (0x00749B7B) and of textures failing to render.'
      : undefined,
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
  if (!asiDir) return 'unknown'
  const rel = path.relative(gamePath, asiDir)
  return rel === '' ? 'the game root' : `${rel}\\`
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
    title: 'Asset size',
    status: big.length ? 'warn' : 'pass',
    summary: `${(total / 1024 ** 3).toFixed(2)} GB of enabled mods`,
    detail: big.length
      ? 'Large packs plus a 2 GB address space is the usual cause of out-of-memory crashes mid-game.'
      : undefined,
    items: big
  }
}
