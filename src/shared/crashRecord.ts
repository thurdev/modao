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

/**
 * What a modloader.log dump is recorded against when it names no module.
 *
 * Mod Loader's crash handler is San Andreas-only (`game.supportsModLoader`
 * gates the whole scan), and its dump is written by a hook inside the running
 * gta_sa.exe, so "no module line" means the executable rather than an unknown
 * foreign DLL. The row has always been STORED that way; the addressing
 * decision used to be taken from the bare null instead, which classified the
 * absolute address as foreign and refused to look it up in CrashList - while
 * the very same row claimed, in its `module` column, that it came from the
 * exe. One value, used for both, so the two cannot disagree again.
 */
export const MODLOADER_DEFAULT_MODULE = 'gta_sa.exe'

/** The columns a crash_report row carries for addressing. */
export interface StoredCrashAddressing {
  /**
   * The module column, AS STORED - fallbacks already applied. Callers write
   * this rather than the raw source value: the addressing above was decided
   * from it, and a row whose module column disagrees with the addressing that
   * produced it is a row that cannot be read back correctly.
   */
  module: string
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
    // The fallback is applied HERE, before the addressing is decided, and the
    // module it produces is returned for the caller to store. A dump with no
    // module line used to take this decision from an empty string - "unknown
    // foreign module", never looked up in CrashList - and then be written to
    // the database as gta_sa.exe anyway.
    const module = (source.module ?? '').trim() || MODLOADER_DEFAULT_MODULE
    const raw = source.address ?? ''
    const addressing = describeAbsoluteAddress(module, raw)
    return {
      module,
      faultOffset: '',
      crashAddress: addressing.display || raw,
      addressKind: addressing.kind,
      addressNote: addressing.note,
      lookupAddress: addressing.lookupAddress,
      moduleUnloaded: parseModuleName(module).unloaded
    }
  }

  const moduleUnloaded = parseModuleName(source.module).unloaded
  if (source.kind === 'hang') {
    // A hang produces no exception and no address at all. The absence is the
    // diagnosis; there is nothing to look up.
    return {
      module: source.module,
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
    module: source.module,
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
