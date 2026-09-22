import type { RatingInputs } from '@shared/types'
import { getDb } from '../db'

/**
 * MixMods has no star rating, so Modão synthesises one. The score is never
 * shown on its own: the UI always renders these inputs next to it, because a
 * synthesised number that cannot be inspected is worse than no number.
 */
export const RATING_WEIGHTS = {
  recency: 0.25,
  authorReputation: 0.15,
  essentials: 0.25,
  requiredBy: 0.2,
  telemetry: 0.15
} as const

export function computeRating(inputs: RatingInputs): number {
  const requiredBy = Math.min(1, inputs.requiredByCount / 5)
  const installs = Math.min(1, inputs.installCount / 10)
  const disableRate = inputs.installCount > 0 ? inputs.earlyDisableCount / inputs.installCount : 0
  const telemetry = Math.max(0, installs - disableRate)
  const score =
    RATING_WEIGHTS.recency * inputs.recency +
    RATING_WEIGHTS.authorReputation * inputs.authorReputation +
    RATING_WEIGHTS.essentials * (inputs.inEssentials ? 1 : 0) +
    RATING_WEIGHTS.requiredBy * requiredBy +
    RATING_WEIGHTS.telemetry * telemetry
  return Math.round(score * 100) / 100
}

export function explainRating(inputs: RatingInputs): string[] {
  const out: string[] = []
  out.push(`Updated recently: ${(inputs.recency * 100).toFixed(0)}% recency score`)
  out.push(`Author footprint: ${(inputs.authorReputation * 100).toFixed(0)}% (based on how many catalogue mods they published)`)
  if (inputs.inEssentials) out.push('Listed in the official MixMods Essentials pack')
  if (inputs.requiredByCount) out.push(`${inputs.requiredByCount} other catalogue mod(s) declare it as a requirement`)
  if (inputs.installCount) out.push(`Installed ${inputs.installCount}x locally, ${inputs.earlyDisableCount} early disable(s)`)
  if (!inputs.installCount) out.push('No local install telemetry yet')
  return out
}

interface RatingRow {
  id: number
  author: string
  updated_at: string | null
  published_at: string | null
  rating_inputs_json: string
}

export function ratingInputsFor(modId: number): RatingInputs {
  const db = getDb()
  const row = db.prepare('SELECT id, author, updated_at, published_at, rating_inputs_json FROM mod WHERE id = ?').get(modId) as
    | RatingRow
    | undefined
  if (!row) {
    return { recency: 0, authorReputation: 0, inEssentials: false, requiredByCount: 0, installCount: 0, earlyDisableCount: 0 }
  }
  const seeded = safeParse(row.rating_inputs_json)
  const date = row.updated_at ?? row.published_at
  const ageDays = date ? (Date.now() - new Date(date).getTime()) / 86_400_000 : 3650
  const recency = Number.isFinite(ageDays) ? Math.max(0, 1 - ageDays / 1825) : 0

  const authorMods = (db.prepare('SELECT COUNT(*) c FROM mod WHERE author = ?').get(row.author) as { c: number }).c
  const authorReputation = Math.min(1, authorMods / 12)

  const requiredByCount = (
    db.prepare('SELECT COUNT(*) c FROM dependency WHERE requires_mod_id = ? AND kind IN (?,?)').get(modId, 'requires', 'alt') as {
      c: number
    }
  ).c

  const tel = db.prepare('SELECT install_count, early_disable_count FROM telemetry WHERE mod_id = ?').get(modId) as
    | { install_count: number; early_disable_count: number }
    | undefined

  return {
    recency: seeded.recency ?? recency,
    authorReputation: Math.max(authorReputation, seeded.authorReputation ?? 0),
    inEssentials: seeded.inEssentials ?? false,
    requiredByCount: Math.max(requiredByCount, seeded.requiredByCount ?? 0),
    installCount: tel?.install_count ?? 0,
    earlyDisableCount: tel?.early_disable_count ?? 0,
    notes: seeded.notes
  }
}

function safeParse(json: string): Partial<RatingInputs> {
  try {
    return JSON.parse(json) as Partial<RatingInputs>
  } catch {
    return {}
  }
}

/** A mod disabled within an hour of installing counts against it. */
export function recordEarlyDisable(installId: number): void {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT mv.mod_id, i.installed_at FROM install i JOIN mod_version mv ON mv.id = i.mod_version_id WHERE i.id = ?`
    )
    .get(installId) as { mod_id: number; installed_at: string } | undefined
  if (!row) return
  if (Date.now() - new Date(row.installed_at).getTime() > 3_600_000) return
  db.prepare(
    `INSERT INTO telemetry (mod_id, install_count, early_disable_count) VALUES (?,0,1)
     ON CONFLICT(mod_id) DO UPDATE SET early_disable_count = early_disable_count + 1`
  ).run(row.mod_id)
}
