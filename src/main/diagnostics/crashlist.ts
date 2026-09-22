import path from 'node:path'
import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import type { CrashListEntry } from '@shared/types'
import { Paths } from '../util/paths'
import { exists } from '../util/fsx'
import { IMAGE_BASE, normalizeAddress } from '@shared/crash'

export { IMAGE_BASE, normalizeAddress, parseModuleName, resolveCrashAddress } from '@shared/crash'

let cache: Map<string, CrashListEntry> | null = null

/**
 * CrashList.txt is the community database shipped with CrashInfo. It is
 * pt-BR and Windows-1252. Bundled here so a crash can be diagnosed offline.
 */
export async function loadCrashList(force = false): Promise<Map<string, CrashListEntry>> {
  if (cache && !force) return cache
  const file = path.join(Paths.resources(), 'CrashList.txt')
  const map = new Map<string, CrashListEntry>()
  if (!exists(file)) {
    cache = map
    return map
  }
  const text = iconv.decode(await fsp.readFile(file), 'win1252')
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const m = /^(?:0x)?([0-9A-Fa-f]{6,8})\s*[=:\-\t]\s*(.+)$/.exec(line)
    if (!m) continue
    const [causeRaw, solution] = m[2].split('|').map((s) => s.trim())
    map.set(normalizeAddress(m[1]), { address: normalizeAddress(m[1]), cause: causeRaw, solution: solution || undefined })
  }
  cache = map
  return map
}

export function addressFromOffset(faultOffset: string | number): string {
  const off = typeof faultOffset === 'number' ? faultOffset : Number.parseInt(String(faultOffset).replace(/^0x/i, ''), 16)
  return normalizeAddress(IMAGE_BASE + off)
}

export interface CrashMatch {
  address: string
  cause: string | null
  solution: string | null
  nearest?: { address: string; cause: string; distance: number }
}

/**
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
