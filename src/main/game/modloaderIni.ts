import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import { exists } from '../util/fsx'

/**
 * modloader.ini is a plain INI written by Mod Loader itself. It is the user's
 * file: parse it, edit only the keys we own, and write everything else back
 * byte-for-byte including comments and ordering.
 */
export interface IniSection {
  name: string
  /** Raw lines of the section body, comments included. */
  lines: string[]
}

export interface ParsedIni {
  preamble: string[]
  sections: IniSection[]
  eol: string
}

export const DEFAULT_PRIORITY = 50
export const MIN_PRIORITY = 0
export const MAX_PRIORITY = 100

export function parseIni(text: string): ParsedIni {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const preamble: string[] = []
  const sections: IniSection[] = []
  let current: IniSection | null = null
  for (const line of lines) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (m) {
      current = { name: m[1], lines: [] }
      sections.push(current)
    } else if (current) {
      current.lines.push(line)
    } else {
      preamble.push(line)
    }
  }
  return { preamble, sections, eol }
}

export function stringifyIni(ini: ParsedIni): string {
  const out: string[] = [...ini.preamble]
  for (const s of ini.sections) {
    out.push(`[${s.name}]`)
    out.push(...s.lines)
  }
  return out.join(ini.eol)
}

export function getSection(ini: ParsedIni, name: string): IniSection | undefined {
  return ini.sections.find((s) => s.name.toLowerCase() === name.toLowerCase())
}

export function upsertSection(ini: ParsedIni, name: string): IniSection {
  let s = getSection(ini, name)
  if (!s) {
    s = { name, lines: [] }
    ini.sections.push(s)
  }
  return s
}

