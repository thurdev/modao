import path from 'node:path'
import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import { exists } from '../util/fsx'
import type { ModLoaderCrash, ModLoaderLogReport, ModLoaderModReport } from '@shared/types'
import { baseFolderName } from '@shared/loadOrder'

/**
 * Mod Loader keeps a log of what it actually did, and it is the only honest
 * answer to "did my mod install?". The app can place files correctly and still
 * be wrong about what Mod Loader will do with them; this file is where that
 * disagreement shows up.
 *
 * The three lines that matter:
 *
 *   Installing file "modloader\VehFuncs\vehfuncs.dat"
 *       Mod Loader took the file. The mod is doing something.
 *   No files in "modloader\Some Mod\"
 *       The folder is there and empty as far as Mod Loader is concerned.
 *   No handler or callme for file "ProperShaders.ini"
 *       Mod Loader does not manage that kind of file. Normal on its own - an
 *       .ini belongs to the plugin that reads it - but a mod where EVERY file
 *       says this, and which also reports "No files in", is mis-installed.
 *
 * It is written in the game's encoding, which on a pt-BR install is cp1252.
 */
export function modloaderLogPath(gamePath: string): string {
  return path.join(gamePath, 'modloader', 'modloader.log')
}

export async function readModLoaderLog(gamePath: string): Promise<string | null> {
  const file = modloaderLogPath(gamePath)
  if (!exists(file)) return null
  const buf = await fsp.readFile(file)
  return iconv.decode(buf, 'win1252')
}

const INSTALLING = /Installing file "?([^"\r\n]+)"?/i
const NO_FILES = /No files in "?([^"\r\n]+)"?/i
const NO_HANDLER = /No handler or callme for file "?([^"\r\n]+)"?/i

/** modloader\<Mod>\rest -> <Mod> */
function modFolderOf(relative: string): string | null {
  const m = /modloader[\\/]([^\\/]+)[\\/]/i.exec(relative) ?? /modloader[\\/]([^\\/]+)[\\/]?$/i.exec(relative)
  // Canonical, so a folder spelled "$VHud" to load first is still the VHud the
  // profile records. (". VHud" cannot appear here at all - Mod Loader skips a
  // folder with that prefix and never writes a line about it.)
  return m ? baseFolderName(m[1].replace(/[\\/]+$/, '')) : null
}

/**
 * Reads one log into a verdict per mod folder.
 *
 * `expected` is what the profile believes is installed; a folder in the profile
 * that the log never mentions is reported as inert rather than quietly dropped,
 * because "Mod Loader never saw it" is exactly the failure worth surfacing.
 */
export function parseModLoaderLog(text: string, expected: string[] = []): Omit<ModLoaderLogReport, 'path' | 'readAt'> {
  const installed = new Map<string, number>()
  const unhandled = new Map<string, string[]>()
  const emptyFolders = new Set<string>()
  const looseUnhandled: string[] = []
  let version: string | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (!version) {
      const v = /Mod Loader\s+([0-9]+\.[0-9.]+)/i.exec(line)
      if (v) version = v[1]
    }

    const inst = INSTALLING.exec(line)
    if (inst) {
      const folder = modFolderOf(inst[1])
      if (folder) installed.set(folder, (installed.get(folder) ?? 0) + 1)
      continue
    }
    const empty = NO_FILES.exec(line)
    if (empty) {
      const folder = modFolderOf(empty[1]) ?? empty[1].replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? null
      if (folder) emptyFolders.add(folder)
      continue
    }
    const nh = NO_HANDLER.exec(line)
    if (nh) {
      const folder = modFolderOf(nh[1])
      if (folder) {
        const list = unhandled.get(folder)
        if (list) list.push(nh[1])
        else unhandled.set(folder, [nh[1]])
      } else {
        looseUnhandled.push(nh[1])
      }
    }
  }

  const folders = new Set<string>([...installed.keys(), ...unhandled.keys(), ...emptyFolders, ...expected])
  const mods: ModLoaderModReport[] = [...folders].sort((a, b) => a.localeCompare(b)).map((folder) => {
    const installedFiles = installed.get(folder) ?? 0
    const unhandledFiles = unhandled.get(folder) ?? []
    const knownEmpty = emptyFolders.has(folder)
    const mentioned = installed.has(folder) || unhandled.has(folder) || knownEmpty

    if (installedFiles > 0) {
      return { folder, verdict: 'active' as const, installedFiles, unhandledFiles, explanation: null }
    }
    if (!mentioned) {
      return {
        folder,
        verdict: 'unknown' as const,
        installedFiles,
        unhandledFiles,
        explanation: 'Mod Loader never mentioned this folder. Launch the game once so it writes a fresh log.'
      }
    }
    if (unhandledFiles.length > 0 && knownEmpty) {
      return {
        folder,
        verdict: 'mis-installed' as const,
        installedFiles,
        unhandledFiles,
        explanation:
          'Mod Loader took none of this mod’s files. Usually its plugin was separated from its own data, ' +
          'or the folder holds an add-on that belongs inside another mod.'
      }
    }
    if (unhandledFiles.length > 0) {
      return {
        folder,
        verdict: 'inert' as const,
        installedFiles,
        unhandledFiles,
        explanation:
          'Every file here is one Mod Loader does not manage. That is normal for a plugin’s own .ini or .json, ' +
          'but if the mod does nothing in-game, its plugin is probably somewhere else.'
      }
    }
    return {
      folder,
      verdict: 'inert' as const,
      installedFiles,
      unhandledFiles,
      explanation: 'Mod Loader found the folder but no file it could install.'
    }
  })

  return { version, mods, looseUnhandled, crash: parseCrashDump(text) }
}

