import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gameDefinition, type GameKind } from '@shared/games'
import { t } from '../util/i18n'

/**
 * Is the game open right now?
 *
 * Mod Loader installs a filesystem watcher on modloader\ and hot-reloads what
 * changes underneath it. Installing, uninstalling or switching a profile while
 * the game is live therefore does not fail with a lock error - it succeeds, the
 * game reloads mid-session, and it crashes (CrashList 0x007F3825, a texture
 * being unloaded while something still points at it). The write-access probe
 * next door cannot see this: a running gta_sa.exe does not lock the folder.
 *
 * So the answer has to come from the process table. The decision is kept apart
 * from the machinery that reads it: `gameRunningVerdict` is pure and takes the
 * process list as an argument, and only `listWindowsProcesses` shells out. That
 * split is what makes "a gta_sa.exe from somebody else's install is not this
 * install" testable without a game on disk.
 */

const execFileAsync = promisify(execFile)

/** One entry of the machine's process table, reduced to what the verdict needs. */
export interface RunningProcess {
  /** Image name as Windows reports it, e.g. `gta_sa.exe`. */
  name: string
  pid: number
  /**
   * Full path of the running image, or null when Windows would not say -
   * `tasklist` never reports it, and `Get-Process` withholds it for a process
   * running at a higher integrity level than Modão.
   */
  imagePath: string | null
}

export interface GameRunningVerdict {
  /** False means: refuse the write. */
  allowed: boolean
  /** The process the refusal is about, when there is one. */
  process: RunningProcess | null
  /** Its executable name, for the message the user reads. */
  exe: string | null
  /**
   * True when the refusal rests on a name match that could not be placed on
   * disk. Fail-closed: an unplaceable `gta_sa.exe` is treated as this game,
   * because the cost of being wrong is a corrupted install, not a lost click.
   */
  assumed: boolean
}

const ALLOWED: GameRunningVerdict = { allowed: true, process: null, exe: null, assumed: false }

/**
 * The executables that mean "this game is open", lowercased and stripped of any
 * folder. SA:DE declares its exe as `Gameface\Binaries\Win64\SanAndreas.exe`;
 * the process table only ever reports the last segment.
 */
export function gameExeNames(kind: GameKind): string[] {
  const names = gameDefinition(kind).exeNames.map((name) => path.win32.basename(name).toLowerCase())
  return [...new Set(names)]
}

