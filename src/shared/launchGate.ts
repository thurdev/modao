/**
 * The one place that decides whether the game may start.
 *
 * `HealthReport.blocking` was computed on every health run and read by nobody:
 * the pre-launch screen said "1 problem will stop the game from opening
 * properly" and the Play button next to it started the game anyway. That is how
 * a stream.ini asking for 13500 MB on a 32-bit process - the crash this whole
 * panel exists to catch - was found, reported, and then launched into.
 *
 * The verdict is a LIST of reasons rather than one stream.ini branch, so a
 * second thing that must stop a launch (an unsatisfied hard dependency, say)
 * becomes another entry and not a second gate. Everything here is pure: it
 * takes a report and returns a decision, with no filesystem, database or
 * Electron anywhere near it.
 */

import type { HealthCheck, HealthReport } from './types'

/** One reason the launch is refused. */
export interface LaunchBlocker {
  /** Stable id - a health check id, or an id owned by whatever else refuses. */
  id: string
  /** The finding's name, as the refusal message calls it. */
  title: string
  /** One line saying what is wrong. */
  summary: string
  /** Longer explanation, when the finding carries one. */
  detail?: string
}

export interface LaunchVerdict {
  /** False means: do not start the game. */
  allowed: boolean
  /** Every reason, in report order. Empty when allowed. */
  blockers: LaunchBlocker[]
  /** Findings worth reading that do not stop the launch. */
  warnings: number
}

const ALLOWED: LaunchVerdict = { allowed: true, blockers: [], warnings: 0 }

/** A failing check, reduced to the refusal's vocabulary. */
export function blockerFromCheck(check: HealthCheck): LaunchBlocker {
  return { id: check.id, title: check.title, summary: check.summary, detail: check.detail }
}

/**
 * Every check at `fail`. `warn` never blocks - the spec asks for exactly one
 * blocking class, and a warning the user cannot click past is a warning nobody
 * reads. `unknown` does not block either: not knowing is not a finding.
 */
export function blockersFromReport(report: HealthReport | null | undefined): LaunchBlocker[] {
  if (!report) return []
  return report.checks.filter((c) => c.status === 'fail').map(blockerFromCheck)
}

/**
 * The decision.
 *
 * `extra` is for refusals that do not come from a health check - pass them and
 * they are treated exactly like a failing check, message and all.
 */
export function launchGate(
  report: HealthReport | null | undefined,
  extra: readonly LaunchBlocker[] = []
): LaunchVerdict {
  const blockers = [...blockersFromReport(report), ...extra]
  if (blockers.length === 0) return { ...ALLOWED, warnings: report?.warnings ?? 0 }
  return { allowed: false, blockers, warnings: report?.warnings ?? 0 }
}

/**
 * The refusal in one line, naming the findings rather than counting them: a
 * user told "1 problem" has to go looking for which.
 */
export function describeBlockers(blockers: readonly LaunchBlocker[]): string {
  return blockers.map((b) => `${b.title} - ${b.summary}`).join(' | ')
}
