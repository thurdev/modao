import crypto from 'node:crypto'
import path from 'node:path'
import type { BisectSession } from '@shared/types'
import { bisectGate, type OutdatedBuild, type ReleaseFetcher } from '@shared/upstream'
import { getDb } from '../db'
import { requireActiveGame } from '../game/detect'
import { applyIgnoreState, readIgnoreState, readIniFile, writeIniFile, type IgnoreState } from '../game/modloaderIni'
import { t } from '../util/i18n'
import { log } from '../util/log'
import { fetchLatestRelease, scanUpstream } from './upstream'

/**
 * Guided bisect: halve the enabled mod set, launch, record the result, repeat.
 * Around five rounds finds one culprit among a hundred mods, and the
 * bookkeeping - which half was tested, what is cleared, what is still suspect -
 * is exactly what people do badly by hand.
 *
 * Nothing is moved. Mod Loader has its own switch for this: ExcludeAllMods plus
 * an [IncludeMods] list leaves every folder where it is and simply does not
 * read the ones under suspicion. Moving files to chase a crash risks creating a
 * second problem while looking for the first, and the app's own switch would
 * unlink and relink gigabytes at every step.
 *
 * Two things the method itself demands, and both are surfaced in the UI:
 * more than one mod can be guilty at once, and a crash address that CHANGES is
 * not progress - it is a different crash, which has to be re-verified from a
 * fresh boot.
 */
const SESSIONS = new Map<string, BisectSession>()

/** What the ini said before the session started, restored when it ends. */
const ORIGINAL_STATE = new Map<string, { ignore: IgnoreState; iniPath: string }>()

interface InstallRow {
  id: number
  folder_name: string | null
}

function enabledInstalls(profileId: number): InstallRow[] {
  return getDb()
    .prepare('SELECT id, folder_name FROM install WHERE profile_id = ? AND enabled = 1 ORDER BY id')
    .all(profileId) as InstallRow[]
}

function folderOf(profileId: number, installId: number): string | null {
  const row = getDb().prepare('SELECT folder_name FROM install WHERE id = ?').get(installId) as
    | { folder_name: string | null }
    | undefined
  void profileId
  return row?.folder_name ?? null
}

/**
 * Profiles that have already been told about an outdated mod. The refusal is
 * information, not a lock: once it has been delivered the user decides.
 */
const OUTDATED_TOLD = new Set<number>()

/** Exposed for the IPC layer and for tests that want a clean slate. */
export function forgetOutdatedWarning(profileId?: number): void {
  if (profileId === undefined) OUTDATED_TOLD.clear()
  else OUTDATED_TOLD.delete(profileId)
}

export async function startBisect(
  profileId: number,
  fetchRelease: ReleaseFetcher = fetchLatestRelease
): Promise<BisectSession> {
  const installs = enabledInstalls(profileId)
  if (installs.length < 2) throw new Error('Bisect needs at least two enabled mods.')

  // The precondition the field report paid for: an old build is one download,
  // a bisect is an evening. The check runs before the first halving, and a
  // network that does not answer leaves `outdated` empty rather than guessing.
  let outdated: OutdatedBuild[] = []
  try {
    outdated = (await scanUpstream(profileId, fetchRelease)).outdated
  } catch (e) {
    log('bisect could not run the outdated-build check; continuing', { error: (e as Error).message })
  }
  const gate = bisectGate(outdated, OUTDATED_TOLD.has(profileId))
  if (!gate.proceed && gate.refusal) {
    OUTDATED_TOLD.add(profileId)
    throw new Error(t(gate.refusal.key, gate.refusal.params))
  }

  const game = requireActiveGame()
  const iniPath = path.join(game.path, 'modloader', 'modloader.ini')
  const ini = await readIniFile(iniPath)

  const session: BisectSession = {
    id: crypto.randomUUID(),
    profileId,
    status: 'running',
    step: 0,
    candidates: installs.map((i) => i.id),
    testing: [],
    knownGood: [],
    knownBad: [],
    culprit: null,
    history: [],
    // Carried on the session so the panel can keep saying "rule these out
    // first" for as long as the bisect runs, not only at the moment it started.
    outdated: gate.outdated
  }
  // Remember what the user had, not what the app assumes they had: restoring
  // "everything on" would silently re-enable mods they turned off themselves.
  ORIGINAL_STATE.set(session.id, { ignore: readIgnoreState(ini), iniPath })
  SESSIONS.set(session.id, session)
  nextStep(session)
  await applyBisectStep(session.id)
  return session
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

/**
 * Applies the current step through the ini: the mods under test, plus anything
 * already cleared, are the only ones Mod Loader reads.
 */
export async function applyBisectStep(sessionId: string): Promise<void> {
  const session = SESSIONS.get(sessionId)
  if (!session) throw new Error('That bisect session has expired.')
  const original = ORIGINAL_STATE.get(sessionId)
  if (!original) throw new Error('That bisect session lost track of what it changed; abort it and start again.')

  const load = new Set<string>()
  for (const id of [...session.testing, ...session.knownGood]) {
    const folder = folderOf(session.profileId, id)
    if (folder) load.add(folder)
  }

  const ini = await readIniFile(original.iniPath)
  applyIgnoreState(ini, {
    excludeAll: true,
    include: [...load].sort((a, b) => a.localeCompare(b)),
    ignore: original.ignore.ignore
  })
  await writeIniFile(original.iniPath, ini)
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
  else await restore(sessionId)
  return session
}

export async function abortBisect(sessionId: string): Promise<void> {
  const session = SESSIONS.get(sessionId)
  if (!session) return
  session.status = 'aborted'
  await restore(sessionId)
}

/** Puts the ini back exactly as the session found it. */
async function restore(sessionId: string): Promise<void> {
  const original = ORIGINAL_STATE.get(sessionId)
  if (original) {
    const ini = await readIniFile(original.iniPath)
    applyIgnoreState(ini, original.ignore)
    await writeIniFile(original.iniPath, ini)
    ORIGINAL_STATE.delete(sessionId)
  }
  const session = SESSIONS.get(sessionId)
  if (session?.status === 'aborted') SESSIONS.delete(sessionId)
}

export function describeBisect(session: BisectSession): string {
  if (session.status === 'converged') {
    return session.culprit
      ? `Converged: install #${session.culprit} is the culprit.`
      : 'Converged without a culprit - the fault is not in the mod set.'
  }
  return `Step ${session.step}: ${session.testing.length} mod(s) loaded, ${session.candidates.length} still suspect. Launch the game and report the result.`
}