export function readKeys(section: IniSection | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!section) return out
  for (const line of section.lines) {
    const m = /^\s*([^;#=\s][^=]*?)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) out[m[1]] = m[2]
  }
  return out
}

export function setKey(section: IniSection, key: string, value: string): void {
  const idx = section.lines.findIndex((l) => {
    const m = /^\s*([^;#=\s][^=]*?)\s*=/.exec(l)
    return !!m && m[1].toLowerCase() === key.toLowerCase()
  })
  if (idx >= 0) section.lines[idx] = `${key}=${value}`
  else section.lines.push(`${key}=${value}`)
}

/**
 * Mod Loader reads modloader.ini as Windows-1252, so that is what Modão
 * writes - always, with no exception and no BOM. A folder called "Animacoes de
 * Kung Fu melhoradas" written as UTF-8 reaches Mod Loader as "AnimaAAes ..."
 * and its priority line silently stops matching the folder it names, which
 * looks exactly like a priority the game decided to ignore.
 */
export function decodeIni(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  // A file an earlier build wrote as UTF-8 still has to read back correctly, or
  // its accented folder names would be rewritten as mojibake. Well-formed
  // multi-byte UTF-8 is distinctive; anything else is cp1252.
  return looksLikeUtf8(buf) ? buf.toString('utf8') : iconv.decode(buf, 'win1252')
}

/** True only for a buffer holding at least one well-formed multi-byte UTF-8 sequence and no invalid one. */
export function looksLikeUtf8(buf: Buffer): boolean {
  let multiByte = 0
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]
    if (b < 0x80) continue
    let extra = 0
    if (b >= 0xc2 && b <= 0xdf) extra = 1
    else if (b >= 0xe0 && b <= 0xef) extra = 2
    else if (b >= 0xf0 && b <= 0xf4) extra = 3
    else return false
    for (let k = 1; k <= extra; k++) {
      const c = buf[i + k]
      if (c === undefined || c < 0x80 || c > 0xbf) return false
    }
    i += extra
    multiByte++
  }
  return multiByte > 0
}

/** Characters cp1252 cannot carry: Mod Loader could never match a line containing one. */
export function unmappableInWin1252(text: string): string[] {
  const bad = new Set<string>()
  for (const ch of text) {
    if (ch.codePointAt(0)! < 0x80) continue
    if (iconv.decode(iconv.encode(ch, 'win1252'), 'win1252') !== ch) bad.add(ch)
  }
  return [...bad]
}

export async function readIniFile(file: string): Promise<ParsedIni> {
  if (!exists(file)) return { preamble: ['; created by Modão'], sections: [], eol: '\r\n' }
  return parseIni(decodeIni(await fsp.readFile(file)))
}

export function encodeIni(ini: ParsedIni): Buffer {
  return iconv.encode(stringifyIni(ini), 'win1252')
}

export async function writeIniFile(file: string, ini: ParsedIni): Promise<void> {
  await fsp.writeFile(file, encodeIni(ini))
}

export interface ProfilePriorityBlock {
  profile: string
  priorities: Record<string, number>
}

export function prioritySectionName(profile: string): string {
  return `Profiles.${profile}.Priority`
}

/**
 * The priorities recorded for one profile.
 *
 * Strict by default: only the block that belongs to this profile counts, which
 * is what a check of "does the ini say what this profile says" needs. Pass
 * `inherit` when adopting an install Modão has never seen - there the user's
 * hand-set values live in Mod Loader's own default block, or in the unscoped
 * [Priority] section, and ignoring them resets a tuned load order to 50.
 */
export function readPriorities(
  ini: ParsedIni,
  profile: string,
  opts: { inherit?: boolean } = {}
): Record<string, number> {
  const scoped = readKeys(getSection(ini, prioritySectionName(profile)))
  const inherited = opts.inherit ? readKeys(getSection(ini, prioritySectionName('Default'))) : {}
  const global = opts.inherit ? readKeys(getSection(ini, 'Priority')) : {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries({ ...global, ...inherited, ...scoped })) {
    const n = Number.parseInt(v, 10)
    if (Number.isFinite(n)) out[k] = clampPriority(n)
  }
  return out
}

export function clampPriority(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PRIORITY
  return Math.min(MAX_PRIORITY, Math.max(MIN_PRIORITY, Math.round(n)))
}

/**
 * Writes the profile priority block and points Mod Loader's own profile
 * mechanism at the same name, so the game and Modão always agree.
 */
export function applyProfileToIni(
  ini: ParsedIni,
  profile: string,
  priorities: Record<string, number>
): ParsedIni {
  const section = upsertSection(ini, prioritySectionName(profile))
  // This block belongs to Modão and describes exactly one profile, so it is
  // rewritten whole. A key left behind from an earlier write is a priority line
  // for a mod that is not in the profile any more - Mod Loader would apply it
  // to a folder the user cannot see in this profile. Comments and blank lines
  // are the user's and stay where they are.
  section.lines = section.lines.filter((l) => !/^\s*([^;#=\s][^=]*?)\s*=/.test(l))
  for (const [folder, prio] of Object.entries(priorities)) {
    setKey(section, folder, String(clampPriority(prio)))
  }
  const folderConfig = upsertSection(ini, 'Folder.Config')
  setKey(folderConfig, 'Profile', profile)
  return ini
}

/**
 * Which mod wins for a duplicated relative path.
 * Priority 0 means the mod is ignored entirely; higher priority wins;
 * ties fall back to alphabetical folder order, which is what Mod Loader does.
 */
export function resolveWinner<T extends { priority: number; folder: string; enabled: boolean }>(
  claimants: T[]
): T | null {
  const eligible = claimants.filter((c) => c.enabled && c.priority > MIN_PRIORITY)
  if (eligible.length === 0) return null
  return [...eligible].sort((a, b) => b.priority - a.priority || a.folder.localeCompare(b.folder))[0]
}

/**
 * Mod Loader's own way of turning mods off without touching a single file.
 *
 * `ExcludeAllMods=true` plus an `[IncludeMods]` list is a one-switch safe mode:
 * the folders stay exactly where they are and Mod Loader simply does not read
 * them. That is the mechanism to use for bisection - moving files to find a
 * crash risks creating a different problem than the one being chased.
 */
export interface IgnoreState {
  excludeAll: boolean
  include: string[]
  ignore: string[]
}

const EXCLUDE_KEY = 'ExcludeAllMods'

export function readIgnoreState(ini: ParsedIni): IgnoreState {
  const config = readKeys(getSection(ini, 'Config'))
  const folder = readKeys(getSection(ini, 'Folder.Config'))
  const raw = (folder[EXCLUDE_KEY] ?? config[EXCLUDE_KEY] ?? 'false').trim().toLowerCase()
  return {
    excludeAll: raw === 'true' || raw === '1',
    include: listSection(ini, 'IncludeMods'),
    ignore: listSection(ini, 'IgnoreMods')
  }
}

/** A Mod Loader list section holds bare folder names, one per line. */
function listSection(ini: ParsedIni, name: string): string[] {
  const section = getSection(ini, name)
  if (!section) return []
  return section.lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith(';') && !l.startsWith('#'))
    .map((l) => l.replace(/\s*=.*$/, '').trim())
    .filter(Boolean)
}

function writeListSection(ini: ParsedIni, name: string, values: string[]): void {
  const section = upsertSection(ini, name)
  const comments = section.lines.filter((l) => l.trim().startsWith(';') || l.trim().startsWith('#'))
  section.lines = [...comments, ...values]
}

/**
 * Applies a safe mode: only `include` is loaded, everything else is left in
 * place and ignored. Passing an empty include list loads nothing at all.
 */
export function applyIgnoreState(ini: ParsedIni, state: IgnoreState): ParsedIni {
  setKey(upsertSection(ini, 'Folder.Config'), EXCLUDE_KEY, state.excludeAll ? 'true' : 'false')
  writeListSection(ini, 'IncludeMods', state.include)
  writeListSection(ini, 'IgnoreMods', state.ignore)
  return ini
}
