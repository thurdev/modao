import path from 'node:path'
import type { GameInstall } from '@shared/types'
import { resolveExeName } from '@shared/games'
import { describeBlockers, type LaunchBlocker, type LaunchVerdict } from '@shared/launchGate'
import { launchDecision } from '@shared/prelaunch'
import { t } from '../util/i18n'
import { exists } from '../util/fsx'
import { requireActiveGame } from './detect'
import { activeProfile } from '../profiles/manager'
import { healthReportForLaunch } from '../diagnostics/healthCache'
import { dependencyLaunchRefusals } from '../deps/resolver'

/**
 * Everything the launch decides before anything is started.
 *
 * This is the whole of what `game:launch` used to hold inline, lifted out so it
 * can be run against a real game folder by the e2e harness: the handler that
 * remains starts a process and nothing else. A plan carrying a `refusal` is the
 * gate holding - if this function ever stopped producing one, the smoke test
 * that asks it about a 13500 MB stream.ini would fail.
 *
 * The check is skipped entirely only when the user forces it, which is them
 * answering a refusal they have already read on the Health screen.
 */
export interface LaunchRefusal {
  launched: false
  message: string
  blockers: LaunchBlocker[]
}

export interface LaunchPlan {
  game: GameInstall
  /** The executable that would be started. */
  exe: string
  /** The active profile, or null - a reachable state, and still gated. */
  profileId: number | null
  verdict: LaunchVerdict
  /** Non-null means: start nothing, return this. */
  refusal: LaunchRefusal | null
}

/**
 * The full path of the executable THAT IS ON DISK for this install.
 *
 * `exeNames` is a list because one game ships under several names - Vice City
 * is gta-vc.exe or gta_vc.exe depending on the release - and reading
 * `exeNames[0]` alone is how a perfectly good Vice City install was reported as
 * having no executable. The launch and the health check were brought onto
 * `resolveExeName` for that reason; `health:deepAnalyze` was still reading the
 * first name and so tried to disassemble a file that is not there, on an
 * install it had just launched. Every caller that needs the path asks here.
 */
export function resolveGameExe(game: GameInstall): string {
  const exeName = resolveExeName(game.kind, (name) => exists(path.join(game.path, name)))
  if (!exeName) throw new Error(t('messages.game.exeNotFound', { game: game.gameName, path: game.path }))
  return path.join(game.path, exeName)
}

export async function planLaunch(force = false): Promise<LaunchPlan> {
  const game = requireActiveGame()
  // The same question the health report's `exe` check asks, asked through the
  // same function: the two disagreeing is what refused a Vice City install
  // whose executable is the second name on the list.
  const exe = resolveGameExe(game)

  const profile = await activeProfile()
  const profileId = profile?.id ?? null

  // With no profile active, the profile-scoped checks skip themselves and the
  // game-level ones still run - stream.ini above all, which is fatal whether or
  // not a profile is pointing at it. This path used to launch unchecked.
  //
  // A check that THROWS is not a finding: a broken health run must not become a
  // locked Play button, so the launch goes ahead on null.
  const report = force ? null : await healthReportForLaunch(profileId, game.path).catch(() => null)

  // The second reason a launch is refused: a hard dependency this profile does
  // not satisfy. Proper Shaders probes for SilentPatch and Open Limit Adjuster
  // at runtime; a profile holding it and nothing else crashed on the desk it
  // was reported from. The health report already counts these, but it counts
  // them - "2 unresolved" - and a refusal has to name what needs what.
  const depBlockers = force || profileId === null ? [] : dependencyLaunchRefusals(profileId, game)
  const verdict = launchDecision({ force, report }, depBlockers)

  // The report's own `dependencies` check says the same thing in the aggregate.
  // When the per-edge reasons are present they replace it rather than doubling
  // it - never the other way round, so this can only make a refusal clearer.
  const blockers = depBlockers.length ? verdict.blockers.filter((b) => b.id !== 'dependencies') : verdict.blockers

  return {
    game,
    exe,
    profileId,
    verdict: { ...verdict, blockers },
    refusal: verdict.allowed
      ? null
      : {
          launched: false,
          message: t('messages.game.launchBlocked', { names: describeBlockers(blockers) }),
          blockers
        }
  }
}
