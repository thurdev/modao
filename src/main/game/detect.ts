import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { GameInstall, LinkStrategy } from '@shared/types'
import { GAME_ORDER, gameDefinition, type GameKind } from '@shared/games'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { exists, isDirectory, sameVolume, sha256File } from '../util/fsx'
import { checkGameExe, readFixedFileVersion, readPe } from './pe'
import { probeWriteAccess } from './access'

/** A folder on disk that holds one of the games Modão knows about. */
export interface GameCandidate {
  path: string
  kind: GameKind
  name: string
}

/** The executable that proves a folder is this game, if it is there. */
function exeIn(gamePath: string, kind: GameKind): string | null {
  for (const name of gameDefinition(kind).exeNames) {
    const p = path.join(gamePath, name)
    if (exists(p)) return p
  }
  return null
}

/** Which game lives in this folder, or null if none of them does. */
export function identifyGame(gamePath: string): GameKind | null {
  // Definitive Edition first: its folder also contains none of the classic
  // executables, but checking the most specific layout first keeps the answer
  // stable if a user ever puts them side by side.
  for (const kind of ['sade', 'sa', 'iii', 'vc'] as GameKind[]) {
    if (exeIn(gamePath, kind)) return kind
  }
  return null
}

/** Candidate game folders found on disk. Never auto-adopted - the user picks. */
export async function detectCandidates(): Promise<GameCandidate[]> {
  const found = new Map<string, GameCandidate>()
  const add = (p: string): void => {
    const kind = identifyGame(p)
    if (kind && !found.has(p.toLowerCase())) {
      found.set(p.toLowerCase(), { path: p, kind, name: gameDefinition(kind).name })
    }
  }

  for (const kind of GAME_ORDER) {
    for (const root of gameDefinition(kind).commonRoots) add(root)
  }

  // Steam libraries declared in libraryfolders.vdf
  const vdf = 'C:\\Program Files (x86)\\Steam\\steamapps\\libraryfolders.vdf'
  if (exists(vdf)) {
    const text = await fsp.readFile(vdf, 'utf8').catch(() => '')
    const steamFolders = [
      'Grand Theft Auto San Andreas',
      'Grand Theft Auto 3',
      'Grand Theft Auto Vice City',
      'GTA San Andreas - Definitive'
    ]
    for (const m of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      const base = m[1].replace(/\\\\/g, '\\')
      for (const folder of steamFolders) add(path.join(base, 'steamapps', 'common', folder))
    }
  }
  return [...found.values()]
}

/**
 * ASI plugins load either from the game root or from scripts\, depending on
 * which loader the install uses. Rather than assuming, find where
 * modloader.asi actually lives and treat that directory as the ASI directory.
 */
export function detectAsiDirectory(gamePath: string): { dir: string | null; loader: string | null; evidence: string } {
  const candidates = [gamePath, path.join(gamePath, 'scripts')]
  for (const dir of candidates) {
    if (exists(path.join(dir, 'modloader.asi'))) {
      return { dir, loader: findAsiLoader(gamePath), evidence: `modloader.asi found in ${rel(gamePath, dir)}` }
    }
  }
  // No Mod Loader yet: fall back to wherever other .asi files already live.
  for (const dir of candidates) {
    if (isDirectory(dir) && fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.asi'))) {
      return { dir, loader: findAsiLoader(gamePath), evidence: `other .asi plugins found in ${rel(gamePath, dir)}` }
    }
  }
  const loader = findAsiLoader(gamePath)
  if (loader) {
    // Ultimate ASI Loader as vorbisFile/dinput8 loads from both root and scripts.
    return { dir: gamePath, loader, evidence: `ASI loader ${path.basename(loader)} present; defaulting to game root` }
  }
  return { dir: null, loader: null, evidence: 'no ASI loader detected' }
}

const ASI_LOADERS = ['vorbisFile.dll', 'vorbishooked.dll', 'dinput8.dll', 'dsound.dll', 'silent_asi_loader.asi', 'III.VC.SA.LimitAdjuster.asi']

