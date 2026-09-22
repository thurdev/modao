import fsp from 'node:fs/promises'
import path from 'node:path'
import type { IfpAnalysis } from '@shared/types'
import { exists } from '../util/fsx'
import { extractImgEntry } from './img'

/**
 * .ifp animation package reader.
 *
 * GTA SA ships ANP3; ANPK (III/VC) and SANM also turn up in mods. Both layouts
 * store the package name and then a list of animation blocks whose names are
 * what we care about: a mod that replaces ped.ifp but omits animations the
 * vanilla file had will break every script that plays them.
 *
 * Note for the UI: swimming animations live in swim.ifp, NOT ped.ifp.
 * ped.ifp only carries Swim_Tread.
 */
export async function analyzeIfp(file: string): Promise<IfpAnalysis> {
  const buf = await fsp.readFile(file)
  return analyzeIfpBuffer(buf, file)
}

export function analyzeIfpBuffer(buf: Buffer, file: string): IfpAnalysis {
  const errors: string[] = []
  if (buf.length < 12) return { file, version: 'unknown', animationCount: 0, animations: [], missingVsVanilla: [], vanillaReference: null, errors: ['File too small'] }
  const magic = buf.subarray(0, 4).toString('latin1')
  let animations: string[] = []

  if (magic === 'ANP3' || magic === 'ANP2') {
    animations = readAnp3(buf, errors)
  } else if (magic === 'ANPK') {
    animations = readAnpk(buf, errors)
  } else {
    errors.push(`Unknown .ifp magic "${magic}" - falling back to a string scan`)
    animations = scanNames(buf)
  }

  if (animations.length === 0) {
    animations = scanNames(buf)
    if (animations.length) errors.push('Structured parse found nothing; names recovered by scanning')
  }

  return {
    file,
    version: magic,
    animationCount: animations.length,
    animations,
    missingVsVanilla: [],
    vanillaReference: null,
    errors
  }
}

/** ANP3: 'ANP3', uint32 size, char name[24], uint32 animCount, then blocks. */
function readAnp3(buf: Buffer, errors: string[]): string[] {
  const out: string[] = []
  try {
    let off = 8
    off += 24 // package name
    const animCount = buf.readUInt32LE(off)
    off += 4
    for (let i = 0; i < animCount && off + 36 <= buf.length; i++) {
      const name = cstr(buf, off, 24)
      off += 24
      const objectCount = buf.readInt32LE(off)
      off += 4
      const frameSize = buf.readInt32LE(off)
      off += 4
      off += 4 // unknown / frame count
      if (name) out.push(name)
      // Skip this animation's object blocks.
      for (let o = 0; o < objectCount && off + 32 <= buf.length; o++) {
        off += 24 // object name
        const frameType = buf.readInt32LE(off)
        off += 4
        const frameCount = buf.readInt32LE(off)
        off += 4
        off += 4 // bone id
        const perFrame = frameType === 3 ? 16 : frameType === 4 ? 20 : frameSize > 0 ? frameSize : 16
        off += frameCount * perFrame
      }
    }
  } catch (e) {
    errors.push(`ANP3 parse stopped early: ${(e as Error).message}`)
  }
  return out
}

/** ANPK: 'ANPK', size, 'INFO' block with the package info, then 'NAME' chunks. */
function readAnpk(buf: Buffer, errors: string[]): string[] {
  const out: string[] = []
  try {
    let off = 8
    while (off + 8 <= buf.length) {
      const tag = buf.subarray(off, off + 4).toString('latin1')
      const size = buf.readUInt32LE(off + 4)
      const body = off + 8
      if (tag === 'NAME') out.push(cstr(buf, body, Math.min(size, 48)))
      off = body + size
      if (size === 0) break
    }
  } catch (e) {
    errors.push(`ANPK parse stopped early: ${(e as Error).message}`)
  }
  return out.filter(Boolean)
}

function cstr(buf: Buffer, off: number, len: number): string {
  const slice = buf.subarray(off, Math.min(off + len, buf.length))
  const zero = slice.indexOf(0)
  return slice
    .subarray(0, zero === -1 ? slice.length : zero)
    .toString('latin1')
    .trim()
}

/** Last-resort recovery: animation names are ASCII runs in a fixed-width table. */
function scanNames(buf: Buffer): string[] {
  const names = new Set<string>()
  let run: number[] = []
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    if (c >= 0x20 && c <= 0x7e) {
      run.push(c)
    } else {
      if (run.length >= 4 && run.length <= 23) {
        const s = Buffer.from(run).toString('latin1')
        if (/^[A-Za-z][A-Za-z0-9_ .-]+$/.test(s)) names.add(s)
      }
      run = []
    }
  }
  return [...names]
}

/**
 * Diffs a modded .ifp against the vanilla original, pulled straight out of the
 * game's own anim.img so no reference data has to be shipped.
 */
export async function compareWithVanilla(file: string, gamePath: string): Promise<IfpAnalysis> {
  const analysis = await analyzeIfp(file)
  const base = path.basename(file)
  const animImg = [path.join(gamePath, 'anim', 'anim.img'), path.join(gamePath, 'models', 'gta3.img')].find(exists)
  if (!animImg) {
    analysis.errors.push('No vanilla anim.img found to compare against')
    return analysis
  }
  const vanillaBuf = await extractImgEntry(animImg, base)
  if (!vanillaBuf) {
    analysis.vanillaReference = `${animImg} (no entry named ${base})`
    return analysis
  }
  const vanilla = analyzeIfpBuffer(vanillaBuf, `${animImg}:${base}`)
  const have = new Set(analysis.animations.map((a) => a.toLowerCase()))
  analysis.vanillaReference = `${animImg}:${base}`
  analysis.missingVsVanilla = vanilla.animations.filter((a) => !have.has(a.toLowerCase()))
  return analysis
}
