import fs from 'node:fs'
import type { HealthReport } from '@shared/types'
import { reportIsReusable, reportKey, REPORT_MAX_AGE_MS, type CachedReportStamp } from '@shared/prelaunch'
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
 * Covers the two things that change under a user's hands between one Play and
 * the next: what the profile has installed and enabled, and stream.ini - the
 * file the whole gate exists for, which the offered fix rewrites. Everything
 * slower-moving is left to the age backstop.
 */
function fingerprint(profileId: number | null, gamePath: string): string {
  const parts: string[] = []

  if (profileId !== null) {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) c, COALESCE(SUM(enabled), 0) e, COALESCE(MAX(id), 0) m
           FROM install WHERE profile_id = ?`
      )
      .get(profileId) as { c: number; e: number; m: number } | undefined
    parts.push(`i:${row?.c ?? 0}/${row?.e ?? 0}/${row?.m ?? 0}`)
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
