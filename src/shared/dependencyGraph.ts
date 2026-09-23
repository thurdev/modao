/**
 * The dependency graph's reasoning, with no database under it.
 *
 * `src/main/deps/resolver.ts` owns the SQL - which mods are installed in THIS
 * profile, which rows the `dependency` table holds - and hands the answers
 * here. Everything below is a pure function of those answers, so the unit
 * suite (which cannot load `electron` or `better-sqlite3`) can exercise the
 * part that decides things: whether a `provides` edge answers a requirement,
 * whether two mods claiming the same file collide, and what the launch refusal
 * is allowed to say.
 *
 * The profile scoping is NOT re-implemented here. It cannot be: this module is
 * handed a list of installed mods and a list of provided artifacts and has no
 * way to reach any other profile's. A dependency satisfied elsewhere is
 * invisible to it by construction, which is exactly the rule.
 */

import type { DependencyNode, GameInstall } from './types'
import type { LaunchBlocker } from './launchGate'
import { satisfiesRange } from './versionRange'
import { requirementMet } from './requirements'

/**
 * The edge kinds the graph understands.
 *
 * `provides` was seeded (`sa-vehfuncs provides gsx.asi`) before anything read
 * it, so the row fell through to the `requires` branch and every profile with
 * VehFuncs reported a missing dependency called "gsx.asi" - the exact inverse
 * of what the edge says. Listing the kinds in one place lets the loader reject
 * a kind nobody implements instead of letting it become a phantom requirement.
 */
export const DEPENDENCY_KINDS = ['requires', 'conflicts', 'alt', 'provides'] as const
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number]

export function isDependencyKind(value: unknown): value is DependencyKind {
  return typeof value === 'string' && (DEPENDENCY_KINDS as readonly string[]).includes(value)
}

/** One `dependency` row with its target already resolved to a name. */
export interface GraphDependencyRow {
  /** Raw, straight out of the table - an unknown kind is dropped here too. */
  kind: string
  targetModId: number | null
  targetSlug: string
  targetTitle: string
  versionRange: string | null
  altGroup: string | null
  note: string | null
}

/** A mod materialised in the profile being resolved against. */
export interface InstalledMod {
  id: number
  slug: string
  title: string
  versionLabel: string | null
  enabled: boolean
}

/**
 * A file an installed mod puts on disk that another mod may also carry -
 * `gsx.asi`, shipped by VehFuncs and by half a dozen vehicle mods.
 */
export interface ArtifactProvider {
  /** The artifact as the graph names it: "gsx.asi". */
  artifact: string
  modSlug: string
  modTitle: string
}

export interface BuildGraphInput {
  /** The mod whose edges these are. */
  subjectSlug: string
  subjectTitle: string
  rows: readonly GraphDependencyRow[]
  /** Installed in THIS profile. Nothing else counts. */
  installed: readonly InstalledMod[]
  /** Artifacts provided by mods installed in THIS profile, the subject included. */
  providers: readonly ArtifactProvider[]
  /**
   * Every name this profile can answer a requirement with: installed file
   * paths, mod titles, folder names, and plugins loose in the ASI directory.
   *
   * The install engine has always widened the question this way, and the
   * resolver had not - which would make the launch gate refuse a profile whose
   * SilentPatch was dropped into the ASI folder by hand. The game loads it
   * either way, so it counts either way. Still profile-scoped: the list is
   * built from this profile's installs plus the one game folder.
   */
  evidence?: readonly string[]
  game: GameInstall
}

const sameArtifact = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Builds the dependency plan for one mod against one profile.
 *
 * Alternatives (A or B), version ranges, anti-dependencies, and - since the
 * seed always meant to - provisions: a mod that ships a file, which both
 * answers anyone requiring that file and collides with anyone else shipping it.
 */
