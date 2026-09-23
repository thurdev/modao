import path from 'node:path'
import fsp from 'node:fs/promises'
import type { ConflictClaimant, FileConflict } from '@shared/types'
import { findHookCollisions, type HookCollision } from '@shared/hookCollisions'
import { findSplitModels } from '@shared/splitModels'
import { getDb } from '../db'
import { resolveWinner } from '../game/modloaderIni'
import { storeDir } from '../store/contentStore'
import { analyzeTxd, describeTxdProblems } from '../formats/txd'
import { pluginEvidence } from '../formats/strings'
import { exists } from '../util/fsx'

interface ProvidesRow {
  install_id: number
  relative_path: string
  sha256: string | null
  size: number
  priority: number
  enabled: number
  mod_id: number
  title: string
  folder_name: string | null
  store_key: string | null
}

/**
 * The conflict index answers one question: when two mods supply the same
 * relative filename, which one does Mod Loader actually load? Priority decides
 * it - higher wins, 0 means the mod is ignored entirely, ties fall back to
 * folder order.
 */
export function listConflicts(profileId: number, overrides: Record<number, number> = {}): FileConflict[] {
  const rows = getDb()
    .prepare(
      `SELECT p.install_id, p.relative_path, p.sha256, p.size,
              i.priority, i.enabled, i.folder_name, i.store_key,
              m.id AS mod_id, m.title
         FROM provides p
         JOIN install i ON i.id = p.install_id
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ?
          AND p.relative_path IN (
              SELECT p2.relative_path FROM provides p2
              JOIN install i2 ON i2.id = p2.install_id
             WHERE i2.profile_id = ?
             GROUP BY p2.relative_path HAVING COUNT(DISTINCT p2.install_id) > 1)
        ORDER BY p.relative_path`
    )
    .all(profileId, profileId) as ProvidesRow[]

  const byPath = new Map<string, ProvidesRow[]>()
  for (const r of rows) {
    const list = byPath.get(r.relative_path) ?? []
    list.push(r)
    byPath.set(r.relative_path, list)
  }

  const conflicts: FileConflict[] = []
  for (const [relativePath, group] of byPath) {
    const claimants: ConflictClaimant[] = group.map((g) => ({
      installId: g.install_id,
      modId: g.mod_id,
      title: g.title,
      priority: overrides[g.install_id] ?? g.priority,
      enabled: !!g.enabled,
      size: g.size,
      sha256: g.sha256 ?? ''
    }))
    // Identical bytes from both mods are not a real conflict.
    const distinct = new Set(claimants.map((c) => c.sha256).filter(Boolean))
    const winnerRow = resolveWinner(
      group.map((g) => ({
        priority: overrides[g.install_id] ?? g.priority,
        folder: g.folder_name ?? g.title,
        enabled: !!g.enabled,
        installId: g.install_id
      }))
    )
    conflicts.push({
      relativePath,
      kind: relativePath.startsWith('cleo/') || relativePath.startsWith('scripts/') ? 'physical' : 'modloader',
      claimants,
      winner: winnerRow ? claimants.find((c) => c.installId === winnerRow.installId) ?? null : null,
      binaryNotes: distinct.size <= 1 ? ['Both mods ship identical bytes - the winner does not matter here.'] : []
    })
  }
  conflicts.sort((a, b) => b.claimants.length - a.claimants.length || a.relativePath.localeCompare(b.relativePath))
  // A split model is the same mechanism - priority deciding which install a
  // file comes from - applied to a pair of files rather than to one path, so
  // it belongs in the same list and is fixed with the same control. It is
  // appended rather than interleaved so the per-path index above keeps its
  // existing order.
  return [...conflicts, ...listSplitModelConflicts(profileId, overrides)]
}

/**
 * White or invisible cars and peds: `<name>.dff` won by one mod and
 * `<name>.txd` by another.
 *
 * Nothing here is a duplicated path, so `listConflicts` above cannot see it -
 * the two halves of a model have different names. The rule itself lives in
 * `@shared/splitModels`, free of the database; this function is the query that
 * feeds it and the translation of its findings into the shape the Conflicts
 * screen already knows how to show, priority stepper included.
 *
 * The finding says out loud what it is NOT: a streaming memory budget too
 * small for the installed models whites out vehicles in exactly the same way,
 * and no priority change fixes that one. The two are distinguished by
 * construction - this fires only when the two halves demonstrably resolve to
 * different installs, which a starved budget never causes - and the note says
 * so, so a user chasing white cars is not sent to the wrong screen.
 */
