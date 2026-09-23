import type { DependencyNode, GameInstall } from '@shared/types'
import { getDb } from '../db'
import { satisfiesRange } from '@shared/versionRange'

interface DepRow {
  id: number
  mod_id: number
  requires_mod_id: number | null
  requires_slug: string | null
  kind: 'requires' | 'conflicts' | 'alt'
  version_range: string | null
  alt_group: string | null
  note: string | null
}

export interface ResolveInput {
  modId: number
  profileId: number
  game: GameInstall
}

/**
 * Builds the dependency plan for one mod against one profile.
 * Supports alternatives (A or B), version ranges, and anti-dependencies -
 * mods that must not coexist, such as Proper Shaders and SkyGfx.
 */
export function resolveDependencies({ modId, profileId, game }: ResolveInput): DependencyNode[] {
  const db = getDb()
  const rows = db.prepare('SELECT * FROM dependency WHERE mod_id = ?').all(modId) as DepRow[]
  if (rows.length === 0) return []

  const installed = db
    .prepare(
      `SELECT m.id, m.slug, m.title, mv.version_label, i.enabled
         FROM install i
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ?`
    )
    .all(profileId) as { id: number; slug: string; title: string; version_label: string; enabled: number }[]

  const bySlug = new Map(installed.map((i) => [i.slug, i]))
  const out: DependencyNode[] = []

  const altGroups = new Map<string, DepRow[]>()
  for (const r of rows) {
    if (r.kind === 'alt' && r.alt_group) {
      const list = altGroups.get(r.alt_group) ?? []
      list.push(r)
      altGroups.set(r.alt_group, list)
    }
  }

  for (const [group, members] of altGroups) {
    const alternatives = members.map((m) => {
      const info = lookupMod(m)
      const inst = info.slug ? bySlug.get(info.slug) : undefined
      return { slug: info.slug, title: info.title, satisfied: !!inst }
    })
    const satisfied = alternatives.some((a) => a.satisfied)
    out.push({
      modId: null,
      slug: group,
      title: alternatives.map((a) => a.title).join(' or '),
      kind: 'alt',
      versionRange: members[0].version_range,
      satisfied,
      alternatives,
      resolution: satisfied ? 'already-installed' : 'missing',
      note: members[0].note ?? 'Any one of these satisfies the requirement.'
    })
  }

  for (const r of rows) {
    if (r.kind === 'alt') continue
    const info = lookupMod(r)
    const inst = info.slug ? bySlug.get(info.slug) : undefined

    if (r.kind === 'conflicts') {
      out.push({
        modId: info.id,
        slug: info.slug,
        title: info.title,
        kind: 'conflicts',
        versionRange: r.version_range,
        satisfied: !inst,
        resolution: inst ? 'blocking' : 'ok',
        note: r.note ?? (inst ? `${info.title} is installed and cannot coexist with this mod.` : null)
      })
      continue
    }

    // Requirements that are about the framework rather than a catalogue mod.
    const frameworkNote = checkFramework(info.slug, r.version_range, game)
    if (frameworkNote) {
      out.push({
        modId: info.id,
        slug: info.slug,
        title: info.title,
        kind: 'requires',
        versionRange: r.version_range,
        satisfied: frameworkNote.satisfied,
        resolution: frameworkNote.satisfied ? 'ok' : 'blocking',
        note: frameworkNote.message
      })
      continue
    }

    out.push({
      modId: info.id,
      slug: info.slug,
      title: info.title,
      kind: 'requires',
      versionRange: r.version_range,
      satisfied: !!inst && satisfiesRange(inst.version_label, r.version_range),
      resolution: !inst ? 'missing' : satisfiesRange(inst.version_label, r.version_range) ? 'already-installed' : 'missing',
      note:
        inst && !satisfiesRange(inst.version_label, r.version_range)
          ? `Installed ${info.title} ${inst.version_label} does not satisfy ${r.version_range}.`
          : r.note
    })
  }

  return out
}

function lookupMod(r: DepRow): { id: number | null; slug: string; title: string } {
  const db = getDb()
  if (r.requires_mod_id) {
    const m = db.prepare('SELECT id, slug, title FROM mod WHERE id = ?').get(r.requires_mod_id) as
      | { id: number; slug: string; title: string }
      | undefined
    if (m) return m
  }
  if (r.requires_slug) {
    const m = db.prepare('SELECT id, slug, title FROM mod WHERE slug = ?').get(r.requires_slug) as
      | { id: number; slug: string; title: string }
      | undefined
    if (m) return m
    return { id: null, slug: r.requires_slug, title: r.requires_slug }
  }
  return { id: null, slug: 'unknown', title: 'Unknown requirement' }
}

/**
 * CLEO+ against CLEO 4.3 fails with
 * "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo",
 * a fatal dialog at startup. Version-gate it rather than letting it install.
 */
function checkFramework(
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

/**
 * Scene version strings are messy on purpose, and the pre-launch CLEO gate has
 * to answer the same question without reaching a database - so the comparison
 * lives in @shared/versionRange now and is re-exported here for every caller
 * that already imports it from the resolver.
 */
export { satisfiesRange }

/** Anti-dependencies that hold for the whole profile, checked before launch. */
export function profileDependencyProblems(profileId: number, game: GameInstall): DependencyNode[] {
  const db = getDb()
  const installedMods = db
    .prepare(
      `SELECT DISTINCT m.id FROM install i
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ? AND i.enabled = 1`
    )
    .all(profileId) as { id: number }[]
  const out: DependencyNode[] = []
  for (const m of installedMods) {
    for (const node of resolveDependencies({ modId: m.id, profileId, game })) {
      if (node.resolution === 'missing' || node.resolution === 'blocking') out.push(node)
    }
  }
  return out
}
