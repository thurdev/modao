import path from 'node:path'
import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import { exists } from '../util/fsx'

/**
 * stream.ini is the streaming-memory setting Open Limit Adjuster and friends
 * read. Repacks ship it pre-tuned to numbers the game cannot survive.
 *
 * GTA SA is a 32-bit process: without LARGE_ADDRESS_AWARE it can address 2 GB
 * in total, and the streaming buffer is claimed up front. A repack that sets
 * 13500 MB crashes the moment the streamer touches GTA3.IMG - the fault lands
 * in CStreaming, writing to a null-ish address, which reads like a broken mod
 * and is not one.
 *
 * The file predates the app on a repack install, so it is never rewritten
 * silently: the health check explains it and offers a safe value with a backup.
 */
export const SAFE_STREAMING_MEMORY_MB = 2048
/** Above this, with no limit adjuster present, the game will not survive the first stream. */
export const RISKY_STREAMING_MEMORY_MB = 2048

export interface StreamIniReading {
  path: string
  exists: boolean
  /** Streaming memory in MB, as written. */
  memoryMb: number | null
  /** The key it was found under, since the name differs between adjusters. */
  key: string | null
  raw: string | null
}

const MEMORY_KEYS = /^(streaming ?memory|streammemory|memory|streaming ?mem)$/i

/** Where stream.ini can live: the game root, or beside the adjuster in modloader\. */
export function streamIniCandidates(gamePath: string): string[] {
  return [path.join(gamePath, 'stream.ini'), path.join(gamePath, 'modloader', 'stream.ini')]
}

export function parseStreamIni(text: string): { memoryMb: number | null; key: string | null } {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('[')) continue
    const m = /^([^=]+?)\s*=\s*([0-9]+)\s*$/.exec(line)
    if (!m) continue
    if (!MEMORY_KEYS.test(m[1].trim())) continue
    const value = Number.parseInt(m[2], 10)
    if (Number.isFinite(value)) return { memoryMb: value, key: m[1].trim() }
  }
  return { memoryMb: null, key: null }
}

export async function readStreamIni(gamePath: string): Promise<StreamIniReading> {
  const file = streamIniCandidates(gamePath).find(exists)
  if (!file) {
    return { path: streamIniCandidates(gamePath)[0], exists: false, memoryMb: null, key: null, raw: null }
  }
  const raw = iconv.decode(await fsp.readFile(file), 'win1252')
  const { memoryMb, key } = parseStreamIni(raw)
  return { path: file, exists: true, memoryMb, key, raw }
}

/**
 * Rewrites only the memory value, keeping every other line, comment and the
 * original encoding. Returns where the previous file was kept.
 */
export async function setStreamingMemory(
  gamePath: string,
  memoryMb: number,
  backupDir: string
): Promise<{ file: string; backup: string; from: number | null; to: number }> {
  const reading = await readStreamIni(gamePath)
  if (!reading.exists || reading.raw === null) throw new Error(`No stream.ini in ${gamePath}.`)

  await fsp.mkdir(backupDir, { recursive: true })
  const backup = path.join(backupDir, `stream.ini.${Date.now()}.bak`)
  await fsp.copyFile(reading.path, backup)

  const key = reading.key ?? 'Streaming Memory'
  let replaced = false
  const lines = reading.raw.split(/\r?\n/).map((line) => {
    const m = /^([^=;#[]+?)\s*=\s*([0-9]+)\s*$/.exec(line.trim())
    if (!m || !MEMORY_KEYS.test(m[1].trim()) || replaced) return line
    replaced = true
    return `${m[1].trim()}=${memoryMb}`
  })
  if (!replaced) lines.push(`${key}=${memoryMb}`)

  await fsp.writeFile(reading.path, iconv.encode(lines.join('\r\n'), 'win1252'))
  return { file: reading.path, backup, from: reading.memoryMb, to: memoryMb }
}

/** Does this profile have something that can actually give the game that memory? */
export function limitAdjusterNames(): RegExp {
  return /(open ?limit ?adjuster|limitadjuster|fastman92|iii\.vc\.sa\.limitadjuster)/i
}