export function buildDependencyNodes(input: BuildGraphInput): DependencyNode[] {
  const { subjectSlug, subjectTitle, rows, installed, providers, game } = input
  const evidence = input.evidence ?? []
  const bySlug = new Map(installed.map((i) => [i.slug, i]))
  const out: DependencyNode[] = []

  const altGroups = new Map<string, GraphDependencyRow[]>()
  for (const r of rows) {
    if (r.kind === 'alt' && r.altGroup) {
      const list = altGroups.get(r.altGroup) ?? []
      list.push(r)
      altGroups.set(r.altGroup, list)
    }
  }

  for (const [group, members] of altGroups) {
    const alternatives = members.map((m) => ({
      slug: m.targetSlug,
      title: m.targetTitle,
      satisfied: bySlug.has(m.targetSlug)
    }))
    const satisfied = alternatives.some((a) => a.satisfied)
    out.push({
      modId: null,
      slug: group,
      title: alternatives.map((a) => a.title).join(' or '),
      kind: 'alt',
      versionRange: members[0].versionRange,
      satisfied,
      alternatives,
      resolution: satisfied ? 'already-installed' : 'missing',
      note: members[0].note ?? 'Any one of these satisfies the requirement.',
      requiredBy: subjectTitle,
      requiredBySlug: subjectSlug
    })
  }

  for (const r of rows) {
    if (r.kind === 'alt') continue
    // An unknown kind is not a requirement. It used to become one.
    if (!isDependencyKind(r.kind)) continue
    const inst = bySlug.get(r.targetSlug)
    const base = {
      modId: r.targetModId,
      slug: r.targetSlug,
      title: r.targetTitle,
      versionRange: r.versionRange,
      requiredBy: subjectTitle,
      requiredBySlug: subjectSlug
    }

    if (r.kind === 'provides') {
      // Two copies of the same .asi is a load-order coin flip at best and a
      // crash at worst, so a second provider in the same profile blocks.
      const rivals = providers.filter((p) => sameArtifact(p.artifact, r.targetSlug) && p.modSlug !== subjectSlug)
      out.push({
        ...base,
        kind: 'provides',
        versionRange: null,
        satisfied: rivals.length === 0,
        resolution: rivals.length === 0 ? 'ok' : 'blocking',
        note:
          rivals.length === 0
            ? (r.note ?? `${subjectTitle} supplies ${r.targetSlug}.`)
            : `${r.targetSlug} is supplied by ${subjectTitle} and also by ${rivals.map((p) => p.modTitle).join(', ')}. Keep one copy.`
      })
      continue
    }

    if (r.kind === 'conflicts') {
      out.push({
        ...base,
        kind: 'conflicts',
        satisfied: !inst,
        resolution: inst ? 'blocking' : 'ok',
        note: r.note ?? (inst ? `${r.targetTitle} is installed and cannot coexist with this mod.` : null)
      })
      continue
    }

    // Requirements that are about the framework rather than a catalogue mod.
    const frameworkNote = checkFramework(r.targetSlug, r.versionRange, game)
    if (frameworkNote) {
      out.push({
        ...base,
        kind: 'requires',
        satisfied: frameworkNote.satisfied,
        resolution: frameworkNote.satisfied ? 'ok' : 'blocking',
        note: frameworkNote.message
      })
      continue
    }

    // Nothing installed answers it by name - but something installed may ship
    // the file itself. "Requires gsx.asi" is answered by VehFuncs providing it.
    if (!inst) {
      const provider = providers.find((p) => sameArtifact(p.artifact, r.targetSlug) && p.modSlug !== subjectSlug)
      if (provider) {
        out.push({
          ...base,
          kind: 'requires',
          satisfied: true,
          resolution: 'already-installed',
          note: `${provider.modTitle} already supplies ${r.targetSlug}.`
        })
        continue
      }
      // ...or the profile answers it under another name entirely: a pack that
      // ships SilentPatchSA.asi, or a loader dropped in by hand.
      if (evidence.length > 0 && requirementMet(r.targetTitle, [...evidence])) {
        out.push({
          ...base,
          kind: 'requires',
          satisfied: true,
          resolution: 'already-installed',
          note: `${r.targetTitle} is already present in this profile.`
        })
        continue
      }
    }

    const versionOk = !!inst && satisfiesRange(inst.versionLabel, r.versionRange)
    out.push({
      ...base,
      kind: 'requires',
      satisfied: versionOk,
      resolution: !inst ? 'missing' : versionOk ? 'already-installed' : 'missing',
      note:
        inst && !versionOk
          ? `Installed ${r.targetTitle} ${inst.versionLabel ?? ''} does not satisfy ${r.versionRange}.`.replace('  ', ' ')
          : r.note
    })
  }

  return out
}

/**
 * CLEO+ against CLEO 4.3 fails with
 * "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo",
 * a fatal dialog at startup. Version-gate it rather than letting it install.
 */
export function checkFramework(
  slug: string,
  range: string | null,
  game: GameInstall
): { satisfied: boolean; message: string } | null {
  if (slug === 'cleo' || slug === 'cleo4' || slug === 'cleo-library') {
    const have = game.cleoVersion
    if (!have) {
      return { satisfied: false, message: 'CLEO is not installed in this game folder.' }
    }
    const ok = satisfiesRange(have, range)
    return {
      satisfied: ok,
      message: ok
        ? `CLEO ${have} detected, satisfies ${range ?? 'any version'}.`
        : `CLEO ${have} detected but ${range} is required. CLEO+ against CLEO 4.3 fails at startup with "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo".`
    }
  }
  if (slug === 'asi-loader' || slug === 'ultimate-asi-loader') {
    const ok = !!game.asiLoader
    return {
      satisfied: ok,
      message: ok
        ? `ASI loader present (${game.asiLoader}); .asi plugins load from ${game.asiDirectory}.`
        : 'No ASI loader found in the game folder - .asi plugins will not load.'
    }
  }
  if (slug === 'modloader' || slug === 'mod-loader') {
    return {
      satisfied: game.hasModLoader,
      message: game.hasModLoader
        ? `Mod Loader ${game.modLoaderVersion ?? ''} detected.`.trim()
        : 'Mod Loader is not installed in this game folder.'
    }
  }
  return null
}

