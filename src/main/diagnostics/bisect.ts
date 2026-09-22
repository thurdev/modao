import crypto from 'node:crypto'
import type { BisectSession } from '@shared/types'
import { getDb } from '../db'
import { remateriliseInstall } from '../profiles/materialize'

/**
 * Guided bisect: halve the enabled mod set, launch, record the result, repeat.
 * The bookkeeping - which half was tested, what is still suspect, what is
 * already cleared - is exactly what humans do badly by hand.
 */
const SESSIONS = new Map<string, BisectSession>()

export function startBisect(profileId: number): BisectSession {
  const installs = (
    getDb().prepare('SELECT id FROM install WHERE profile_id = ? AND enabled = 1 ORDER BY id').all(profileId) as { id: number }[]
  ).map((r) => r.id)
  if (installs.length < 2) throw new Error('Bisect needs at least two enabled mods.')
  const session: BisectSession = {
    id: crypto.randomUUID(),
    profileId,
    status: 'running',
    step: 0,
    candidates: installs,
    testing: [],
    knownGood: [],
    knownBad: [],
    culprit: null,
    history: []
  }
  SESSIONS.set(session.id, session)
  return nextStep(session)
}

export function currentBisect(profileId: number): BisectSession | null {
  for (const s of SESSIONS.values()) if (s.profileId === profileId && s.status === 'running') return s
  return null
}

function nextStep(session: BisectSession): BisectSession {
  if (session.candidates.length <= 1) {
    session.status = 'converged'
    session.culprit = session.candidates[0] ?? null
    session.testing = []
    return session
  }
  const half = Math.ceil(session.candidates.length / 2)
  session.testing = session.candidates.slice(0, half)
  session.step++
  return session
}

/** Applies the current step: only the mods under test stay enabled. */
export async function applyBisectStep(sessionId: string): Promise<void> {
  const session = SESSIONS.get(sessionId)
  if (!session) throw new Error('That bisect session has expired.')
  const db = getDb()
  const all = db.prepare('SELECT id FROM install WHERE profile_id = ?').all(session.profileId) as { id: number }[]
  const testing = new Set([...session.testing, ...session.knownGood])
  for (const row of all) {
    const shouldEnable = testing.has(row.id)
    db.prepare('UPDATE install SET enabled = ? WHERE id = ?').run(shouldEnable ? 1 : 0, row.id)
    await remateriliseInstall(row.id)
  }
}

export async function recordResult(sessionId: string, result: 'good' | 'bad'): Promise<BisectSession> {
  const session = SESSIONS.get(sessionId)
  if (!session) throw new Error('That bisect session has expired.')
  session.history.push({ step: session.step, tested: [...session.testing], result })
  if (result === 'bad') {
    // The fault is inside the half under test.
    session.candidates = [...session.testing]
  } else {
    // This half is clear; the fault is in the other half.
    session.knownGood.push(...session.testing)
    session.candidates = session.candidates.filter((id) => !session.testing.includes(id))
  }
  nextStep(session)
  if (session.status === 'running') await applyBisectStep(sessionId)
  return session
}

export async function abortBisect(sessionId: string): Promise<void> {
  const session = SESSIONS.get(sessionId)
  if (!session) return
  session.status = 'aborted'
  // Restore every mod the session touched.
  const db = getDb()
  const all = db.prepare('SELECT id FROM install WHERE profile_id = ?').all(session.profileId) as { id: number }[]
  for (const row of all) {
    db.prepare('UPDATE install SET enabled = 1 WHERE id = ?').run(row.id)
    await remateriliseInstall(row.id)
  }
  SESSIONS.delete(sessionId)
}

export function describeBisect(session: BisectSession): string {
  if (session.status === 'converged') {
    return session.culprit
      ? `Converged: install #${session.culprit} is the culprit.`
      : 'Converged without a culprit - the fault is not in the mod set.'
  }
  return `Step ${session.step}: ${session.testing.length} mod(s) enabled, ${session.candidates.length} still suspect. Launch the game and report the result.`
}
