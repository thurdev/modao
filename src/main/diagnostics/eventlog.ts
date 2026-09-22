import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CrashIncident, CrashReport } from '@shared/types'
import { getDb } from '../db'
import { lookup } from './crashlist'
import { describeAbsoluteAddress, groupIncidents, parseModuleName, resolveCrashAddress } from '@shared/crash'
import { activeGame } from '../game/detect'

const execFileAsync = promisify(execFile)

export interface RawCrashEvent {
  timeCreated: string
  message: string
  provider: string
}

/**
 * Reads crash records straight out of the Windows Event Log:
 *   Log "Application", provider "Application Error", matching gta_sa.exe.
 *
 * A hang is different: it produces either an "Application Hang" record or no
 * record at all. The absence of an entry is itself diagnostic - it means the
 * game stopped responding rather than crashing, which rules out the whole
 * exception-address workflow.
 */
export async function readCrashEvents(maxEvents = 200): Promise<RawCrashEvent[]> {
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$events = Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName=@('Application Error','Application Hang')} -MaxEvents ${maxEvents}
$events | Where-Object { $_.Message -like '*gta_sa.exe*' } |
  Select-Object @{n='timeCreated';e={$_.TimeCreated.ToString('o')}},
                @{n='provider';e={$_.ProviderName}},
                @{n='message';e={$_.Message}} |
  ConvertTo-Json -Depth 3 -Compress
