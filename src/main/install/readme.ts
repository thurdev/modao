import fsp from 'node:fs/promises'
import path from 'node:path'
import iconv from 'iconv-lite'
import type { DeclaredDependency, DestinationClass, ReadmeInstruction, ReadmeParse } from '@shared/types'
import { walk } from '../util/fsx'

const README_PATTERNS = [
  /^leiame.*\.txt$/i,
  /^readme.*\.txt$/i,
  /^leia.*\.txt$/i,
  /^instru.*\.txt$/i,
  /^como instalar.*\.txt$/i,
  /^install.*\.txt$/i,
  /\.nfo$/i
]

/**
 * MixMods readmes ("Leiame (ou morra).txt", "Readme (or die).txt") are
 * Windows-1252. Decoding them as UTF-8 produces mojibake, so the encoding is
 * sniffed and cp1252 is the default rather than the fallback.
 */
export function decodeReadme(buf: Buffer): { text: string; encoding: string } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8 (BOM)' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le (BOM)' }
  }
  const hasHighBytes = buf.some((b) => b >= 0x80)
  if (!hasHighBytes) return { text: buf.toString('latin1'), encoding: 'ascii' }
  const utf8 = buf.toString('utf8')
  // U+FFFD means the bytes were not valid UTF-8 - the normal case for these files.
  const validUtf8 = !utf8.includes('�')
  if (validUtf8 && looksLikePortuguese(utf8)) return { text: utf8, encoding: 'utf-8' }
  return { text: iconv.decode(buf, 'win1252'), encoding: 'windows-1252' }
}

function looksLikePortuguese(text: string): boolean {
  return /\b(pasta|instalar|arquivo|jogo|mods?)\b/i.test(text) && /[ãçõáéíóú]/i.test(text)
}

interface Rule {
  re: RegExp
  destination: DestinationClass
  folderGroup?: number
}

/**
 * The MixMods instruction line is highly formulaic. These patterns cover the
 * common pt-BR and en phrasings; anything they miss is shown raw and the user
 * decides.
 */
const RULES: Rule[] = [
  { re: /extraia\s+(?:a\s+)?pasta\s+"?([^"\n]+?)"?\s+para\s+(?:a\s+pasta\s+do\s+)?modloader/i, destination: 'modloader-folder', folderGroup: 1 },
  { re: /mova\s+(?:a\s+)?pasta\s+(?:do\s+mod\s+)?(?:"([^"]+)"\s+)?para\s+(?:a\s+pasta\s+do\s+)?modloader/i, destination: 'modloader-folder', folderGroup: 1 },
  { re: /(?:coloque|copie|cole)\s+(?:a\s+)?pasta\s+"?([^"\n]+?)"?\s+(?:n[ao]|para\s+[ao])\s+modloader/i, destination: 'modloader-folder', folderGroup: 1 },
  { re: /(?:extract|move|copy|put|drop)\s+(?:the\s+)?(?:folder\s+)?"?([^"\n]+?)"?\s+(?:in)?to\s+(?:the\s+)?modloader/i, destination: 'modloader-folder', folderGroup: 1 },
  { re: /extraia\s+(?:o\s+)?\.?asi\s+para\s+a\s+pasta\s+scripts/i, destination: 'asi-plugin' },
  { re: /(?:extraia|coloque|mova|copie)\s+.*\.asi.*\s+(?:para|n[ao])\s+(?:pasta\s+)?(?:scripts|raiz|do\s+jogo|gta)/i, destination: 'asi-plugin' },
  { re: /(?:extract|put|move|copy)\s+.*\.asi.*\s+(?:in)?to\s+(?:the\s+)?(?:scripts|game|root)/i, destination: 'asi-plugin' },
  { re: /(?:extraia|coloque|mova|copie)\s+.*\.cleo.*\s+(?:para|n[ao])\s+(?:pasta\s+)?cleo/i, destination: 'cleo-plugin' },
  { re: /(?:extract|put|move|copy)\s+.*\.cleo.*\s+(?:in)?to\s+(?:the\s+)?cleo/i, destination: 'cleo-plugin' },
  { re: /(?:extraia|coloque|mova|copie)\s+.*\.cs\b.*\s+(?:para|n[ao])\s+(?:pasta\s+)?cleo/i, destination: 'cleo-script' },
  { re: /(?:extract|put|move|copy)\s+.*\.cs\b.*\s+(?:in)?to\s+(?:the\s+)?cleo/i, destination: 'cleo-script' },
  { re: /(?:extraia|coloque|mova|copie)\s+.*\s+(?:para|n[ao])\s+(?:pasta\s+)?(?:raiz|do\s+jogo|principal)/i, destination: 'root-file' },
  { re: /(?:extract|put|move|copy)\s+.*\s+(?:in)?to\s+(?:the\s+)?(?:game|root)\s*(?:folder|directory)?/i, destination: 'root-file' },
  { re: /substitu[ai].*\s+(?:dentro|inside|em)\s+.*mod/i, destination: 'overlay' },
  { re: /(?:replace|overwrite)\s+.*\s+(?:inside|within)\s+.*mod/i, destination: 'overlay' }
]

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi

