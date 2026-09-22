import fsp from 'node:fs/promises'
import path from 'node:path'
import type { PeInfo, PeSection } from '@shared/types'
import { sha256File } from '../util/fsx'

/** IMAGE_FILE_LARGE_ADDRESS_AWARE */
export const LAA_FLAG = 0x0020
/** Vanilla GTA SA v1.0 US gta_sa.exe */
export const V1_US_SIZE = 14_383_616
export const V1_US_TIMESTAMP = 0x427101ca

const MACHINE: Record<number, string> = {
  0x014c: 'i386',
  0x8664: 'x86-64',
  0x01c0: 'ARM',
  0xaa64: 'ARM64'
}

/**
 * Minimal PE header reader: enough for version/characteristics checks on
 * gta_sa.exe, .asi plugins and .cleo plugins (all of which are PE images).
 */
export async function readPe(file: string): Promise<PeInfo> {
  const fh = await fsp.open(file, 'r')
  try {
    const stat = await fh.stat()
    const head = Buffer.alloc(0x400)
    await fh.read(head, 0, head.length, 0)

    if (head.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path.basename(file)} is not a PE image (no MZ header)`)
    const peOffset = head.readUInt32LE(0x3c)
    if (peOffset + 24 > head.length) throw new Error('PE header beyond first 1KB; unsupported layout')
    if (head.readUInt32LE(peOffset) !== 0x00004550) throw new Error('Missing PE signature')

    const coff = peOffset + 4
    const machine = head.readUInt16LE(coff)
    const timestamp = head.readUInt32LE(coff + 4)
    const characteristics = head.readUInt16LE(coff + 18)

    return {
      file,
      machine: MACHINE[machine] ?? `0x${machine.toString(16)}`,
      timestamp,
      timestampIso: new Date(timestamp * 1000).toISOString(),
      characteristics,
      largeAddressAware: (characteristics & LAA_FLAG) !== 0,
      isDll: (characteristics & 0x2000) !== 0,
      sizeBytes: stat.size,
      sha256: await sha256File(file)
    }
  } finally {
    await fh.close()
  }
}

export interface ExeVerdict {
  pe: PeInfo
  isV1UsOriginal: boolean
  sizeMatches: boolean
  timestampMatches: boolean
  largeAddressAware: boolean
  summary: string
}

export async function checkGameExe(exePath: string): Promise<ExeVerdict> {
  const pe = await readPe(exePath)
  const sizeMatches = pe.sizeBytes === V1_US_SIZE
  const timestampMatches = pe.timestamp === V1_US_TIMESTAMP
  const isV1UsOriginal = sizeMatches && timestampMatches
  const parts: string[] = []
  if (isV1UsOriginal) parts.push('v1.0 US executable confirmed (size and PE timestamp match)')
  else if (sizeMatches) parts.push('Size matches v1.0 US but the PE timestamp differs - the exe has been patched')
  else if (timestampMatches) parts.push('PE timestamp matches v1.0 US but the size differs - the exe has been patched')
  else parts.push('Not a stock v1.0 US executable (size and timestamp both differ)')
  parts.push(
    pe.largeAddressAware
      ? 'LARGE_ADDRESS_AWARE is set - the game can use up to 4 GB (typical of repacks and patched exes)'
      : 'LARGE_ADDRESS_AWARE is NOT set - stock v1.0 behaviour, 2 GB address space limit'
  )
  return {
    pe,
    isV1UsOriginal,
    sizeMatches,
    timestampMatches,
    largeAddressAware: pe.largeAddressAware,
    summary: parts.join('. ')
  }
}

export interface PeSections {
  imageBase: number
  sections: PeSection[]
}

/**
 * The section table: what src/main/diagnostics/disasm.ts needs to turn a
 * crash virtual address into a file offset. A separate read from readPe's,
 * because the section table's own offset depends on SizeOfOptionalHeader,
 * which is not fixed the way the DOS and COFF headers are - so the buffer
 * grows to fit before anything in it is trusted. Still the one place in the
 * app that parses a PE section table; nothing downstream reads one itself.
 */
export async function readPeSections(file: string): Promise<PeSections> {
  const fh = await fsp.open(file, 'r')
  try {
    let buf = Buffer.alloc(0x400)
    await fh.read(buf, 0, buf.length, 0)

    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error(`${path.basename(file)} is not a PE image (no MZ header)`)
    const peOffset = buf.readUInt32LE(0x3c)
    if (peOffset + 24 > buf.length) throw new Error('PE header beyond first 1KB; unsupported layout')
    if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('Missing PE signature')

    const coff = peOffset + 4
    const numberOfSections = buf.readUInt16LE(coff + 2)
    const sizeOfOptionalHeader = buf.readUInt16LE(coff + 16)
    const optHeaderOffset = coff + 20
    const sectionTableOffset = optHeaderOffset + sizeOfOptionalHeader
    const needed = sectionTableOffset + numberOfSections * 40

    if (needed > buf.length) {
      const grown = Buffer.alloc(needed)
      await fh.read(grown, 0, grown.length, 0)
      buf = grown
    }

    const magic = buf.readUInt16LE(optHeaderOffset)
    const isPe32Plus = magic === 0x20b
    const imageBase = isPe32Plus
      ? Number(buf.readBigUInt64LE(optHeaderOffset + 24))
      : buf.readUInt32LE(optHeaderOffset + 28)

    const sections: PeSection[] = []
    for (let i = 0; i < numberOfSections; i++) {
      const off = sectionTableOffset + i * 40
      if (off + 40 > buf.length) break
      sections.push({
        name: buf.toString('latin1', off, off + 8).replace(/\0+$/, ''),
        virtualSize: buf.readUInt32LE(off + 8),
        virtualAddress: buf.readUInt32LE(off + 12),
        rawSize: buf.readUInt32LE(off + 16),
        rawPointer: buf.readUInt32LE(off + 20)
      })
    }
    return { imageBase, sections }
  } finally {
    await fh.close()
  }
}

/** Best-effort product version from the VS_FIXEDFILEINFO signature in the resource section. */
export async function readFixedFileVersion(file: string): Promise<string | null> {
  const buf = await fsp.readFile(file).catch(() => null)
  if (!buf) return null
  const sig = 0xfeef04bd
  for (let i = 0; i < buf.length - 52; i += 4) {
    if (buf.readUInt32LE(i) === sig) {
      const msFile = buf.readUInt32LE(i + 8)
      const lsFile = buf.readUInt32LE(i + 12)
      return `${msFile >>> 16}.${msFile & 0xffff}.${lsFile >>> 16}.${lsFile & 0xffff}`
    }
  }
  return null
}
