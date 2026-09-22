import type { CrashIncident, CrashReport } from './types'

/** GTA SA's PE image base. A crash address inside the exe is base + fault offset. */
export const IMAGE_BASE = 0x400000

export function normalizeAddress(addr: string | number): string {
  const n = typeof addr === 'number' ? addr : Number.parseInt(addr.replace(/^0x/i, ''), 16)
  return `0x${n.toString(16).toUpperCase().padStart(8, '0')}`
}

/** The faulting module as the Event Log names it, and what that name means. */
export interface ModuleName {
  /** The module with any "_unloaded" marker stripped: "std.data.dll". */
  name: string
  /** Windows appends _unloaded when the DLL was already gone when the fault hit. */
  unloaded: boolean
  isExe: boolean
}

export function parseModuleName(raw: string): ModuleName {
  const trimmed = (raw ?? '').trim()
  const unloaded = /_unloaded$/i.test(trimmed)
  const name = unloaded ? trimmed.replace(/_unloaded$/i, '') : trimmed
  return { name, unloaded, isExe: /^gta_sa\.exe$/i.test(name) }
}

export interface CrashAddressing {
  /** exe: an absolute address CrashList can answer for. module: an offset inside some DLL. */
  kind: 'exe' | 'module' | 'none'
  /** What the user is shown: "0x004C0C63", or "std.data.dll+0x0001A2B0". */
  display: string
  /** Only ever set for kind "exe"; nothing else may be looked up. */
  lookupAddress: string | null
  /** Why no lookup happened, in the words the UI shows. */
  note: string | null
}

/**
 * gta_sa.exe loads at 0x400000, so a fault inside the exe has a real address:
 * image base plus fault offset, which CrashList - an index of exe addresses and
 * nothing else - can be asked about.
 *
 * A fault inside a DLL reports an offset relative to that DLL's own base, which
 * Windows does not tell us. Adding 0x400000 to it names an address in the exe
 * that had nothing to do with the crash, and looking that up produces a
 * confident, wrong diagnosis. So it is shown as module+offset and never looked up.
 */
export function resolveCrashAddress(module: string, faultOffset: string): CrashAddressing {
  const m = parseModuleName(module)
  const raw = String(faultOffset ?? '').trim()
  if (!raw) return { kind: 'none', display: '', lookupAddress: null, note: 'No fault offset was recorded.' }
  const off = Number.parseInt(raw.replace(/^0x/i, ''), 16)
  if (!Number.isFinite(off)) {
    return { kind: 'none', display: raw, lookupAddress: null, note: 'The fault offset could not be read.' }
  }
  if (m.isExe) {
    // The ONLY place in the codebase that adds the image base. Everything that
    // needs an absolute address goes through here or through a value this
    // produced; nothing adds it a second time.
    const address = normalizeAddress(IMAGE_BASE + off)
    return { kind: 'exe', display: address, lookupAddress: address, note: null }
  }
  return {
    kind: 'module',
    display: `${m.name || 'unknown module'}+0x${off.toString(16).toUpperCase().padStart(8, '0')}`,
    lookupAddress: null,
    note: foreignModuleNote(m.name)
  }
}

/**
 * The same answer for a source that already reports an ABSOLUTE address.
 *
 * Mod Loader's own crash handler writes the address as the process saw it -
 * image base included - so running it through resolveCrashAddress adds
 * 0x400000 to a number that already has it and produces the 0x009B8E55 shape
 * the field report describes. This normalises and adds nothing.
 */
export function describeAbsoluteAddress(module: string, absolute: string): CrashAddressing {
  const m = parseModuleName(module)
  const raw = String(absolute ?? '').trim()
  if (!raw) return { kind: 'none', display: '', lookupAddress: null, note: 'No crash address was recorded.' }
  const n = Number.parseInt(raw.replace(/^0x/i, ''), 16)
  if (!Number.isFinite(n)) {
    return { kind: 'none', display: raw, lookupAddress: null, note: 'The crash address could not be read.' }
  }
  const address = normalizeAddress(n)
  if (m.isExe) return { kind: 'exe', display: address, lookupAddress: address, note: null }
  return {
    kind: 'module',
    // Absolute, so there is no offset to show: the DLL's own base is unknown.
    display: `${m.name || 'unknown module'} @ ${address}`,
    lookupAddress: null,
    note: foreignModuleNote(m.name)
  }
}

function foreignModuleNote(name: string): string {
  return (
    `The fault is inside ${name || 'another module'}, not gta_sa.exe. CrashList indexes addresses in the ` +
    'executable only, so there is nothing to look this up against: the offset is relative to that module, ' +
    'and Windows does not report where it was loaded.'
  )
}

/** The line to show for a module that was already unloaded when the fault hit. */
export const UNLOADED_NOTE =
  'Windows marked this module as already unloaded, which usually means it was caught on the way down rather ' +
  'than being what brought the game down. The earlier event in the same crash is the one worth reading.'

/**
 * One dying game writes several records: the fault itself, then whatever else
 * fell over on the way down. Listed separately, one crash looks like four and a
 * shutdown artefact sits at the top.
 *
 * Records are grouped by faulting process id - every record from one run of the
 * game shares it - and the primary event is the EARLIEST in the group whose
 * module Windows did not mark "_unloaded". Records with no pid (older rows) fall
 * back to grouping by the second they occurred in.
 */
export function groupIncidents(reports: CrashReport[]): CrashIncident[] {
  const groups = new Map<string, CrashReport[]>()
  for (const r of reports) {
    const key = r.processId ? `pid:${r.processId}` : `time:${r.occurredAt.slice(0, 19)}`
    const list = groups.get(key)
    if (list) list.push(r)
    else groups.set(key, [r])
  }
  const out: CrashIncident[] = []
  for (const [key, list] of groups) {
    const ordered = [...list].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id - b.id)
    const primary = ordered.find((r) => !r.moduleUnloaded) ?? ordered[0]
    out.push({
      key,
      processId: primary.processId,
      occurredAt: ordered[0].occurredAt,
      primary,
      related: ordered.filter((r) => r.id !== primary.id),
      onlyUnloaded: ordered.every((r) => r.moduleUnloaded)
    })
  }
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
}
