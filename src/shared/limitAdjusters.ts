/**
 * Limit-adjuster IDENTITY, not just presence.
 *
 * `limitAdjusterNames()` (src/main/game/streamIni.ts) answers "is anything
 * here that can give the game the streaming memory stream.ini asks for" - one
 * regex, and every caller before this module used it as a boolean via
 * `.some()`. That is the right question for the stream.ini check, but it
 * throws away exactly the information needed to catch the field report's
 * other failure: the install had Open Limit Adjuster
 * (III.VC.SA.LimitAdjuster.asi) AND SimpleLimitAdjuster_Enex.asi both active
 * at once. Two different adjusters patch the same limits from two different
 * codebases; the CrashList warns explicitly that stacking limit adjusters
 * crashes the game. `.some()` sees "an adjuster is present" and stops there.
 *
 * This module keeps the same recognition patterns, split into a name ->
 * product table, so a caller can count DISTINCT products instead of merely
 * detecting one.
 *
 * Free of Electron and of the filesystem, like ./duplicateAssets.ts and
 * ./crashlist.ts - it is handed path/name strings already read off disk or
 * the DB, and returns a verdict.
 */

interface AdjusterProduct {
  id: string
  label: string
  pattern: RegExp
}

// Order matters: a product's own pattern must be checked before a generic one
// that would also match it, and each input is classified as ONE product only
// (first match wins). "III.VC.SA.LimitAdjuster.asi" is the actual file name
// Open Limit Adjuster ships under, so it is folded into that product rather
// than counted as a second one just because its file name also contains the
// word "LimitAdjuster".
const PRODUCTS: AdjusterProduct[] = [
  { id: 'open-limit-adjuster', label: 'Open Limit Adjuster', pattern: /open ?limit ?adjuster|iii\.vc\.sa\.limitadjuster/i },
  { id: 'simple-limit-adjuster', label: 'SimpleLimitAdjuster', pattern: /simple ?limit ?adjuster/i },
  { id: 'fastman92-limit-adjuster', label: "fastman92's Limit Adjuster", pattern: /fastman92/i },
  // Catches anything that only ever calls itself "LimitAdjuster" with no
  // further branding - keeps parity with the original bare regex in
  // src/main/game/streamIni.ts.
  { id: 'limit-adjuster', label: 'Limit Adjuster', pattern: /limit ?adjuster/i }
]

export interface IdentifiedAdjuster {
  id: string
  label: string
  /** The input strings that identified this product, in the order given. */
  matches: string[]
}

/**
 * Classifies each path/name against the product table above; returns only the
 * products actually found, each carrying the inputs that matched it so a
 * caller can name the exact files involved.
 */
export function identifyLimitAdjusters(paths: string[]): IdentifiedAdjuster[] {
  const byId = new Map<string, IdentifiedAdjuster>()
  for (const raw of paths) {
    const product = PRODUCTS.find((p) => p.pattern.test(raw))
    if (!product) continue
    let entry = byId.get(product.id)
    if (!entry) {
      entry = { id: product.id, label: product.label, matches: [] }
      byId.set(product.id, entry)
    }
    entry.matches.push(raw)
  }
  return [...byId.values()]
}
