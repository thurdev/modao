import { t } from '../util/i18n'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { WriteAccess } from '@shared/types'

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

  const result = probe(gamePath)
  cache.set(key, { at: Date.now(), result })
  return result
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