function findAsiLoader(gamePath: string): string | null {
  for (const name of ASI_LOADERS) {
    const p = path.join(gamePath, name)
    if (exists(p)) return p
  }
  return null
}

function rel(base: string, p: string): string {
  const r = path.relative(base, p)
  return r === '' ? '<game root>' : r
}

export async function detectCleoVersion(gamePath: string): Promise<string | null> {
  const cleoDll = path.join(gamePath, 'cleo.asi')
  if (!exists(cleoDll)) return null
  const v = await readFixedFileVersion(cleoDll)
  if (v) return v.replace(/\.0+$/, '')
  const pe = await readPe(cleoDll).catch(() => null)
  return pe ? `unknown (PE ${pe.timestampIso.slice(0, 10)})` : 'unknown'
}

export async function detectModLoaderVersion(gamePath: string): Promise<string | null> {
  const asi = [path.join(gamePath, 'modloader.asi'), path.join(gamePath, 'scripts', 'modloader.asi')].find(exists)
  if (!asi) return null
  return (await readFixedFileVersion(asi)) ?? 'unknown'
}

export interface GameRow {
  id: number
  path: string
  label: string
  kind: string
  exe_size: number
  exe_sha256: string
  exe_timestamp: number
  large_address_aware: number
  asi_directory: string | null
  asi_loader: string | null
  modloader_version: string | null
  cleo_version: string | null
  is_active: number
}

export async function addGame(gamePath: string, label?: string, expected?: GameKind): Promise<GameInstall> {
  const kind = expected ?? identifyGame(gamePath)
  if (!kind) {
    throw new Error(
      `No GTA executable in ${gamePath}. Modão looks for ${GAME_ORDER.map((k) => gameDefinition(k).exeNames[0]).join(', ')}.`
    )
  }
  const def = gameDefinition(kind)
  const exe = exeIn(gamePath, kind)!
  // Only San Andreas has a known-good stock executable to compare against; for
  // the others the PE is read for what it says, not judged against a hash.
  const verdict = await checkGameExe(exe)
  const asi = def.supportsAsi ? detectAsiDirectory(gamePath) : { dir: null, loader: null, evidence: 'not applicable' }
  const db = getDb()
  const existing = db.prepare('SELECT id FROM game_install WHERE path = ?').get(gamePath) as { id: number } | undefined
  const values = {
    path: gamePath,
    kind,
    label: label ?? def.name,
    exe_size: verdict.pe.sizeBytes,
    exe_sha256: verdict.pe.sha256,
    exe_timestamp: verdict.pe.timestamp,
    large_address_aware: verdict.largeAddressAware ? 1 : 0,
    asi_directory: asi.dir,
    asi_loader: asi.loader,
    modloader_version: def.supportsModLoader ? await detectModLoaderVersion(gamePath) : null,
    cleo_version: def.supportsCleo ? await detectCleoVersion(gamePath) : null
  }
  if (existing) {
    db.prepare(
      `UPDATE game_install SET label=@label, kind=@kind, exe_size=@exe_size, exe_sha256=@exe_sha256,
       exe_timestamp=@exe_timestamp, large_address_aware=@large_address_aware,
       asi_directory=@asi_directory, asi_loader=@asi_loader, modloader_version=@modloader_version,
       cleo_version=@cleo_version WHERE path=@path`
    ).run(values)
  } else {
    db.prepare(
      `INSERT INTO game_install (path,label,kind,exe_size,exe_sha256,exe_timestamp,large_address_aware,
        asi_directory,asi_loader,modloader_version,cleo_version,adopted_at,is_active)
       VALUES (@path,@label,@kind,@exe_size,@exe_sha256,@exe_timestamp,@large_address_aware,
        @asi_directory,@asi_loader,@modloader_version,@cleo_version,@adopted_at,0)`
    ).run({ ...values, adopted_at: new Date().toISOString() })
  }
  const count = db.prepare('SELECT COUNT(*) c FROM game_install').get() as { c: number }
  const row = db.prepare('SELECT * FROM game_install WHERE path = ?').get(gamePath) as GameRow
  if (count.c === 1) setActiveGame(row.id)
  return toGameInstall(row)
}