export async function findReadmes(root: string): Promise<string[]> {
  const files = await walk(root)
  return files
    .filter((f) => README_PATTERNS.some((re) => re.test(path.basename(f.rel))))
    .sort((a, b) => a.rel.split('/').length - b.rel.split('/').length)
    .map((f) => f.abs)
}

export async function parseReadme(file: string): Promise<ReadmeParse> {
  const buf = await fsp.readFile(file)
  const { text, encoding } = decodeReadme(buf)
  return parseReadmeText(file, text, encoding)
}

export function parseReadmeText(file: string, text: string, encoding: string): ReadmeParse {
  const instructions: ReadmeInstruction[] = []
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.length > 400) continue
    for (const rule of RULES) {
      const m = rule.re.exec(trimmed)
      if (!m) continue
      const folderRaw = rule.folderGroup ? m[rule.folderGroup] : null
      const folder = folderRaw ? cleanFolder(folderRaw) : null
      if (!instructions.some((i) => i.line === trimmed)) {
        instructions.push({ line: trimmed, folder, destination: rule.destination })
      }
      break
    }
  }
  const urls = [...new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[.,;]$/, '')))]
  const declared = parseDeclaredDependencies(text)
  const requirementUrls = urls.filter((u) =>
    /mixmods|gtaforums|gtagarage|cleo|patreon|github|libertycity/i.test(u)
  )
  const pt = /[ãçõáéíóú]/i.test(text) || /\bpasta\b/i.test(text)
  const language: ReadmeParse['language'] = pt ? 'pt-BR' : /\b(folder|install|extract)\b/i.test(text) ? 'en' : 'unknown'

  return {
    file,
    encoding,
    raw: text,
    language,
    instructions,
    requirementUrls,
    declared,
    confidence: instructions.length === 0 ? 0 : Math.min(1, 0.55 + 0.15 * instructions.length)
  }
}

function cleanFolder(raw: string): string | null {
  const v = raw
    .replace(/^["'\s]+|["'\s.]+$/g, '')
    .replace(/\s+para$/i, '')
    .trim()
  if (!v || v.length > 120) return null
  if (/^(do mod|the mod|mod|dele|dela)$/i.test(v)) return null
  return v
}

/** Pulls hints such as "2K recommended for 1920x1080" out of the readme for the variant chooser. */
export function findVariantHint(readmes: ReadmeParse[], optionLabels: string[]): string | null {
  for (const r of readmes) {
    for (const line of r.raw.split(/\r?\n/)) {
      const l = line.trim()
      if (!l || l.length > 220) continue
      const mentions = optionLabels.filter((o) => l.toLowerCase().includes(o.toLowerCase()))
      if (mentions.length > 0 && /(recomend|recommend|use|prefer|melhor|ideal|1920|1080|1440|2160|4k|2k)/i.test(l)) {
        return l
      }
    }
  }
  return null
}

/**
 * What the author says the mod needs, in the shapes MixMods readmes use.
 *
 * Proper Shaders names SilentPatch and Open Limit Adjuster in exactly this way,
 * and installing it without them crashed the game - so these lines are read as
 * dependency edges rather than left as prose nobody parses.
 */
export function parseDeclaredDependencies(text: string): DeclaredDependency[] {
  const out: DeclaredDependency[] = []
  const push = (kind: DeclaredDependency['kind'], name: string, url: string | null, line: string): void => {
    const clean = name
      .replace(/^[\s:\-–—]+|[\s:.\-–—]+$/g, '')
      .replace(/^(o|a|os|as|the)\s+/i, '')
      .trim()
    if (clean.length < 2 || clean.length > 60) return
    if (out.some((d) => d.kind === kind && d.name.toLowerCase() === clean.toLowerCase())) return
    out.push({ kind, name: clean, url, line })
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const url = /(https?:\/\/[^\s)>\]]+)/i.exec(line)?.[1]?.replace(/[.,;]$/, '') ?? null

    // "-- Download do Weapon Icons TXD: https://..."
    const download = /^[-–—*\s]*(?:download|baixe|baixar)\s+(?:do|da|de|of|the)?\s*(.+?)\s*(?::|\bhttps?:)/i.exec(line)
    if (download) {
      push('requires', download[1], url, line)
      continue
    }
    // "NECESSARIO: Mod Loader" / "Necessário ter o CLEO 4.4"
    const needed = /\b(necess[aá]rio|requer|requires?|required|precisa de|voc[eê] precisa)\b[:\s]+(.+)$/i.exec(line)
    if (needed) {
      push('requires', needed[2].split(/[,.;(]/)[0], url, line)
      continue
    }
    // "ATENCAO: O mod inclui "gsx.asi", certifique-se de que voce ja nao o tenha"
    const includes = /\b(inclui|inclu[ií]do|includes?|vem com|acompanha)\b[:\s]+["']?([A-Za-z0-9 _.\-+]+\.(?:asi|cleo\d?|dll))["']?/i.exec(line)
    if (includes) {
      push('includes', includes[2], url, line)
      continue
    }
    // "NAO use junto com SkyGfx" / "incompatível com ..."
    const conflict = /\b(incompat[ií]vel com|n[aã]o use (?:junto )?com|conflita com|conflicts? with|do not use with)\b[:\s]+(.+)$/i.exec(line)
    if (conflict) {
      push('conflicts', conflict[2].split(/[,.;(]/)[0], url, line)
    }
  }
  return out
}
