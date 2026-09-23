/**
 * MSVC mangles an integer non-type template argument as hex nibbles spelled
 * with the letters A-P (A=0 .. P=15), wrapped in "$0...@". A plugin-sdk .asi
 * built with no source code encodes the addresses it hooks exactly this way:
 * CollectiblesOnRadar.SA.asi carries the mangled names
 *
 *   $0FDOJIB@  ->  F D O J I B  ->  5 3 E 9 8 1  ->  0x53E981
 *
 * one per address it patches. This is the only way the app can see what such
 * a plugin touches without its source - and the only way it can notice two
 * mods hooking the same address, which is exactly the kind of collision that
 * shows up as "my mod does nothing" or a crash with no other explanation.
 *
 * Pure: no filesystem, no Electron. src/main/formats/strings.ts calls this
 * over the strings it already extracts from a plugin's own binary.
 */

const NIBBLE_LETTERS = /^[A-P]+$/

/** One mangled token, e.g. "$0FDOJIB@" - the wrapper is required. Null if malformed. */
export function decodeMangledHex(token: string): number | null {
  const m = /^\$0([A-P]+)@$/.exec(token.trim())
  if (!m) return null
  return decodeNibbles(m[1])
}

function decodeNibbles(letters: string): number | null {
  if (!NIBBLE_LETTERS.test(letters)) return null
  let hex = ''
  for (const ch of letters) hex += (ch.charCodeAt(0) - 65).toString(16).toUpperCase()
  const n = Number.parseInt(hex, 16)
  return Number.isFinite(n) ? n : null
}

const MANGLED_HEX = /\$0([A-P]+)@/g

/**
 * Every $0...@ address mangled anywhere inside a list of strings - the
 * mangled token is usually a substring of a longer decorated symbol name, not
 * a string on its own, so this searches rather than requiring an exact match.
 * Deduplicated and sorted.
 */
export function extractMangledAddresses(strings: string[]): number[] {
  const out = new Set<number>()
  for (const s of strings) {
    for (const m of s.matchAll(MANGLED_HEX)) {
      const n = decodeNibbles(m[1])
      if (n !== null) out.add(n)
    }
  }
  return [...out].sort((a, b) => a - b)
}
