import { describeAbsoluteAddress, parseModuleName, resolveCrashAddress, type CrashAddressing } from './crash'

/**
 * What gets written into a crash_report row, and what comes back out of one.
 *
 * This is the decision the field report caught being made wrongly, so it lives
 * here rather than inline in src/main/diagnostics/eventlog.ts: that module
 * reaches the Windows Event Log through PowerShell and the database through
 * better-sqlite3, neither of which loads outside Electron, and a rule that
 * cannot be tested is a rule that quietly stops holding.
 *
 * The rule itself is one sentence: the image base is added exactly once, by
 * whichever of the two functions in ./crash matches what the SOURCE reported -
 * an offset from the Event Log, or an already-absolute address from Mod
 * Loader's own crash handler - and nothing downstream ever adds it again.
 */

/** Where a crash record came from, and what that source actually measured. */
export type CrashAddressSource =
  /** The Windows Event Log: "Fault offset: 0x000C0C63", relative to the module. */
  | { from: 'eventlog'; kind: 'exception' | 'hang'; module: string; faultOffset: string }
  /** modloader.log: the address the process faulted at, image base included. */
  | { from: 'modloader'; module: string | null; address: string | null }

/** The columns a crash_report row carries for addressing. */
export interface StoredCrashAddressing {
  /**
   * The fault_offset column. EMPTY for any source that reports an absolute
   * address: storing one here is what made the read path re-derive
   * base + already-based-address on every read.
   */
  faultOffset: string
  /** The crash_address column: the finished address, computed once. */
  crashAddress: string
  addressKind: CrashAddressing['kind']
  addressNote: string | null
  /** Non-null only when CrashList may be asked - that is, only inside the exe. */
  lookupAddress: string | null
  /** Windows marks a module "_unloaded" when it was already gone at fault time. */
  moduleUnloaded: boolean
}

/**
 * Turns what a source reported into what gets stored.
 *
 * An Event Log offset goes through resolveCrashAddress, which adds the image
 * base. A modloader.log address goes through describeAbsoluteAddress, which
 * does not, because the base is already in it - putting 0x005B8E55 through the
 * first one yields 0x009B8E55, an address that means nothing.
 */
export function addressingForStorage(source: CrashAddressSource): StoredCrashAddressing {
  if (source.from === 'modloader') {
    const module = source.module ?? ''
    const raw = source.address ?? ''
    const addressing = module ? describeAbsoluteAddress(module, raw) : null
    return {
      faultOffset: '',
      crashAddress: addressing?.display ?? raw,
      addressKind: addressing?.kind ?? 'none',
      addressNote: addressing?.note ?? null,
      lookupAddress: addressing?.lookupAddress ?? null,
      moduleUnloaded: parseModuleName(module).unloaded
    }
  }

  const moduleUnloaded = parseModuleName(source.module).unloaded
  if (source.kind === 'hang') {
    // A hang produces no exception and no address at all. The absence is the
    // diagnosis; there is nothing to look up.
    return {
      faultOffset: source.faultOffset,
      crashAddress: '',
      addressKind: 'none',
      addressNote: null,
      lookupAddress: null,
      moduleUnloaded
    }
  }

  const addressing = resolveCrashAddress(source.module, source.faultOffset)
  return {
    faultOffset: source.faultOffset,
    crashAddress: addressing.display,
    addressKind: addressing.kind,
    addressNote: addressing.note,
    lookupAddress: addressing.lookupAddress,
    moduleUnloaded
  }
}

/** A crash_report row, in the only columns addressing depends on. */
export interface CrashAddressRow {
  kind: string
  module: string
  faultOffset: string
  crashAddress: string
  /** Null on rows written before the module-aware scan existed. */
  addressKind: string | null
  addressNote: string | null
}

export interface ReadCrashAddressing {
  crashAddress: string
  addressKind: CrashAddressing['kind']
  addressNote: string | null
  /** True when the row predated address_kind and had to be worked out again. */
  derived: boolean
}

/**
 * Reads a stored row back.
 *
 * A row that carries address_kind was written by the module-aware scan and
 * already holds the finished address: it is returned as stored, never
 * recomputed, or an absolute address would have the image base added to it
 * again on every single read.
 *
 * Only a legacy row - written before that column existed - is derived, and for
 * those the derivation wins over the stored value: those rows hold the old
 * exe-only guess, so a DLL fault has an exe address sitting in crash_address
 * that must not be shown.
 */
export function addressingFromStoredRow(row: CrashAddressRow): ReadCrashAddressing {
  if (row.addressKind !== null) {
    return {
      crashAddress: row.crashAddress,
      addressKind: (row.addressKind as CrashAddressing['kind']) || 'none',
      addressNote: row.addressNote,
      derived: false
    }
  }
  if (row.kind === 'hang') {
    return { crashAddress: row.crashAddress, addressKind: 'none', addressNote: row.addressNote, derived: false }
  }
  const addressing = resolveCrashAddress(row.module, row.faultOffset)
  return {
    crashAddress: addressing.display,
    addressKind: addressing.kind,
    addressNote: row.addressNote ?? addressing.note,
    derived: true
  }
}
