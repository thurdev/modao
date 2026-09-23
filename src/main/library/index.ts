import path from 'node:path'
import fsp from 'node:fs/promises'
import type { DestinationClass, InstalledMod, InstalledVariantGroup, SubMod } from '@shared/types'
import type { PersistedVariantGroup } from '@shared/variantGroups'
import { getDb } from '../db'
import { clampPriority } from '../game/modloaderIni'
import { remateriliseInstall, syncProfileIni } from '../profiles/materialize'
import { recordEarlyDisable } from '../catalog/rating'
import { requireActiveGame } from '../game/detect'
import { exists, sha256File } from '../util/fsx'
import { findInVariantOption, storeDir } from '../store/contentStore'

interface Row {
  install_id: number
  mod_id: number
  mod_version_id: number
  slug: string
  title: string
  author: string
  source_url: string
  version_label: string
  installed_at: string
  destination_class: string
  variant_choice: string | null
  enabled: number
  priority: number
  store_key: string | null
  folder_name: string | null
  variant_groups_json: string | null
}

function parseVariantGroups(json: string | null): PersistedVariantGroup[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as PersistedVariantGroup[]) : []
  } catch {
    return []
  }
}

export function listInstalled(profileId: number): InstalledMod[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT i.id AS install_id, m.id AS mod_id, i.mod_version_id, m.slug, m.title, m.author, m.source_url,
              mv.version_label, i.installed_at, i.destination_class, i.variant_choice, i.enabled, i.priority,
              i.store_key, i.folder_name, i.variant_groups_json
         FROM install i
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ?
        ORDER BY m.title COLLATE NOCASE`
    )
    .all(profileId) as Row[]

  const conflictCounts = new Map<number, number>()
  const conflictRows = db
    .prepare(
      `SELECT p.install_id, COUNT(*) c FROM provides p
         JOIN install i ON i.id = p.install_id
        WHERE i.profile_id = ?
          AND p.relative_path IN (
            SELECT p2.relative_path FROM provides p2 JOIN install i2 ON i2.id = p2.install_id
             WHERE i2.profile_id = ? GROUP BY p2.relative_path HAVING COUNT(DISTINCT p2.install_id) > 1)
        GROUP BY p.install_id`
    )
    .all(profileId, profileId) as { install_id: number; c: number }[]
  for (const r of conflictRows) conflictCounts.set(r.install_id, r.c)

  return rows.map((r) => {
    const agg = db
      .prepare('SELECT COUNT(*) c, COALESCE(SUM(size),0) s FROM install_file WHERE install_id = ?')
      .get(r.install_id) as { c: number; s: number }
    const newest = db
      .prepare('SELECT id, version_label, sha256 FROM mod_version WHERE mod_id = ? ORDER BY id DESC LIMIT 1')
      .get(r.mod_id) as { id: number; version_label: string; sha256: string | null } | undefined
    const installedVersion = db.prepare('SELECT sha256 FROM mod_version WHERE id = ?').get(r.mod_version_id) as {
      sha256: string | null
    }
    // Version strings in this scene are unreliable ("v1.0", "06/09/20",
    // "Build by Ruben"), so a differing label alone is not enough: when both
    // sides are hashed and the hashes match, it is the same file.
    const sameBytes = !!newest?.sha256 && !!installedVersion?.sha256 && newest.sha256 === installedVersion.sha256
    const updateAvailable = !!newest && newest.id !== r.mod_version_id && !sameBytes
    return {
      installId: r.install_id,
      modId: r.mod_id,
      modVersionId: r.mod_version_id,
      slug: r.slug,
      title: r.title,
      author: r.author,
      sourceUrl: r.source_url,
      versionLabel: r.version_label,
      installedAt: r.installed_at,
      destinationClass: r.destination_class as DestinationClass,
      variantChoice: r.variant_choice,
      enabled: !!r.enabled,
      priority: r.priority,
      fileCount: agg.c,
      size: agg.s,
      conflictCount: conflictCounts.get(r.install_id) ?? 0,
      updateAvailable,
      latestVersionLabel: newest?.version_label ?? null,
      subMods: listSubMods(r.install_id),
      variantGroups: parseVariantGroups(r.variant_groups_json).map(
        (g): InstalledVariantGroup => ({
          id: g.id,
          question: g.question,
          chosenOptionId: g.chosenOptionId,
          options: g.options.map((o) => ({ id: o.id, label: o.label }))
        })
      )
    }
  })
}

/**
 * Nested folders inside a Mod Loader mod are independent sub-mods: Mod Loader
 * treats each as its own unit, so they can be disabled individually.
 */
export function listSubMods(installId: number): SubMod[] {
  const files = getDb()
    .prepare("SELECT relative_path, size FROM install_file WHERE install_id = ? AND lower(relative_path) LIKE 'modloader/%'")
    .all(installId) as { relative_path: string; size: number }[]
  const byFolder = new Map<string, { count: number; size: number }>()
  for (const f of files) {
    const parts = f.relative_path.split('/')
    if (parts.length < 4) continue // modloader/<mod>/<file>
    const sub = parts[2]
    if (/\.[a-z0-9]{2,4}$/i.test(sub)) continue
    const cur = byFolder.get(sub) ?? { count: 0, size: 0 }
    cur.count++
    cur.size += f.size
    byFolder.set(sub, cur)
  }
  const disabled = new Set(
    (getDb().prepare('SELECT relative_path FROM submod_state WHERE install_id = ? AND enabled = 0').all(installId) as {
      relative_path: string
    }[]).map((r) => r.relative_path)
  )
  return [...byFolder.entries()]
    .map(([relativePath, v]) => ({ relativePath, fileCount: v.count, size: v.size, enabled: !disabled.has(relativePath) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
}

export async function setEnabled(installId: number, enabled: boolean): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT profile_id, enabled FROM install WHERE id = ?').get(installId) as
    | { profile_id: number; enabled: number }
    | undefined
  if (!row) throw new Error('That install no longer exists.')
  if (!enabled && row.enabled) recordEarlyDisable(installId)
  db.prepare('UPDATE install SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, installId)
  await remateriliseInstall(installId)
}

export async function setPriority(installId: number, priority: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT profile_id FROM install WHERE id = ?').get(installId) as { profile_id: number } | undefined
  if (!row) throw new Error('That install no longer exists.')
  db.prepare('UPDATE install SET priority = ? WHERE id = ?').run(clampPriority(priority), installId)
  await syncProfileIni(row.profile_id)
}

export async function applyPriorities(profileId: number, changes: { installId: number; priority: number }[]): Promise<void> {
  const db = getDb()
  db.transaction(() => {
    for (const c of changes) {
      db.prepare('UPDATE install SET priority = ? WHERE id = ? AND profile_id = ?').run(clampPriority(c.priority), c.installId, profileId)
    }
  })()
  await syncProfileIni(profileId)
}

export function readInstallReadme(installId: number): string | null {
  const row = getDb().prepare('SELECT readme_text FROM install WHERE id = ?').get(installId) as
    | { readme_text: string | null }
    | undefined
  return row?.readme_text ?? null
}

/** Disabling a sub-mod removes only that nested folder from the game folder. */
export async function setSubModEnabled(installId: number, relativePath: string, enabled: boolean): Promise<void> {
  const db = getDb()
  const install = db.prepare('SELECT profile_id, store_key, folder_name FROM install WHERE id = ?').get(installId) as
    | { profile_id: number; store_key: string | null; folder_name: string | null }
    | undefined
  if (!install?.folder_name) throw new Error('This mod has no nested sub-mods.')
  db.prepare(
    `INSERT INTO submod_state (install_id, relative_path, enabled) VALUES (?,?,?)
     ON CONFLICT(install_id, relative_path) DO UPDATE SET enabled = excluded.enabled`
  ).run(installId, relativePath, enabled ? 1 : 0)

  const game = requireActiveGame()
  const target = path.join(game.path, 'modloader', install.folder_name, relativePath)
  if (!enabled) {
    if (exists(target)) await fsp.rm(target, { recursive: true, force: true })
  } else if (install.store_key) {
    const src = path.join(storeDir(install.store_key), 'modloader', install.folder_name, relativePath)
    if (exists(src)) {
      const { copyRecursive } = await import('../util/fsx')
      await copyRecursive(src, target)
    }
  }
}

/**
 * Switches an already-installed mutually-exclusive variant to another option,
 * without touching the archive - every option's bytes were snapshotted into
 * the store at install time (`contentStore.ingestVariantOptions`).
 *
 * Matched by basename: the group's current on-disk paths (`targetRelatives`,
 * recorded when the plan was applied) each get their bytes replaced by the
 * file of the same name in the new option's own snapshot. This is exact for
 * the cases the field audit found - Proper Shaders' quality ladder and a
 * "(configurações)" config folder both hold one identically-named file per
 * option - and best-effort for a group whose options do not share file names.
 */
export async function switchVariant(installId: number, groupId: string, optionId: string): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT profile_id, store_key, variant_groups_json FROM install WHERE id = ?').get(installId) as
    | { profile_id: number; store_key: string | null; variant_groups_json: string | null }
    | undefined
  if (!row) throw new Error('That install no longer exists.')
  if (!row.store_key) throw new Error('This install has no store payload to switch within.')

  const groups = parseVariantGroups(row.variant_groups_json)
  const group = groups.find((g) => g.id === groupId)
  if (!group) throw new Error('That variant group is not recorded on this install.')
  if (!group.options.some((o) => o.id === optionId)) throw new Error('That option does not belong to this group.')
  if (group.chosenOptionId === optionId) return

  const storeRoot = storeDir(row.store_key)
  const fileStmt = db.prepare('UPDATE install_file SET sha256 = ?, size = ? WHERE install_id = ? AND relative_path = ?')
  const provStmt = db.prepare('UPDATE provides SET sha256 = ?, size = ? WHERE install_id = ? AND relative_path = ?')
  for (const targetRelative of group.targetRelatives) {
    const basename = path.basename(targetRelative)
    const source = await findInVariantOption(row.store_key, optionId, basename)
    if (!source) continue // this option never shipped a file of that name; the old one is left as-is
    const dest = path.join(storeRoot, targetRelative)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(source, dest)
    const sha = await sha256File(dest)
    const size = (await fsp.stat(dest)).size
    fileStmt.run(sha, size, installId, targetRelative)
    provStmt.run(sha, size, installId, targetRelative)
  }

  group.chosenOptionId = optionId
  const chosenLabel = group.options.find((o) => o.id === optionId)?.label ?? optionId
  db.prepare('UPDATE install SET variant_groups_json = ?, variant_choice = ? WHERE id = ?').run(
    JSON.stringify(groups),
    chosenLabel,
    installId
  )

  // The store now holds the new bytes; re-link (or re-copy) so the game
  // folder picks them up too. Junctioned mod folders already see the change
  // for free since they point straight at the store.
  await remateriliseInstall(installId)
}
