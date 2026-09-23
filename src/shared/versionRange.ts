/**
 * Scene version strings, compared without a semver library.
 *
 * "4.4.4", "v1.0", "CLEO 4.3" and ">= 4.4" all turn up in the same field, so
 * both sides are reduced to a list of numbers and compared segment by segment.
 * This lived inside `src/main/deps/resolver.ts`, which reaches the database and
 * therefore Electron; the pre-launch CLEO gate has to answer the same question
 * in a function a unit test can import, so the comparison moved here and the
 * resolver re-exports it.
 */

/**
 * Handles ">= 4.4", "> 4.4", "4.4+", "4.4 - 5.0", "<= 5", "< 5" and bare
 * versions.
 *
 * EVERY COMPARATOR IS SPELLED OUT, STRICT AND INCLUSIVE APART. One regex used
 * to cover both ends of each pair - `>=?` matched a bare `>` and then answered
 * it with `>=`, so `satisfiesRange('4.3', '>4.4')` came back TRUE and every
 * dependency and CLEO gate quietly accepted a version the author had excluded.
 * `<=` had the mirror of the same hole from the other side: `<` alone did not
 * match it, so "<= 5" fell through to the bare-version branch and was read as
 * "exactly 5", refusing 4.9.
 *
 * A strict `>` is SUPPORTED, not rejected: it is a range an author can
 * reasonably write ("> 4.3" for a plugin that needs a fix that landed after
 * 4.3), and the safe reading of an unrecognised range in this file is `true` -
 * so rejecting it would put it back to accepting everything, which is the bug.
 * Anything this function still does not recognise keeps that permissive
 * fallback deliberately: a range nobody can parse must not invent a refusal.
 */
export function satisfiesRange(version: string | null, range: string | null): boolean {
  if (!range) return true
  if (!version) return false
  const v = parseVersion(version)
  if (!v) return true // unparseable installed version: do not block, warn elsewhere
  const trimmed = range.trim()
  const ge = /^>=\s*([\d.]+)$/.exec(trimmed) ?? /^([\d.]+)\s*\+$/.exec(trimmed)
  if (ge) return compareVersions(v, parseVersion(ge[1])!) >= 0
  const gt = /^>\s*([\d.]+)$/.exec(trimmed)
  if (gt) return compareVersions(v, parseVersion(gt[1])!) > 0
  const between = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(trimmed)
  if (between) {
    return compareVersions(v, parseVersion(between[1])!) >= 0 && compareVersions(v, parseVersion(between[2])!) <= 0
  }
  const le = /^<=\s*([\d.]+)$/.exec(trimmed)
  if (le) return compareVersions(v, parseVersion(le[1])!) <= 0
  const lt = /^<\s*([\d.]+)$/.exec(trimmed)
  if (lt) return compareVersions(v, parseVersion(lt[1])!) < 0
  const exact = parseVersion(trimmed)
  return exact ? compareVersions(v, exact) === 0 : true
}

/** The first dotted number in the string, or null when there is none. */
export function parseVersion(s: string): number[] | null {
  const m = /(\d+(?:\.\d+)*)/.exec(s)
  if (!m) return null
  return m[1].split('.').map((n) => Number.parseInt(n, 10))
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