// --- the seed loader's half -------------------------------------------------

/** One row of `resources/seed/dependencies.json`. */
export interface CuratedDependencySeed {
  mod: string
  kind: string
  target: string
  versionRange?: string
  altGroup?: string
  note?: string
}

export interface PlannedCuratedDependency {
  modSlug: string
  kind: DependencyKind
  target: string
  versionRange: string | null
  altGroup: string | null
  note: string | null
}

export interface CuratedDependencyPlan {
  rows: PlannedCuratedDependency[]
  /** Rows that will not be stored, and why. Never silently dropped. */
  rejected: { seed: CuratedDependencySeed; reason: string }[]
}

/**
 * Decides what the seed file actually contributes to the table.
 *
 * It used to contribute less than it said: `loadCuratedDependencies` looked the
 * SUBJECT slug up in the catalogue and skipped the row when it was missing, so
 * `more-radar-icons requires cleoplus` - a mod that is real but not one of the
 * 127 catalogue entries - was discarded at every startup with no diagnostic.
 * Subjects are slug-addressed now, exactly as targets already were, so the only
 * thing that can be rejected is a kind no branch implements, and that is
 * reported rather than turned into a phantom requirement.
 */
export function planCuratedDependencies(seeds: readonly CuratedDependencySeed[]): CuratedDependencyPlan {
  const rows: PlannedCuratedDependency[] = []
  const rejected: { seed: CuratedDependencySeed; reason: string }[] = []
  for (const seed of seeds) {
    if (!seed.mod?.trim() || !seed.target?.trim()) {
      rejected.push({ seed, reason: 'a dependency needs both a subject and a target' })
      continue
    }
    if (!isDependencyKind(seed.kind)) {
      rejected.push({ seed, reason: `unknown kind "${seed.kind}" - expected one of ${DEPENDENCY_KINDS.join(', ')}` })
      continue
    }
    if (seed.kind === 'alt' && !seed.altGroup) {
      rejected.push({ seed, reason: 'an "alt" edge without an altGroup can never be satisfied' })
      continue
    }
    rows.push({
      modSlug: seed.mod.trim(),
      kind: seed.kind,
      target: seed.target.trim(),
      versionRange: seed.versionRange ?? null,
      altGroup: seed.altGroup ?? null,
      note: seed.note ?? null
    })
  }
  return { rows, rejected }
}

// --- the launch gate's half -------------------------------------------------

/**
 * The sentences the refusal is built from, already translated. The substitution
 * lives here so the wording is testable without a language loaded; the words
 * themselves live in `@shared/i18n` like every other string the user reads.
 */
export interface DependencyBlockerStrings {
  /** "{mod} needs {dep}" */
  requires: string
  /** "{mod} cannot run alongside {dep}" */
  conflicts: string
  /** "{dep} is supplied twice" */
  provides: string
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => vars[key] ?? whole)
}

/**
 * Is this edge a reason to refuse the launch?
 *
 * `blocking` is the resolver's own verdict - a version gate that is known to
 * kill the game at startup, an anti-dependency that is installed anyway, a file
 * shipped twice. `missing` is the field report's case: Proper Shaders in a
 * profile with neither SilentPatch nor Open Limit Adjuster, which probes for
 * both at runtime and crashed.
 */
export function isUnsatisfiedHardDependency(node: DependencyNode): boolean {
  return node.resolution === 'blocking' || node.resolution === 'missing'
}

/**
 * Turns the profile's unresolved edges into launch refusals, each naming what
 * needs what. It returns `LaunchBlocker`s rather than refusing anything itself:
 * the one gate is `launchGate`, and this is another reason handed to it.
 */
export function dependencyLaunchBlockers(
  problems: readonly DependencyNode[],
  strings: DependencyBlockerStrings
): LaunchBlocker[] {
  const seen = new Set<string>()
  const blockers: LaunchBlocker[] = []
  for (const node of problems) {
    if (!isUnsatisfiedHardDependency(node)) continue
    const mod = node.requiredBy ?? node.requiredBySlug ?? node.title
    const template = node.kind === 'conflicts' ? strings.conflicts : node.kind === 'provides' ? strings.provides : strings.requires
    const id = `dependency:${node.requiredBySlug ?? mod}:${node.kind}:${node.slug}`
    if (seen.has(id)) continue
    seen.add(id)
    blockers.push({
      id,
      title: mod,
      summary: fill(template, { mod, dep: node.title, range: node.versionRange ?? '' }).replace(/\s+/g, ' ').trim(),
      detail: node.note ?? undefined
    })
  }
  return blockers
}
