import type { PeSection } from './types'

/**
 * The pure half of "deep analysis": turning a crash virtual address into a
 * file offset, and formatting a hex window around it. No disassembly - there
 * is no x86 decoder here, and the app bundles neither Python nor capstone.
 * src/main/diagnostics/disasm.ts is the Electron-adjacent caller that reads
 * gta_sa.exe off disk and hands this module the bytes and the section table
 * src/main/game/pe.ts already knows how to read.
 */

export interface FileOffsetResult {
  section: string
  fileOffset: number
}

/**
 * Finds which section's virtual range contains `va` and returns the matching
 * file offset. Null when the address falls in no section - outside the
 * image, in the header, or in a section's uninitialised tail (.bss-like,
 * where virtualSize exceeds rawSize and there are no file bytes to show).
 */
export function vaToFileOffset(imageBase: number, sections: PeSection[], va: number): FileOffsetResult | null {
  const rva = va - imageBase
  if (rva < 0) return null
  for (const s of sections) {
    const span = Math.max(s.virtualSize, s.rawSize)
    if (rva >= s.virtualAddress && rva < s.virtualAddress + span) {
      const delta = rva - s.virtualAddress
      if (delta >= s.rawSize) return null
      return { section: s.name, fileOffset: s.rawPointer + delta }
    }
  }
  return null
}

/**
 * A classic 16-bytes-per-line hex dump: file offset, hex bytes (the byte at
 * `markOffset`, if given, bracketed), then the printable ASCII rendering.
 */
export function formatHexDump(buf: Buffer, fileOffsetStart: number, markOffset?: number): string[] {
  const lines: string[] = []
  for (let i = 0; i < buf.length; i += 16) {
    const chunk = buf.subarray(i, Math.min(i + 16, buf.length))
    const addr = (fileOffsetStart + i).toString(16).toUpperCase().padStart(8, '0')
    const hex = [...chunk]
      .map((b, j) => {
        const s = b.toString(16).toUpperCase().padStart(2, '0')
        return markOffset !== undefined && fileOffsetStart + i + j === markOffset ? `[${s}]` : ` ${s}`
      })
      .join('')
      .trim()
    const ascii = [...chunk].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${addr}  ${hex.padEnd(16 * 3 - 1, ' ')}  ${ascii}`)
  }
  return lines
}