export function listSplitModelConflicts(profileId: number, overrides: Record<number, number> = {}): FileConflict[] {
  const rows = getDb()
    .prepare(
      `SELECT p.install_id, p.relative_path, p.sha256, p.size,
              i.priority, i.enabled, i.folder_name, i.store_key,
              m.id AS mod_id, m.title
         FROM provides p
         JOIN install i ON i.id = p.install_id
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ?
          AND (lower(p.relative_path) LIKE '%.dff' OR lower(p.relative_path) LIKE '%.txd')
        ORDER BY p.relative_path`
    )
    .all(profileId) as ProvidesRow[]

  const parts = rows.map((r) => ({
    installId: r.install_id,
    modId: r.mod_id,
    title: r.title,
    folder: r.folder_name ?? r.title,
    relativePath: r.relative_path,
    priority: overrides[r.install_id] ?? r.priority,
    enabled: !!r.enabled,
    size: r.size,
    sha256: r.sha256 ?? ''
  }))

  return findSplitModels(parts, (candidates) => resolveWinner(candidates)).map((split) => ({
    relativePath: `${split.stem} (.dff + .txd)`,
    kind: 'split-model' as const,
    claimants: split.claimants.map((c) => ({
      installId: c.installId,
      modId: c.modId,
      title: c.title,
      priority: c.priority,
      enabled: c.enabled,
      size: c.size,
      sha256: c.sha256
    })),
    // Neither mod wins the model: one wins the mesh and the other the
    // textures, which is precisely the problem being reported.
    winner: null,
    binaryNotes: [
      `${split.dff.relativePath} is loaded from ${split.dff.title}, ${split.txd.relativePath} from ${split.txd.title}.`,
      `${split.shippedTogether[0].title} ships both halves of this model, so the pair was made to match.`,
      'A starved streaming memory budget whites out models the same way, for a different reason - that one is not ' +
        'fixed by priority. This finding is not that: these two files demonstrably come from different mods.'
    ]
  }))
}

/** Adds binary-level detail (non-power-of-two textures) to the most contested files. */
export async function annotateConflicts(conflicts: FileConflict[], limit = 25): Promise<FileConflict[]> {
  let budget = limit
  for (const c of conflicts) {
    if (budget <= 0) break
    if (!/\.txd$/i.test(c.relativePath)) continue
    for (const claim of c.claimants) {
      if (budget-- <= 0) break
      const file = locateProvided(claim.installId, c.relativePath)
      if (!file) continue
      const a = await analyzeTxd(file).catch(() => null)
      if (!a) continue
      const problems = describeTxdProblems(a)
      if (problems.length) c.binaryNotes.push(`${claim.title}: ${problems.join(' ')}`)
      else c.binaryNotes.push(`${claim.title}: ${a.textureCount} textures, all power-of-two.`)
    }
  }
  return conflicts
}

/** Resolves a provides key back to the file inside the content store. */
export function locateProvided(installId: number, providesKey: string): string | null {
  const row = getDb()
    .prepare(
      `SELECT i.store_key, f.relative_path
         FROM install i
         JOIN install_file f ON f.install_id = i.id
        WHERE i.id = ? AND lower(f.relative_path) LIKE ?`
    )
    .get(installId, `%${providesKey.toLowerCase()}`) as { store_key: string; relative_path: string } | undefined
  if (!row?.store_key) return null
  const p = path.join(storeDir(row.store_key), row.relative_path)
  return exists(p) ? p : null
}

/**
 * Two mods hooking the same address, found by decoding the MSVC-mangled
 * template args a plugin-sdk .asi built with no source leaves in its own
 * symbol table (see @shared/mangled, @shared/hookCollisions). Unlike the file
 * conflicts above, this never shows up as two mods claiming one filename -
 * both .asi files install cleanly, and the collision is invisible until one
 * of the two hooks the other stomps on stops working, or both crash.
 */
export async function listHookCollisions(profileId: number, limit = 60): Promise<HookCollision[]> {
  const rows = getDb()
    .prepare(
      `SELECT i.store_key, m.title, f.relative_path
         FROM install_file f
         JOIN install i ON i.id = f.install_id
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ? AND i.enabled = 1 AND lower(f.relative_path) LIKE '%.asi'`
    )
    .all(profileId) as { store_key: string | null; title: string; relative_path: string }[]

  const candidates: { title: string; file: string; addresses: number[] }[] = []
  let budget = limit
  for (const row of rows) {
    if (budget-- <= 0) break
    if (!row.store_key) continue
    const file = path.join(storeDir(row.store_key), row.relative_path)
    if (!exists(file)) continue
    const buf = await fsp.readFile(file).catch(() => null)
    if (!buf) continue
    const evidence = pluginEvidence(buf)
    if (evidence.hookAddresses.length) {
      candidates.push({ title: row.title, file: row.relative_path, addresses: evidence.hookAddresses })
    }
  }
  return findHookCollisions(candidates)
}

/** The conflict key a file is indexed under: inside a Mod Loader folder, the path relative to that folder. */
export function providesKey(gameRelative: string): string {
  const m = /^modloader\/[^/]+\/(.+)$/i.exec(gameRelative)
  return (m ? m[1] : gameRelative).toLowerCase()
}
