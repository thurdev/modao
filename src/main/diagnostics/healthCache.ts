import fs from 'node:fs'
import type { HealthReport } from '@shared/types'
import {
  installFingerprint,
  reportIsReusable,
  reportKey,
  REPORT_MAX_AGE_MS,
  type CachedReportStamp
} from '@shared/prelaunch'
import { getDb } from '../db'
import { streamIniCandidates } from '../game/streamIni'
import { runHealthCheck } from './health'

/**
 * One pre-launch report, kept just long enough to be pressed twice.
 *
 * The launch gate has to consult a report, and the full check is not cheap:
 * sixty .txd parses, a walk of every install, a release lookup. Someone who
 * opens Health, reads the verdict and presses Play must not pay for it twice -
 * and someone who presses Play alone must not wait on work that was already
 * done seconds ago.
 *
 * The cache is deliberately conservative. It answers only for the same game and
 * profile, only while the fingerprint below still matches, and only for two
 * minutes. Anything else re-runs. The strictness of the refusal itself is
 * untouched by all of this: a reused report is a report that would have come
 * out identical.
 */

let stamp: CachedReportStamp | null = null
let stored: HealthReport | null = null

/** Drop the stored report: the next caller runs the checks again. */
export function forgetHealthReport(): void {
  stamp = null
  stored = null
}

/**
 * What the report was computed from, as cheaply as it can be asked.
 *
 * Covers the things that change under a user's hands between one Play and the
 * next: which installs the profile has, whether each one is enabled, which
 * variant each one has chosen - both of those per row and not as a total, since
 * a count cannot tell "disable A, enable B" from "nothing happened", and
 * `switchVariant` rewrites only `variant_choice` on a row already counted - and
 * stream.ini, the file the whole gate exists for, which the offered fix
 * rewrites. Everything slower-moving is left to the age backstop.
 *
 * KNOWN LIMITATION, pre-existing and deliberately shipped: an IN-PLACE EDIT of
 * a file inside an install does not invalidate anything here. Nothing in this
 * fingerprint reads the content of an installed file - doing that means hashing
 * or stat-ing every file of every install on the path to the Play button, which
 * is the cost this cache exists to avoid. So for up to REPORT_MAX_AGE_MS after
 * a report is taken, a .cleo, .asi or .ini rewritten by an external editor (or
 * by the user in Notepad) is judged by the report taken before the edit.
 *
 * THE SECOND GAP IS CLOSED, and not here: two operations change what the game
 * will load without moving any row this fingerprint reads. `setSubModEnabled`
 * writes `submod_state` and renames a folder; `reuniteOrphans` moves a plugin
 * between two paths that already exist. Neither touches
 * install.id/enabled/variant_choice and neither rewrites stream.ini, yet both
 * flip `stacked-adjuster` or `duplicate-asi` - fail-level checks that read the
 * DISK - so inside the TTL the gate could be handed a report taken before the
 * blocking file was there.
 *
 * Each of those two now calls `forgetHealthReport()` itself, at the operation
 * rather than at the IPC handler, so every caller is covered. That is the
 * cheap half of the trade deliberately: fingerprinting what they change means
 * hashing or stat-ing every file of every install on the path to the Play
 * button, which is the precise cost this cache exists to avoid. Anything else
 * that mutates the game folder without moving a fingerprinted row belongs in
 * that list - never in a longer TTL.
 */
function fingerprint(profileId: number | null, gamePath: string): string {
  const parts: string[] = []

  if (profileId !== null) {
    const rows = getDb()
      .prepare(`SELECT id, enabled, variant_choice FROM install WHERE profile_id = ?`)
      .all(profileId) as { id: number; enabled: number | null; variant_choice: string | null }[]
    parts.push(
      installFingerprint(rows.map((r) => ({ id: r.id, enabled: r.enabled, variantChoice: r.variant_choice })))
    )
  } else {
    parts.push('i:none')
  }

  for (const candidate of streamIniCandidates(gamePath)) {
    try {
      const st = fs.statSync(candidate)
      parts.push(`s:${Math.round(st.mtimeMs)}/${st.size}`)
    } catch {
      parts.push('s:-')
    }
  }

  return parts.join(';')
}

/**
 * Runs every check and stores the answer. `health:run` uses this - "Re-run"
 * has to mean re-run - and the stored copy is what makes the Play button that
 * follows it instant.
 */
export async function freshHealthReport(profileId: number | null, gamePath: string): Promise<HealthReport> {
  const report = await runHealthCheck(profileId)
  stamp = { at: Date.now(), key: reportKey(gamePath, profileId), fingerprint: fingerprint(profileId, gamePath) }
  stored = report
  return report
}

/** The stored report when it still answers for this state, otherwise a fresh one. */
export async function healthReportForLaunch(profileId: number | null, gamePath: string): Promise<HealthReport> {
  const key = reportKey(gamePath, profileId)
  if (stored && reportIsReusable(stamp, key, fingerprint(profileId, gamePath), Date.now(), REPORT_MAX_AGE_MS)) {
    return stored
  }
  return freshHealthReport(profileId, gamePath)
}

/** Test seam: what the cache is holding, without running anything. */
export function storedHealthReport(): { stamp: CachedReportStamp | null; report: HealthReport | null } {
  return { stamp, report: stored }
}
