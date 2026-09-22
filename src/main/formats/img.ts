import fsp from 'node:fs/promises'
import type { ImgAnalysis, ImgEntry } from '@shared/types'

export const SECTOR = 2048

/**
 * VER2 .img reader.
 *   char magic[4] = "VER2"
 *   uint32 entryCount
 *   entry[entryCount], 32 bytes each:
 *     uint32 offsetInSectors
 *     uint16 streamingSize
 *     uint16 sizeInArchive
 *     char   name[24]
 */
export async function analyzeImg(file: string): Promise<ImgAnalysis> {
  const fh = await fsp.open(file, 'r')
  try {
    const header = Buffer.alloc(8)
    await fh.read(header, 0, 8, 0)
    const magic = header.subarray(0, 4).toString('latin1')
    if (magic !== 'VER2') {
      return {
        file,
        version: magic,
        entryCount: 0,
        entries: [],
        errors: [`Not a VER2 archive (magic "${magic}"). VER1 archives keep their directory in a separate .dir file.`]
      }
    }
    const entryCount = header.readUInt32LE(4)
    const table = Buffer.alloc(entryCount * 32)
    await fh.read(table, 0, table.length, 8)
    const entries: ImgEntry[] = []
    for (let i = 0; i < entryCount; i++) {
      const o = i * 32
      if (o + 32 > table.length) break
      const offsetSectors = table.readUInt32LE(o)
      const streamingSize = table.readUInt16LE(o + 4)
      const sizeInArchive = table.readUInt16LE(o + 6)
      const raw = table.subarray(o + 8, o + 32)
      const zero = raw.indexOf(0)
      const name = raw.subarray(0, zero === -1 ? raw.length : zero).toString('latin1')
      const sectors = streamingSize || sizeInArchive
      entries.push({
        name,
        offsetSectors,
        streamingSize,
        sizeInArchive,
        byteOffset: offsetSectors * SECTOR,
        byteSize: sectors * SECTOR
      })
    }
    return { file, version: 'VER2', entryCount, entries, errors: [] }
  } finally {
    await fh.close()
  }
}

/** Reads one entry's bytes out of a VER2 archive - used to diff a mod against the vanilla original. */
export async function extractImgEntry(file: string, name: string): Promise<Buffer | null> {
  const img = await analyzeImg(file)
  const entry = img.entries.find((e) => e.name.toLowerCase() === name.toLowerCase())
  if (!entry) return null
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(entry.byteSize)
    const { bytesRead } = await fh.read(buf, 0, entry.byteSize, entry.byteOffset)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

export interface ImgDiff {
  onlyInA: string[]
  onlyInB: string[]
  sizeChanged: { name: string; a: number; b: number }[]
}

export function diffImg(a: ImgAnalysis, b: ImgAnalysis): ImgDiff {
  const ma = new Map(a.entries.map((e) => [e.name.toLowerCase(), e]))
  const mb = new Map(b.entries.map((e) => [e.name.toLowerCase(), e]))
  const onlyInA: string[] = []
  const onlyInB: string[] = []
  const sizeChanged: { name: string; a: number; b: number }[] = []
  for (const [k, v] of ma) {
    const other = mb.get(k)
    if (!other) onlyInA.push(v.name)
    else if (other.byteSize !== v.byteSize) sizeChanged.push({ name: v.name, a: v.byteSize, b: other.byteSize })
  }
  for (const [k, v] of mb) if (!ma.has(k)) onlyInB.push(v.name)
  return { onlyInA, onlyInB, sizeChanged }
}
