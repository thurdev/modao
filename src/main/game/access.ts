import { t } from '../util/i18n'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { WriteAccess } from '@shared/types'
import type { GameKind } from '@shared/games'
import { checkGameRunning, lastKnownGameRunning, type ProcessLister } from './running'

/**
 * Can Modão actually write into this game folder?
 *
 * Repacks land in C:\Program Files (x86)\... more often than not, and Windows
 * denies writes there to a normal process. Every mutating operation - linking a
 * profile in, writing modloader.ini, uninstalling - would otherwise fail
 * half-way with a raw EPERM naming some file deep inside the folder, which
 * tells the user nothing. So the answer is established once, up front, by
 * actually writing a probe file rather than by guessing from the path.
 */
const cache = new Map<string, { at: number; result: WriteAccess }>()
const TTL_MS = 15_000

export function probeWriteAccess(gamePath: string, force = false): WriteAccess {
  const key = gamePath.toLowerCase()
  const hit = cache.get(key)
  if (!force && hit && Date.now() - hit.at < TTL_MS) return hit.result

  // The probe writes a file into modloader\, which Mod Loader watches and
  // hot-reloads. With the game up that is the hazard this whole check exists to
  // avoid, so nothing is written: the previous answer stands, or none does.
  // `force` does not override it - a forced probe is still a write.
  if (lastKnownGameRunning(gamePath) === true) return hit?.result ?? unknownAccess(gamePath)

  const result = probe(gamePath)
  cache.set(key, { at: Date.now(), result })
  return result
}

/**
 * Write access as far as it is known, without writing anything: whatever the
 * last probe said, or null if there has never been one.
 */
export function cachedWriteAccess(gamePath: string): WriteAccess | null {
  const hit = cache.get(gamePath.toLowerCase())
  return hit ? hit.result : null
}

/**
 * What a caller is told when the game is up and nothing was ever probed.
 *
 * Nothing is claimed and nothing is complained about: the only code that acts
 * on `writable` is `requireWritableGame()`, which never runs without the
 * running check in front of it, and the screens that read this render a banner
 * only when there is a problem to name.
 */
function unknownAccess(gamePath: string): WriteAccess {
  return { writable: true, probedPath: gamePath, code: null, reason: null, needsElevation: false }
}

/**
 * Write access for a game that may be running, established without disturbing
 * it. Returns null when the game is up and no earlier probe is on record -
 * "not known", which is the honest answer and the one that writes nothing.
 */
export async function writeAccessUnlessGameRunning(
  game: { path: string; kind: GameKind },
  lister?: ProcessLister
): Promise<WriteAccess | null> {
  const verdict = await checkGameRunning(game, lister)
  if (!verdict.allowed) return cachedWriteAccess(game.path)
  return probeWriteAccess(game.path)
}

export function forgetWriteAccess(gamePath?: string): void {
  if (gamePath) cache.delete(gamePath.toLowerCase())
  else cache.clear()
}

function probe(gamePath: string): WriteAccess {
  // modloader\ is where the real work happens, so probe there when it exists.
  const target = fs.existsSync(path.join(gamePath, 'modloader')) ? path.join(gamePath, 'modloader') : gamePath
  const file = path.join(target, `.modao-write-probe-${crypto.randomBytes(4).toString('hex')}`)
  try {
    fs.writeFileSync(file, 'probe')
    fs.unlinkSync(file)
    return { writable: true, probedPath: target, code: null, reason: null, needsElevation: false }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN'
    return {
      writable: false,
      probedPath: target,
      code,
      reason: explain(code, target),
      needsElevation: code === 'EPERM' || code === 'EACCES'
    }
  }
}

const PROTECTED_ROOTS = ['c:\\program files', 'c:\\program files (x86)', 'c:\\windows']

export function isProtectedLocation(p: string): boolean {
  const lower = p.toLowerCase()
  return PROTECTED_ROOTS.some((root) => lower.startsWith(root))
}

function explain(code: string, target: string): string {
  if (code === 'EPERM' || code === 'EACCES') {
    if (isProtectedLocation(target)) {
      return (
        `Windows denies writes to ${target} because it sits inside Program Files. ` +
        'Restart Modão as administrator, or move the game to a folder outside Program Files - ' +
        'the second option is the one the modding scene recommends, since the game itself hits the same wall.'
      )
    }
    return (
      `Windows denied write access to ${target}. The folder may be read-only, owned by another user, ` +
      'or locked by antivirus or a running copy of the game.'
    )
  }
  if (code === 'EBUSY') return `${target} is locked by another process - close the game and try again.`
  if (code === 'ENOENT') return `${target} no longer exists.`
  if (code === 'EROFS') return `${target} is on a read-only volume.`
  return `Could not write to ${target} (${code}).`
}

/**
 * Turns a raw filesystem error into something a person can act on, keeping the
 * original message at the end so nothing is hidden from a bug report.
 */
export function describeFsError(error: unknown, gamePath?: string): string {
  const err = error as NodeJS.ErrnoException
  const code = err?.code
  if (!code) return err?.message ?? String(error)
  const where = err.path ?? gamePath ?? t('access.theGameFolder')

  if (code === 'EPERM' || code === 'EACCES') {
    const fix = isProtectedLocation(where) ? t('access.fixProgramFiles') : t('access.fixReadOnly')
    return `${t('access.notAllowed', { path: where })} ${fix} (${code}: ${err.message})`
  }
  if (code === 'EBUSY') return `${t('access.busy', { path: where })} (${code})`
  if (code === 'ENOSPC') return `${t('access.diskFull', { path: where })} (${code})`
  if (code === 'ENOENT') return `${t('access.missing', { path: where })} (${code})`
  return err.message
}
