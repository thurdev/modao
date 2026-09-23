import fsp from 'node:fs/promises'
import type { DeepAnalysisResult } from '@shared/types'
import { vaToFileOffset, formatHexDump } from '@shared/disasm'
import { readPeSections } from '../game/pe'
import { t } from '../util/i18n'

/**
 * "Deep analysis" for a crash address CrashList has no entry for.
 *
 * This is NOT a disassembler. Python and capstone are not available to this
 * app and nothing here pretends otherwise: it converts the crash's virtual
 * address into a file offset using gta_sa.exe's own section table (read by
 * src/main/game/pe.ts, not re-parsed here), then shows the raw bytes around
 * it. Reading x86 out of that window by hand is exactly what the spec's
 * worked example does - cmp/mov opcodes and a register value pointing at the
 * field they touch - but the app itself stops at the bytes.
 */
const WINDOW_BYTES = 64

export async function deepAnalyse(exePath: string, addressHex: string): Promise<DeepAnalysisResult> {
  const va = Number.parseInt(String(addressHex).replace(/^0x/i, ''), 16)
  if (!Number.isFinite(va)) {
    return { address: addressHex, fileOffset: null, section: null, hex: [], note: t('crashes.deepAnalysisInvalidAddress') }
  }

  const { imageBase, sections } = await readPeSections(exePath)
  const hit = vaToFileOffset(imageBase, sections, va)
  if (!hit) {
    return { address: addressHex, fileOffset: null, section: null, hex: [], note: t('crashes.deepAnalysisNotFound') }
  }

  const start = Math.max(0, hit.fileOffset - WINDOW_BYTES)
  const length = WINDOW_BYTES * 2
  const fh = await fsp.open(exePath, 'r')
  let bytes: Buffer
  try {
    const out = Buffer.alloc(length)
    const { bytesRead } = await fh.read(out, 0, length, start)
    bytes = out.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }

  return {
    address: addressHex,
    fileOffset: hit.fileOffset,
    section: hit.section,
    hex: formatHexDump(bytes, start, hit.fileOffset),
    note: t('crashes.deepAnalysisDisclaimer')
  }
}
