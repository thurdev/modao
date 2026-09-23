import path from 'node:path'
import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import type { CrashListEntry } from '@shared/types'
import { Paths } from '../util/paths'
import { exists } from '../util/fsx'
import { normalizeAddress, resolveCrashAddress } from '@shared/crash'
import { parseCrashList } from '@shared/crashlist'

export { IMAGE_BASE, normalizeAddress, parseModuleName, resolveCrashAddress, describeAbsoluteAddress } from '@shared/crash'
export { parseCrashList, collectAddresses } from '@shared/crashlist'

let cache: Map<string, CrashListEntry> | null = null

/** The copy that ships with the app. Read-only: a refresh never writes here. */
export function bundledCrashListPath(): string {
  return path.join(Paths.resources(), 'CrashList.txt')
}

/**
 * A refreshed copy lives beside the database, not in the app folder: the app
 * folder is replaced wholesale by every update and is read-only once packaged.
 */
export function refreshedCrashListPath(): string {
  return path.join(Paths.userData(), 'CrashList.txt')
}

/** Whichever copy is actually in force - the refreshed one wins. */
export function crashListPath(): string {
  const refreshed = refreshedCrashListPath()
  return exists(refreshed) ? refreshed : bundledCrashListPath()
}

/**
 * CrashList.txt is the community database shipped with CrashInfo. It is
 * pt-BR and Windows-1252 - never UTF-8 - and is bundled so a crash can be
 * diagnosed with no network at all.
 */
export async function loadCrashList(force = false): Promise<Map<string, CrashListEntry>> {
  if (cache && !force) return cache
  const file = crashListPath()
  if (!exists(file)) {
    cache = new Map()
    return cache
  }
  cache = parseCrashList(iconv.decode(await fsp.readFile(file), 'win1252'))
  return cache
}

export interface CrashListRefresh {
  path: string
  entries: number
  replaced: boolean
  reason?: string
}

/**
 * Installs a newer CrashList over the bundled stub.
 *
 * The bytes are written through unchanged, because the file is Windows-1252
 * and re-encoding it would mangle every accent in it. A replacement that
 * parses to fewer entries than the copy already in force is refused: a 404
 * page or a truncated download would otherwise silently delete the only
 * offline diagnosis the app has.
 */
export async function installCrashList(data: Buffer): Promise<CrashListRefresh> {
  const current = await loadCrashList()
  const parsed = parseCrashList(iconv.decode(data, 'win1252'))
  if (parsed.size === 0 || parsed.size < current.size) {
    return {
      path: crashListPath(),
      entries: current.size,
      replaced: false,
      reason: `The downloaded list holds ${parsed.size} entries, fewer than the ${current.size} already installed, so it was not used.`
    }
  }
  const target = refreshedCrashListPath()
  await fsp.writeFile(target, data)
  cache = parsed
  return { path: target, entries: parsed.size, replaced: true }
}

/**
 * Fetches a CrashList from upstream and installs it. The URL is the caller's
 * to choose - nothing here guesses one - so the app can be pointed at whatever
 * the community publishes without shipping a new build.
 *
 * Nothing in the app calls this yet: there is no channel and no button, and the
 * bundled CrashList.txt no longer claims there is. What the user CAN do is the
 * manual half of the same path - drop a CrashList.txt beside the database and
 * `crashListPath()` prefers it - which is what the bundled file documents.
 */
export async function refreshCrashListFrom(url: string): Promise<CrashListRefresh> {
  const { request } = await import('undici')
  const res = await request(url, { maxRedirections: 3 })
  if (res.statusCode >= 400) {
    return {
      path: crashListPath(),
      entries: (await loadCrashList()).size,
      replaced: false,
      reason: `The download answered HTTP ${res.statusCode}.`
    }
  }
  return installCrashList(Buffer.from(await res.body.arrayBuffer()))
}

/**
 * A fault offset out of the Windows Event Log, as an absolute address.
 * Delegates rather than adding the image base itself: exactly one site in the
 * codebase performs that addition.
 */
export function addressFromOffset(faultOffset: string | number): string {
  const raw = typeof faultOffset === 'number' ? faultOffset.toString(16) : String(faultOffset)
  return resolveCrashAddress('gta_sa.exe', raw).display
}

export interface CrashMatch {
  address: string
  cause: string | null
  solution: string | null
  nearest?: { address: string; cause: string; distance: number }
}

/**
 * Looks one ABSOLUTE crash address up. The address is normalised here, so
 * "4c67bb", "0X004C67BB" and "004c67bb" are the same question.
 *
 * Exact match first, then the closest entry within 64 bytes: crash addresses
 * shift slightly between builds and repacks, and a near miss is still the
 * difference between a diagnosis and an evening of removing mods one by one.
 */
export async function lookup(address: string): Promise<CrashMatch> {
  const list = await loadCrashList()
  const key = normalizeAddress(address)
  const hit = list.get(key)
  if (hit) return { address: key, cause: hit.cause, solution: hit.solution ?? null }

  const target = Number.parseInt(key.replace('0x', ''), 16)
  let nearest: CrashMatch['nearest']
  for (const entry of list.values()) {
    const v = Number.parseInt(entry.address.replace('0x', ''), 16)
    const distance = Math.abs(v - target)
    if (distance <= 64 && (!nearest || distance < nearest.distance)) {
      nearest = { address: entry.address, cause: entry.cause, distance }
    }
  }
  return { address: key, cause: null, solution: null, nearest }
}

export async function crashListSize(): Promise<number> {
  return (await loadCrashList()).size
}
