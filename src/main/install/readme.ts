import fsp from 'node:fs/promises'
import path from 'node:path'
import iconv from 'iconv-lite'
import type { DeclaredDependency, DestinationClass, PlanWarning, ReadmeInstruction, ReadmeParse } from '@shared/types'
import { extractActivationCodes } from '@shared/activation'
import { walk } from '../util/fsx'
import { t } from '../util/i18n'

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
    activationCodes: extractActivationCodes(text),
    confidence: instructions.length === 0 ? 0 : Math.min(1, 0.55 + 0.15 * instructions.length)
  }
}

/**
 * An archive that ships a readme nobody could parse.
 *
 * The spec's rule is that such an archive is never installed without asking
 * first: the author wrote instructions, the app failed to read them, and
 * proceeding means the placement is a guess dressed as a plan. Silent guessing
 * is exactly how this app has put files in the wrong place before, so the plan
 * carries an explicit warning and the dialog will not install until the user
 * says to go ahead anyway.
 *
 * Pure, and takes the parses rather than a path, so it is exercised by the unit
 * suite and decided in one place instead of at each call site.
 */
export function unparsedReadmeWarning(readmes: ReadmeParse[]): PlanWarning | null {
  if (readmes.length === 0) return null
  if (readmes.some((r) => r.confidence > 0)) return null
  const names = readmes.map((r) => path.basename(r.file)).join(', ')
  return {
    severity: 'warn',
    code: 'readme-unparsed',
    message: t('messages.install.readmeUnparsed', { file: names }),
    detail: t('messages.install.readmeUnparsedDetail')
  }
}

/**
 * Words that describe a folder without naming one.
 *
 * "Extract the single folder to the ModLoader folder" names nothing: taking
 * "single folder" as the mod's name made the app believe it had installed a mod
 * called that, and then warn that the real plan disagreed with itself.
 */
const GENERIC_FOLDER =
  /^(do mod|the mod|mod|dele|dela|single|single folder|a [uú]nica|[uú]nica|the single|pasta|folder|essa|esta|this|that|extra[ií]da|extracted|resultante|acima|below|abaixo)$/i

function cleanFolder(raw: string): string | null {
  const v = raw
    .replace(/^["'\s]+|["'\s.]+$/g, '')
    .replace(/\s+para$/i, '')
    .replace(/^(a|o|as|os|the)\s+/i, '')
    .trim()
  if (!v || v.length > 120) return null
  if (GENERIC_FOLDER.test(v)) return null
  // A phrase, not a folder name: real ones do not read as sentences.
  if (/\b(para|to|into|dentro|inside|e depois|and then)\b/i.test(v)) return null
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
    const clean = canonicalDependencyName(name)
    if (!clean) return
    // The same requirement is usually stated twice, once per language. One edge
    // is enough, and two read as two different missing mods.
    const key = clean.toLowerCase()
    if (out.some((d) => d.kind === kind && d.name.toLowerCase() === key)) return
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

/**
 * The mod a readme line is talking about, as a name the app can look for.
 *
 * Authors write "última versão do Modloader" and "the latest version of
 * Modloader" for the same thing. Taken literally those became two requirements,
 * neither of which matched the Mod Loader that was installed, and the install
 * was blocked over a mod the user already had.
 */
export function canonicalDependencyName(raw: string): string | null {
  let v = (raw ?? '')
    .replace(/^[\s:\-–—*]+|[\s:.\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  // Strip the prose around the name.
  v = v
    .replace(/^(a|o|os|as|the)\s+/i, '')
    .replace(/^(?:[uú]ltima|nova|mais recente|latest|newest|current)\s+vers[aã]o\s+(?:do|da|de|of)?\s*/i, '')
    .replace(/^(?:latest|newest|current)\s+version\s+(?:of\s+)?/i, '')
    .replace(/^vers[aã]o\s+(?:mais recente|atual)\s+(?:do|da|de)?\s*/i, '')
    .replace(/^(?:ter|have|install|instalar|baixar|download)\s+(?:o|a|the)?\s*/i, '')
    .replace(/\s+(?:instalado|installed|atualizado|updated)$/i, '')
    .trim()

  if (v.length < 2 || v.length > 60) return null
  // What is left has to name something, not describe it.
  if (/^(vers[aã]o|version|mod|mods|jogo|game|pasta|folder|arquivo|file)$/i.test(v)) return null

  for (const [re, canonical] of DEPENDENCY_ALIASES) {
    if (re.test(v)) return canonical
  }
  return v
}

/** Names the scene writes a dozen ways for the same thing. */
const DEPENDENCY_ALIASES: [RegExp, string][] = [
  [/^mod\s*loader$/i, 'Mod Loader'],
  [/^modloader$/i, 'Mod Loader'],
  [/^sa[\s-]*modloader$/i, 'Mod Loader'],
  [/^cleo\s*\+$/i, 'CLEO+'],
  [/^cleo(\s*4(\.\d)?)?$/i, 'CLEO'],
  [/^silent\s*patch$/i, 'SilentPatch'],
  [/^open\s*limit\s*adjuster$/i, 'Open Limit Adjuster'],
  [/^limit\s*adjuster$/i, 'Open Limit Adjuster'],
  [/^asi\s*loader$/i, 'ASI Loader'],
  [/^ultimate\s*asi\s*loader$/i, 'ASI Loader'],
  [/^widescreen\s*fix$/i, 'Widescreen Fix']
]