/** Lowercased, backslash-separated, no trailing separator - comparable as text. */
function normalize(p: string): string {
  return p
    .trim()
    .replace(/^\\\\\?\\/, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase()
}

/** Is this file inside that folder? Prefix match on whole segments only. */
function isInside(root: string, file: string): boolean {
  if (!root) return false
  return file.startsWith(`${root}\\`)
}

/**
 * The whole decision, as a function of the process table.
 *
 * A process only counts when it is *this* install: a second copy of San Andreas
 * under another folder, or a friend's portable build, is somebody else's problem
 * and must not block a write here. The image path is what settles it; when
 * Windows withholds the path the name alone has to do, and the answer then errs
 * towards refusing.
 */
export function gameRunningVerdict(
  game: { path: string; kind: GameKind },
  processes: readonly RunningProcess[] | null | undefined
): GameRunningVerdict {
  const wanted = new Set(gameExeNames(game.kind))
  const root = normalize(game.path ?? '')
  let unplaceable: RunningProcess | null = null

  for (const proc of processes ?? []) {
    const raw = typeof proc?.name === 'string' ? proc.name : ''
    const name = path.win32.basename(raw).toLowerCase()
    if (!name || !wanted.has(name)) continue

    if (!proc.imagePath) {
      unplaceable ??= { ...proc, name }
      continue
    }
    if (isInside(root, normalize(proc.imagePath))) {
      return { allowed: false, process: { ...proc, name }, exe: name, assumed: false }
    }
    // Same name, another folder: not this install. Deliberately not a refusal.
  }

  if (unplaceable) return { allowed: false, process: unplaceable, exe: unplaceable.name, assumed: true }
  return ALLOWED
}

/** Reads the process table. The only part of this module that shells out. */
export type ProcessLister = (exeNames: string[]) => Promise<RunningProcess[]>

/**
 * PowerShell first, because it is the only one of the two that reports the
 * image path, and the path is what keeps another install's gta_sa.exe from
 * blocking this one. `tasklist` is the fallback for machines where PowerShell
 * is locked down; it answers with names only, which lands in the `assumed`
 * branch of the verdict.
 */
export const listWindowsProcesses: ProcessLister = async (exeNames) => {
  if (process.platform !== 'win32') return []
  if (exeNames.length === 0) return []

  const viaPowerShell = await powerShellProcesses(exeNames)
  if (viaPowerShell) return viaPowerShell
  return tasklistProcesses(exeNames)
}

/** null means "could not ask"; an empty array means "asked, nothing running". */
async function powerShellProcesses(exeNames: string[]): Promise<RunningProcess[] | null> {
  // Get-Process wants the name without its extension.
  const bare = exeNames.map((n) => n.replace(/\.exe$/i, '').replace(/'/g, "''"))
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name ${bare.map((n) => `'${n}'`).join(',')} |
  Select-Object @{n='name';e={$_.ProcessName + '.exe'}},
                @{n='pid';e={$_.Id}},
                @{n='imagePath';e={$_.Path}} |
  ConvertTo-Json -Depth 2 -Compress
`
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    )
    const text = stdout.trim()
    if (!text) return []
    const parsed = JSON.parse(text) as unknown
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows.flatMap((row) => {
      const r = row as { name?: unknown; pid?: unknown; imagePath?: unknown }
      if (typeof r?.name !== 'string') return []
      return [
        {
          name: r.name,
          pid: typeof r.pid === 'number' ? r.pid : 0,
          imagePath: typeof r.imagePath === 'string' && r.imagePath.trim() ? r.imagePath : null
        }
      ]
    })
  } catch {
    return null
  }
}

async function tasklistProcesses(exeNames: string[]): Promise<RunningProcess[]> {
  const out: RunningProcess[] = []
  for (const name of exeNames) {
    const { stdout } = await execFileAsync('tasklist', ['/FO', 'CSV', '/NH', '/FI', `IMAGENAME eq ${name}`], {
      windowsHide: true
    }).catch(() => ({ stdout: '' }))
    for (const line of stdout.split(/\r?\n/)) {
      // "gta_sa.exe","1234","Console","1","23.456 K" - anything else is the
      // "INFO: No tasks are running..." notice, which is not CSV at all.
      const m = /^"([^"]+)","(\d+)"/.exec(line.trim())
      if (!m) continue
      if (m[1].toLowerCase() !== name.toLowerCase()) continue
      out.push({ name: m[1], pid: Number.parseInt(m[2], 10), imagePath: null })
    }
  }
  return out
}

/**
 * A burst of IPC calls (a conflict screen writing several priorities, a switch
 * that gates twice) must not spawn a PowerShell each. Two seconds is short
 * enough that a user who closes the game and clicks again is not told to close
 * it a second time.
 */
const CACHE_TTL_MS = 2_000
let cache: { at: number; key: string; processes: RunningProcess[] } | null = null

export function forgetRunningProcesses(): void {
  cache = null
}

async function processesFor(exeNames: string[], lister: ProcessLister): Promise<RunningProcess[]> {
  const key = exeNames.join('|')
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) return cache.processes
  const processes = await lister(exeNames)
  cache = { at: Date.now(), key, processes }
  return processes
}

/** The verdict for a game install, reading the live process table by default. */
export async function checkGameRunning(
  game: { path: string; kind: GameKind },
  lister: ProcessLister = listWindowsProcesses
): Promise<GameRunningVerdict> {
  const names = gameExeNames(game.kind)
  const processes = lister === listWindowsProcesses ? await processesFor(names, lister) : await lister(names)
  return gameRunningVerdict(game, processes)
}

/**
 * The hard refusal. Not a warning the user can click past: every mutating
 * entry point calls this first and nothing is touched when it throws.
 */
export async function assertGameNotRunning(
  game: { path: string; kind: GameKind },
  lister: ProcessLister = listWindowsProcesses
): Promise<void> {
  const verdict = await checkGameRunning(game, lister)
  if (verdict.allowed) return
  throw new Error(t('messages.access.gameRunning', { exe: verdict.exe ?? gameExeNames(game.kind)[0] }))
}
