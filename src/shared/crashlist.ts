import type { CrashListEntry } from './types'
import { IMAGE_BASE, normalizeAddress } from './crash'

/**
 * The CrashList grammar, as the community file actually writes it.
 *
 * The real CrashList is a pt-BR document, not an ini. One entry is a stanza:
 *
 *     Erro: 0x004C9691 0x00732924 0x00749B7B
 *     Causa: ...
 *     Solução: ...
 *
 * Three things follow from that, and all three were missing:
 *   - the address is not at the start of the line, "Erro:" is, so a parser
 *     anchored on hex matches nothing at all;
 *   - one stanza indexes SEVERAL addresses, so a single capture group loses
 *     every address but the first;
 *   - the runs are sometimes joined by "Ou" ("or"), which is a separator and
 *     not a terminator: every address on both sides belongs to the stanza.
 *
 * The older "ADDR = cause | solution" one-liner is still read, because the
 * bundled file was written that way and nothing is gained by breaking it.
 *
 * This module is deliberately free of Electron and of the filesystem: it is
 * the half of src/main/diagnostics/crashlist.ts that can be tested.
 */

const ERRO_LINE = /^(?:erro|error)s?\s*:/i
const CAUSA_LINE = /^(?:causa|cause|motivo)\s*:\s*/i
const SOLUCAO_LINE = /^(?:solu(?:ç|c)(?:ã|a)o|solution|fix|corre(?:ç|c)(?:ã|a)o)\s*:\s*/i
const LEGACY_LINE = /^(?:0x)?([0-9A-Fa-f]{6,8})\s*[=:\-\t]\s*(.+)$/
const OU_LINE = /^ou\b/i
const ADDRESS_TOKEN = /\b(?:0x[0-9A-Fa-f]{6,8}|[0-9A-Fa-f]{6,8})\b/gi

/** gta_sa.exe is ~14 MB, so nothing above this is an address in the executable. */
const MAX_EXE_ADDRESS = 0x01000000

/**
 * Every address on one line, normalised to the lookup key shape.
 *
 * A bare token has to look like an address and not like a pt-BR word that
 * happens to spell itself in hex digits: it must start with a zero and land
 * inside the executable's mapped range. A 0x-prefixed token is unambiguous
 * and is taken as written.
 */
export function collectAddresses(line: string): string[] {
  const out: string[] = []
  for (const match of line.matchAll(ADDRESS_TOKEN)) {
    const token = match[0]
    const prefixed = /^0x/i.test(token)
    const digits = token.replace(/^0x/i, '')
    const n = Number.parseInt(digits, 16)
    if (!Number.isFinite(n)) continue
    if (!prefixed && !(/^0/.test(digits) && n >= IMAGE_BASE && n <= MAX_EXE_ADDRESS)) continue
    const key = normalizeAddress(n)
    if (!out.includes(key)) out.push(key)
  }
  return out
}

/**
 * Reads the whole file into the lookup map. Every address a stanza names gets
 * its own key pointing at that stanza's cause and solution, so a crash at any
 * one of them is answered.
 */
export function parseCrashList(text: string): Map<string, CrashListEntry> {
  const map = new Map<string, CrashListEntry>()

  let addresses: string[] = []
  let cause: string[] = []
  let solution: string[] = []
  let target: 'cause' | 'solution' = 'cause'

  const flush = (): void => {
    const causeText = cause.join(' ').replace(/\s+/g, ' ').trim()
    const fix = solution.join(' ').replace(/\s+/g, ' ').trim()
    for (const address of addresses) {
      map.set(address, { address, cause: causeText, solution: fix || undefined })
    }
    addresses = []
    cause = []
    solution = []
    target = 'cause'
  }

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()

    // A blank line ends a stanza that has already said something; a comment is
    // never part of one.
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) {
      if (cause.length) flush()
      continue
    }

    if (ERRO_LINE.test(line)) {
      flush()
      addresses = collectAddresses(line)
      continue
    }

    if (addresses.length) {
      if (CAUSA_LINE.test(line)) {
        target = 'cause'
        cause.push(line.replace(CAUSA_LINE, '').trim())
        continue
      }
      if (SOLUCAO_LINE.test(line)) {
        target = 'solution'
        solution.push(line.replace(SOLUCAO_LINE, '').trim())
        continue
      }
      if (LEGACY_LINE.test(line)) {
        flush()
        // falls through to the one-liner below
      } else if (!cause.length && OU_LINE.test(line)) {
        // "Ou 0x00801D58 0x005D9802" continued onto its own line.
        for (const address of collectAddresses(line)) {
          if (!addresses.includes(address)) addresses.push(address)
        }
        continue
      } else {
        ;(target === 'cause' ? cause : solution).push(line)
        continue
      }
    }

    const m = LEGACY_LINE.exec(line)
    if (!m) continue
    const [causeRaw, fix] = m[2].split('|').map((s) => s.trim())
    const key = normalizeAddress(m[1])
    map.set(key, { address: key, cause: causeRaw, solution: fix || undefined })
  }

  flush()
  return map
}
