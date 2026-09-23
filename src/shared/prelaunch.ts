/**
 * How the pre-launch report is reused, and what the launch does with it.
 *
 * Pressing Play is the most latency-sensitive thing in the app, and the gate in
 * `./launchGate` needs a report to consult. Running all sixteen checks on every
 * click - sixty .txd parses, a walk of every install, a release lookup - is how
 * a gate gets torn out by whoever maintains this next. So a report is reused
 * when it is still true, and re-run when it is not.
 *
 * "Still true" is not a timer alone: a fingerprint of what the report was
 * computed from travels with it, so an install, an uninstall, a toggle or a
 * rewritten stream.ini invalidates it immediately rather than at the end of a
 * TTL. The timer is only the backstop for the inputs no fingerprint can see
 * cheaply - the process table, modloader.log, a release published upstream.
 *
 * Both rules are pure and live here so the unit suite can hold them to it.
 */

import type { HealthReport } from './types'
import { launchGate, type LaunchBlocker, type LaunchVerdict } from './launchGate'

/** What a stored report remembers about itself. */
export interface CachedReportStamp {
  /** When the report was computed, in epoch ms. */
  at: number
  /** Which game and profile it describes. */
  key: string
  /** What it was computed from: any change here makes it a different answer. */
  fingerprint: string
}

/** The backstop, for inputs a fingerprint cannot see: two minutes. */
export const REPORT_MAX_AGE_MS = 120_000

/**
 * May a stored report answer for `key`/`fingerprint` right now?
 *
 * Fail-closed on every axis: no stamp, another profile, anything installed or
 * toggled since, or simply old enough, and the answer is no. A reused report
 * must be indistinguishable from a fresh one, or the gate is lying.
 */
export function reportIsReusable(
  stamp: CachedReportStamp | null | undefined,
  key: string,
  fingerprint: string,
  now: number,
  maxAgeMs: number = REPORT_MAX_AGE_MS
): boolean {
  if (!stamp) return false
  if (stamp.key !== key) return false
  if (stamp.fingerprint !== fingerprint) return false
  const age = now - stamp.at
  // A clock that went backwards is not freshness.
  if (age < 0) return false
  return age < maxAgeMs
}

/** Identifies what a report describes: one game folder, one profile or none. */
export function reportKey(gamePath: string, profileId: number | null): string {
  return `${(gamePath ?? '').toLowerCase()}|${profileId ?? 'no-profile'}`
}

export interface LaunchInputs {
  /** The user has read the refusal and asked for the game anyway. */
  force: boolean
  /** The report the gate consults, or null when there is none to consult. */
  report: HealthReport | null
}

/**
 * The whole decision the launch makes: `force` is the only thing that clears a
 * standing blocker, and it clears every one of them - it is the user answering
 * the refusal they were just shown, not a flag that weakens the gate.
 */
export function launchDecision(inputs: LaunchInputs, extra: readonly LaunchBlocker[] = []): LaunchVerdict {
  if (inputs.force) return { allowed: true, blockers: [], warnings: inputs.report?.warnings ?? 0 }
  return launchGate(inputs.report, extra)
}
