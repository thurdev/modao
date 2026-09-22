/** Shared RenderWare chunk walking used by the .txd (and .dff) readers. */

export const RW_STRUCT = 0x01
export const RW_STRING = 0x02
export const RW_EXTENSION = 0x03
export const RW_TEXTURE_NATIVE = 0x15
export const RW_TEXTURE_DICTIONARY = 0x16

export interface RwChunk {
  type: number
  size: number
  version: number
  /** Offset of the chunk body (immediately after the 12-byte header). */
  dataStart: number
  /** Offset one past the chunk body. */
  dataEnd: number
}

export function readChunk(buf: Buffer, offset: number): RwChunk | null {
  if (offset + 12 > buf.length) return null
  const type = buf.readUInt32LE(offset)
  const size = buf.readUInt32LE(offset + 4)
  const version = buf.readUInt32LE(offset + 8)
  const dataStart = offset + 12
  const dataEnd = dataStart + size
  if (size < 0 || dataEnd > buf.length) return { type, size, version, dataStart, dataEnd: buf.length }
  return { type, size, version, dataStart, dataEnd }
}

export function* children(buf: Buffer, parent: RwChunk): Generator<RwChunk> {
  let off = parent.dataStart
  while (off + 12 <= parent.dataEnd) {
    const c = readChunk(buf, off)
    if (!c || c.size === 0) {
      if (!c) return
      off = c.dataStart
      continue
    }
    yield c
    off = c.dataEnd
  }
}

/**
 * RenderWare packs its version into the chunk header. Both the old
 * (pre-3.1) and the packed library-id layouts appear in GTA SA files.
 */
export function decodeRwVersion(version: number): string {
  if (version & 0xffff0000) {
    const major = ((version >> 14) & 0x3) + 3
    const minor = (version >> 16) & 0xf
    const rev = (version >> 12) & 0xf
    const build = version & 0x3f
    return `${major}.${minor}.${rev}.${build}`
  }
  return `${(version >> 8) & 0xf}.${(version >> 4) & 0xf}.${version & 0xf}`
}

export function readFixedString(buf: Buffer, offset: number, length: number): string {
  if (offset + length > buf.length) return ''
  const slice = buf.subarray(offset, offset + length)
  const zero = slice.indexOf(0)
  return slice.subarray(0, zero === -1 ? slice.length : zero).toString('latin1')
}

export function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}
