import fsp from 'node:fs/promises'
import type { TextureInfo, TxdAnalysis } from '@shared/types'
import {
  RW_STRUCT,
  RW_TEXTURE_DICTIONARY,
  RW_TEXTURE_NATIVE,
  children,
  decodeRwVersion,
  isPowerOfTwo,
  readChunk,
  readFixedString
} from './rw'

/** Textures above this edge length are a common cause of stalls and VRAM exhaustion. */
const OVERSIZE_EDGE = 2048

const D3D_FORMATS: Record<number, string> = {
  0x31545844: 'DXT1',
  0x33545844: 'DXT3',
  0x35545844: 'DXT5',
  21: 'A8R8G8B8',
  22: 'X8R8G8B8',
  23: 'R5G6B5',
  25: 'A1R5G5B5',
  26: 'A4R4G4B4',
  28: 'P8 (palette)'
}

/**
 * Parses a RenderWare texture dictionary far enough to read every texture's
 * name and dimensions. Dimensions are what matter: a non-power-of-two texture
 * is a documented cause of crashes (0x00749B7B and friends) and of textures
 * rendering black or stretched.
 */
export async function analyzeTxd(file: string): Promise<TxdAnalysis> {
  const buf = await fsp.readFile(file)
  return analyzeTxdBuffer(buf, file)
}

export function analyzeTxdBuffer(buf: Buffer, file: string): TxdAnalysis {
  const errors: string[] = []
  const textures: TextureInfo[] = []
  let rwVersion = 'unknown'

  const root = readChunk(buf, 0)
  if (!root) {
    return empty(file, ['File is too small to be a .txd'])
  }
  if (root.type !== RW_TEXTURE_DICTIONARY) {
    errors.push(`Root chunk is 0x${root.type.toString(16)}, expected 0x16 (Texture Dictionary)`)
  }
  rwVersion = decodeRwVersion(root.version)

  let declaredCount = -1
  for (const child of children(buf, root)) {
    if (child.type === RW_STRUCT && declaredCount < 0) {
      declaredCount = child.size >= 2 ? buf.readUInt16LE(child.dataStart) : -1
      continue
    }
    if (child.type !== RW_TEXTURE_NATIVE) continue
    const native = readTextureNative(buf, child.dataStart, child.dataEnd)
    if (native) textures.push(native)
    else errors.push(`Unreadable Texture Native chunk at offset ${child.dataStart}`)
  }

  if (declaredCount >= 0 && declaredCount !== textures.length) {
    errors.push(`Header declares ${declaredCount} textures but ${textures.length} were readable`)
  }

  return {
    file,
    rwVersion,
    textureCount: textures.length,
    textures,
    nonPowerOfTwo: textures.filter((t) => !t.powerOfTwo),
    oversized: textures.filter((t) => t.width > OVERSIZE_EDGE || t.height > OVERSIZE_EDGE),
    errors
  }
}

function readTextureNative(buf: Buffer, start: number, end: number): TextureInfo | null {
  // First child of a Texture Native is its Struct; the D3D layout puts the
  // texture name at +8 and the dimensions at +80 inside that struct.
  const struct = readChunk(buf, start)
  if (!struct || struct.type !== RW_STRUCT) return null
  const d = struct.dataStart
  if (d + 88 > end || d + 88 > buf.length) return null

  const name = readFixedString(buf, d + 8, 32)
  const d3dFormat = buf.readUInt32LE(d + 76)
  const width = buf.readUInt16LE(d + 80)
  const height = buf.readUInt16LE(d + 82)
  const depth = buf.readUInt8(d + 84)
  const mipmaps = buf.readUInt8(d + 85)
  const compressionByte = buf.readUInt8(d + 87)

  const compression =
    D3D_FORMATS[d3dFormat] ??
    (compressionByte === 1 ? 'DXT1' : compressionByte === 3 ? 'DXT3' : compressionByte ? `raw (${compressionByte})` : 'uncompressed')

  return {
    name: name || '(unnamed)',
    width,
    height,
    depth,
    mipmaps,
    powerOfTwo: isPowerOfTwo(width) && isPowerOfTwo(height),
    compression
  }
}

function empty(file: string, errors: string[]): TxdAnalysis {
  return {
    file,
    rwVersion: 'unknown',
    textureCount: 0,
    textures: [],
    nonPowerOfTwo: [],
    oversized: [],
    errors
  }
}

export function describeTxdProblems(a: TxdAnalysis): string[] {
  const out: string[] = []
  for (const t of a.nonPowerOfTwo) {
    out.push(
      `${t.name} is ${t.width}x${t.height} - not a power of two. Known cause of crashes at 0x00749B7B and of textures failing to render.`
    )
  }
  for (const t of a.oversized) {
    out.push(`${t.name} is ${t.width}x${t.height} - very large; expect streaming stalls on 32-bit address space.`)
  }
  return out
}