/**
 * Switches the active install. The clear-then-set pair has to be all or
 * nothing: clearing first and then matching no row would leave the app with no
 * active game at all, and every path that needs one would fail far from here
 * with a message about a missing game folder rather than a stale id.
 */
export function setActiveGame(id: number): void {
  const db = getDb()
  const row = db.prepare('SELECT id FROM game_install WHERE id = ?').get(id) as { id: number } | undefined
  if (!row) throw new Error(`No game install #${id}. Add your GTA: San Andreas folder again.`)
  db.transaction(() => {
    db.prepare('UPDATE game_install SET is_active = 0').run()
    db.prepare('UPDATE game_install SET is_active = 1 WHERE id = ?').run(id)
  })()
}

export function listGames(): GameInstall[] {
  return (getDb().prepare('SELECT * FROM game_install ORDER BY id').all() as GameRow[]).map(toGameInstall)
}

export function activeGame(): GameInstall | null {
  const row = getDb().prepare('SELECT * FROM game_install WHERE is_active = 1').get() as GameRow | undefined
  return row ? toGameInstall(row) : null
}

export function requireActiveGame(): GameInstall {
  const g = activeGame()
  if (!g) throw new Error('No game folder selected. Add a GTA install first.')
  return g
}

/**
 * Where an install is and which game it is, and nothing else.
 *
 * `toGameInstall` below runs a write-access probe, and that probe creates a
 * file inside modloader\ - the folder Mod Loader watches. Anything that needs
 * to know about an install *before* deciding whether writing to it is safe has
 * to read it without that probe, or the check would trigger the very write it
 * exists to prevent. With no id, the active install.
 */
export function gameTarget(id?: number): { id: number; path: string; kind: GameKind } | null {
  const db = getDb()
  const row = (
    id === undefined
      ? db.prepare('SELECT id, path, kind FROM game_install WHERE is_active = 1').get()
      : db.prepare('SELECT id, path, kind FROM game_install WHERE id = ?').get(id)
  ) as { id: number; path: string; kind: string } | undefined
  return row ? { id: row.id, path: row.path, kind: gameDefinition(row.kind).kind } : null
}

export function toGameInstall(row: GameRow): GameInstall {
  const store = Paths.store()
  const same = sameVolume(store, row.path)
  const strategy: LinkStrategy = same ? 'hardlink' : 'junction'
  const def = gameDefinition(row.kind)
  return {
    id: row.id,
    path: row.path,
    label: row.label,
    kind: def.kind,
    gameName: def.name,
    supportsModLoader: def.supportsModLoader,
    supportsCleo: def.supportsCleo,
    supportsAsi: def.supportsAsi,
    pakDir: def.pakDir ? path.join(row.path, def.pakDir) : null,
    hasCrashList: def.hasCrashList,
    exeSize: row.exe_size,
    exeSha256: row.exe_sha256,
    exeTimestamp: row.exe_timestamp,
    isV1UsOriginal: def.kind === 'sa' && row.exe_size === 14_383_616 && row.exe_timestamp === 0x427101ca,
    largeAddressAware: !!row.large_address_aware,
    asiDirectory: row.asi_directory,
    asiLoader: row.asi_loader,
    hasModLoader: !!row.modloader_version || exists(path.join(row.path, 'modloader')),
    modLoaderVersion: row.modloader_version,
    cleoVersion: row.cleo_version,
    userFilesDir: Paths.userFiles(def.kind),
    sameVolumeAsStore: same,
    linkStrategy: strategy,
    access: probeWriteAccess(row.path)
  }
}

export function modloaderDir(game: GameInstall): string {
  return path.join(game.path, 'modloader')
}

export function cleoDir(game: GameInstall): string {
  return path.join(game.path, 'cleo')
}

export function asiDir(game: GameInstall): string {
  return game.asiDirectory ?? game.path
}

export async function gameExeSha(game: GameInstall): Promise<string> {
  const exe = exeIn(game.path, game.kind)
  if (!exe) throw new Error(`The executable for ${game.gameName} is no longer in ${game.path}.`)
  return sha256File(exe)
}
