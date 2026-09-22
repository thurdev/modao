import path from 'node:path'
import fsp from 'node:fs/promises'
import type { DestinationClass, InstalledMod, SubMod } from '@shared/types'
import { getDb } from '../db'
import { clampPriority } from '../game/modloaderIni'
import { remateriliseInstall, syncProfileIni } from '../profiles/materialize'
import { recordEarlyDisable } from '../catalog/rating'
import { requireActiveGame } from '../game/detect'
import { exists } from '../util/fsx'
import { storeDir } from '../store/contentStore'

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
}

export function listInstalled(profileId: number): InstalledMod[] {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT i.id AS install_id, m.id AS mod_id, i.mod_version_id, m.slug, m.title, m.author, m.source_url,
              mv.version_label, i.installed_at, i.destination_class, i.variant_choice, i.enabled, i.priority,
              i.store_key, i.folder_name
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
      subMods: listSubMods(r.install_id)
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