`
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }
  ).catch((e: Error & { stdout?: string }) => ({ stdout: e.stdout ?? '' }))

  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as RawCrashEvent | RawCrashEvent[]
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

export interface ParsedCrash {
  occurredAt: string
  module: string
  exceptionCode: string
  faultOffset: string
  /** Windows reports the pid of the dead process; every record from one run shares it. */
  processId: string
  /** The faulting module was already unloaded when the fault hit. */
  moduleUnloaded: boolean
  kind: 'exception' | 'hang'
  raw: string
}

export function parseCrashEvent(ev: RawCrashEvent): ParsedCrash | null {
  const msg = ev.message ?? ''
  if (!/gta_sa\.exe/i.test(msg)) return null
  // Every record Windows writes for one dead process carries the same pid, which
  // is what turns four log lines into one incident.
  const processId = /Faulting process id:\s*(0x[0-9A-Fa-f]+|\d+)/i.exec(msg)?.[1]?.toLowerCase() ?? ''
  if (/Application Hang/i.test(ev.provider)) {
    return {
      occurredAt: ev.timeCreated,
      module: 'gta_sa.exe',
      exceptionCode: '',
      faultOffset: '',
      processId,
      moduleUnloaded: false,
      kind: 'hang',
      raw: msg
    }
  }
  const module = /Faulting module name:\s*([^,\r\n]+)/i.exec(msg)?.[1]?.trim() ?? 'unknown'
  const exceptionCode = /Exception code:\s*(0x[0-9A-Fa-f]+)/i.exec(msg)?.[1] ?? ''
  const faultOffset = /Fault offset:\s*(0x[0-9A-Fa-f]+)/i.exec(msg)?.[1] ?? ''
  if (!faultOffset) return null
  return {
    occurredAt: ev.timeCreated,
    module,
    exceptionCode,
    faultOffset,
    processId,
    moduleUnloaded: parseModuleName(module).unloaded,
    kind: 'exception',
    raw: msg
  }
}

export interface ScanResult {
  found: number
  added: number
  hangSuspected: boolean
  message: string
}

export async function scanCrashes(profileId: number | null): Promise<ScanResult> {
  // Mod Loader writes its own crash handler's output - registers, stack, a
  // backtrace and the last file the streamer opened - straight into
  // modloader.log. That is a better account of the crash than the single
  // address the Windows Event Log records, so it is read first.
  const fromModLoader = await scanModLoaderCrash(profileId)
  const events = await readCrashEvents()
  const db = getDb()
  let added = 0
  let hangs = 0

  for (const ev of events) {
    const parsed = parseCrashEvent(ev)
    if (!parsed) continue
    if (parsed.kind === 'hang') hangs++

    // Only a fault inside gta_sa.exe has an absolute address CrashList can
    // answer for; a DLL offset looked up against the exe index is a wrong answer
    // stated confidently.
    const addressing =
      parsed.kind === 'exception'
        ? resolveCrashAddress(parsed.module, parsed.faultOffset)
        : { kind: 'none' as const, display: '', lookupAddress: null, note: null }
    const match = addressing.lookupAddress ? await lookup(addressing.lookupAddress) : null
    const cause = match?.cause ?? (match?.nearest ? `${match.nearest.cause} (nearest known address ${match.nearest.address})` : null)

    const info = db
      .prepare(
        `INSERT OR IGNORE INTO crash_report
           (profile_id, occurred_at, fault_offset, module, exception_code, crash_address, matched_cause, matched_solution,
            kind, raw, resolved, process_id, module_unloaded, address_kind, address_note)
         VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`
      )
      .run(
        profileId,
        parsed.occurredAt,
        parsed.faultOffset,
        parsed.module,
        parsed.exceptionCode,
        addressing.display,
        cause,
        match?.solution ?? null,
        parsed.kind,
        parsed.raw,
        parsed.processId,
        parsed.moduleUnloaded ? 1 : 0,
        addressing.kind,
        addressing.note
      )
    if (info.changes > 0) added++
  }

  added += fromModLoader.added
  const message =
    events.length === 0 && fromModLoader.added === 0
      ? 'No "Application Error" record for gta_sa.exe in the Windows Event Log. If the game stopped responding rather than closing, that is expected: a hang leaves no exception record, and the absence of one rules out a crash address entirely.'
      : `${events.length} event(s) found, ${added} new.${hangs ? ` ${hangs} were hangs (no fault address available).` : ''}`

  return {
    found: events.length + fromModLoader.added,
    added,
    hangSuspected: events.length === 0 && fromModLoader.added === 0,
    message: fromModLoader.note ? `${message} ${fromModLoader.note}` : message
  }
}

export function listCrashes(profileId: number | null): CrashReport[] {
  const rows = getDb()
    .prepare(
      profileId === null
        ? 'SELECT * FROM crash_report ORDER BY occurred_at DESC LIMIT 100'
        : 'SELECT * FROM crash_report WHERE profile_id = ? OR profile_id IS NULL ORDER BY occurred_at DESC LIMIT 100'
    )
    .all(...(profileId === null ? [] : [profileId])) as {
    id: number
    profile_id: number | null
    occurred_at: string
    fault_offset: string
    module: string
    exception_code: string
    crash_address: string
    matched_cause: string | null
    matched_solution: string | null
    kind: string
    raw: string
    resolved: number
    process_id: string | null
    module_unloaded: number | null
    address_kind: string | null
    address_note: string | null
  }[]
  return rows.map((r) => {
    // A row written by the module-aware scan already holds the finished
    // address, computed once at the single site that adds the image base -
    // reading it back must never re-derive it, or an absolute address from
    // modloader.log gets the base added a second time on every read.
    //
    // Only rows written before address_kind existed are derived here, and for
    // those the derivation is authoritative: a stale exe-era address stored
    // against a DLL fault must not leak back out.
    const legacy =
      r.address_kind === null && r.kind !== 'hang' ? resolveCrashAddress(r.module, r.fault_offset) : null
    const kind = (r.address_kind as CrashReport['addressKind'] | null) ?? legacy?.kind ?? 'none'
    return {
      id: r.id,
      profileId: r.profile_id,
      occurredAt: r.occurred_at,
      faultOffset: r.fault_offset,
      module: parseModuleName(r.module).name,
      moduleRaw: r.module,
      moduleUnloaded: r.module_unloaded === null ? parseModuleName(r.module).unloaded : !!r.module_unloaded,
      processId: r.process_id ?? '',
      exceptionCode: r.exception_code,
      crashAddress: legacy ? legacy.display : r.crash_address,
      addressKind: kind,
      addressNote: r.address_note ?? legacy?.note ?? null,
      matchedCause: kind === 'exe' ? r.matched_cause : null,
      matchedSolution: kind === 'exe' ? r.matched_solution : null,
      resolved: !!r.resolved,
      kind: r.kind === 'hang' ? 'hang' : 'exception',
      raw: r.raw
    }
  })
}

export { groupIncidents }

export function listIncidents(profileId: number | null): CrashIncident[] {
  return groupIncidents(listCrashes(profileId))
}

export function setCrashResolved(id: number, resolved: boolean): void {
  getDb().prepare('UPDATE crash_report SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, id)
}

/**
 * Records the crash Mod Loader itself caught, if the log holds one.
 *
 * It is stored beside the Event Log records so the history is one list, and it
 * is kept distinct by its own timestamp: a Mod Loader dump and the Windows
 * record of the same crash are two accounts of one event, and the Mod Loader
 * one carries the backtrace.
 */
async function scanModLoaderCrash(profileId: number | null): Promise<{ added: number; note: string | null }> {
  const game = activeGame()
  if (!game?.supportsModLoader) return { added: 0, note: null }

  const { readModLoaderLog, parseCrashDump } = await import('./modloaderLog')
  const text = await readModLoaderLog(game.path).catch(() => null)
  if (!text) return { added: 0, note: null }
  const crash = parseCrashDump(text)
  if (!crash) return { added: 0, note: null }

  const occurredAt = crash.occurredAt ?? new Date().toISOString()
  // modloader.log records the address the process faulted at - the image base
  // is already in it (crash.addressIsAbsolute). Putting it through
  // resolveCrashAddress would add 0x400000 to a number that has it, turning the
  // real 0x005B8E55 into a meaningless 0x009B8E55.
  const addressing = crash.module ? describeAbsoluteAddress(crash.module, crash.address ?? '') : null
  const detail = [
    crash.reason,
    crash.lastStreamedFile ? `Last file opened for streaming: ${crash.lastStreamedFile}` : '',
    crash.backtrace.length ? `Backtrace:\n${crash.backtrace.join('\n')}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO crash_report
         (profile_id, occurred_at, fault_offset, module, exception_code, crash_address, matched_cause, matched_solution,
          kind, raw, resolved, process_id, module_unloaded, address_kind, address_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,0,?,0,?,?)`
    )
    .run(
      profileId,
      occurredAt,
      // fault_offset stays EMPTY: this source reports no offset, and storing
      // the absolute address in that column is what made listCrashes re-derive
      // base + already-based-address on every read.
      '',
      crash.module ?? 'gta_sa.exe',
      '',
      addressing?.display ?? crash.address ?? '',
      null,
      null,
      'exception',
      detail,
      'modloader.log',
      addressing?.kind ?? 'none',
      addressing?.note ?? null
    )

  return {
    added: info.changes > 0 ? 1 : 0,
    note:
      info.changes > 0
        ? 'Mod Loader had recorded this crash itself, with a backtrace - that record was read too.'
        : null
  }
}