/**
 * Mod Loader installs its own crash handler and writes a register dump, a stack
 * dump and a backtrace straight into this log. It is far better than the
 * Windows Event Log: the Event Log gives one address, this gives the call path,
 * the register state at the moment of the fault, and the last file the
 * streamer touched.
 */
export function parseCrashDump(text: string): ModLoaderCrash | null {
  const start = text.search(/Game has crashed|Unhandled exception|EXCEPTION_/i)
  if (start < 0) return null
  const tail = text.slice(start)

  const reason =
    /(?:Unhandled exception|Game has crashed)[^\r\n]*/i.exec(tail)?.[0]?.trim() ??
    /EXCEPTION_[A-Z_]+/.exec(tail)?.[0] ??
    'Mod Loader recorded a crash'

  // This is the address the process faulted at, as the process saw it: the
  // image base is already in it. It is NOT a fault offset, and the caller is
  // told so by addressIsAbsolute below.
  const address = /(?:at|address)\s+(0x[0-9A-Fa-f]{6,16})/i.exec(tail)?.[1] ?? /\b(0x[0-9A-Fa-f]{8})\b/.exec(tail)?.[1] ?? null
  const module = /in module "?([A-Za-z0-9_.\- ]+\.(?:exe|dll|asi))"?/i.exec(tail)?.[1] ?? null

  const backtrace: string[] = []
  const btStart = tail.search(/Backtrace|Stack ?trace|Call ?stack/i)
  if (btStart >= 0) {
    for (const line of tail.slice(btStart).split(/\r?\n/).slice(1)) {
      const t = line.trim()
      if (!t) break
      if (/^[-=]{3,}$/.test(t)) break
      backtrace.push(t)
      if (backtrace.length >= 24) break
    }
  }

  const registers = parseRegisterBlock(tail)
  const stack = parseStackBlock(tail)

  // "Opening file for streaming MODELS\GTA3.IMG" right before the fault names
  // what the game was reading when it died.
  const streamed = [...text.matchAll(/Opening file for streaming "?([^"\r\n]+)"?/gi)].pop()?.[1] ?? null
  const when = /\[(\d{4}-\d{2}-\d{2}[^\]]*)\]/.exec(tail)?.[1] ?? null

  return {
    occurredAt: when,
    reason,
    address,
    addressIsAbsolute: true,
    module,
    backtrace,
    lastStreamedFile: streamed,
    registers,
    stack
  }
}

/**
 * The register dump: one or more "NAME=VALUE" or "NAME: VALUE" pairs, e.g.
 * "ECX=FFFFFFFF" or "EIP: 005B8E55". This is exactly what makes a crash like
 * the spec's worked example solvable - ECX = 0xFFFFFFFF is why a "this ==
 * -1" call is the diagnosis, not just an address. Read up to the next named
 * section or a blank line, so it never swallows the stack dump or backtrace
 * that usually follow it.
 */
function parseRegisterBlock(tail: string): Record<string, string> {
  const registers: Record<string, string> = {}
  const start = tail.search(/Register(?:s|\s+dump)?\s*:?/i)
  if (start < 0) return registers

  const rest = tail.slice(start)
  const bodyStart = rest.search(/\r?\n/)
  if (bodyStart < 0) return registers
  const body = rest.slice(bodyStart)
  const end = body.search(/\r?\n\s*\r?\n|Stack ?dump|Backtrace|Call ?stack/i)
  const region = end >= 0 ? body.slice(0, end) : body.slice(0, 600)

  for (const m of region.matchAll(/\b([A-Z]{2,4})\s*[=:]\s*(0x[0-9A-Fa-f]+|[0-9A-Fa-f]{4,8})\b/g)) {
    const digits = m[2].replace(/^0x/i, '').toUpperCase()
    registers[m[1].toUpperCase()] = `0x${digits}`
  }
  return registers
}

/** The raw stack-dump lines, kept as written - they are read as hex, not parsed further. */
function parseStackBlock(tail: string): string[] {
  const stack: string[] = []
  const start = tail.search(/Stack ?dump/i)
  if (start < 0) return stack
  for (const line of tail.slice(start).split(/\r?\n/).slice(1)) {
    const t = line.trim()
    if (!t) break
    if (/^[-=]{3,}$/.test(t)) break
    if (/^(Backtrace|Call ?stack)\b/i.test(t)) break
    stack.push(t)
    if (stack.length >= 32) break
  }
  return stack
}

export async function reportFromGame(gamePath: string, expected: string[] = []): Promise<ModLoaderLogReport | null> {
  const text = await readModLoaderLog(gamePath)
  if (text === null) return null
  return { path: modloaderLogPath(gamePath), readAt: new Date().toISOString(), ...parseModLoaderLog(text, expected) }
}
