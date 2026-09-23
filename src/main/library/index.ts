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
import { dematerialise, listVariantOption, quarantineEdited, storeDir } from '../store/contentStore'
import { providesKey } from '../conflicts'
import { Paths } from '../util/paths'

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
 * Maps the incoming option's files onto the destinations the outgoing option
 * currently occupies.
 *
 * The outgoing option's targets and its own snapshot are both on record, so
 * the prefix the installer put in front of each file can be read back off
 * them: "modloader/Zone Text" + "zonetext.ini". A file the incoming option
 * ships at the same relative path lands on the same target; one it ships under
 * a different name lands under that prefix. Nothing is guessed - an outgoing
 * target that cannot be traced back to a file, or a layout with more than one
 * prefix and no exact match, throws rather than switching half the group.
 */
function planVariantSwap(
  outgoingTargets: string[],
  outgoingFiles: { rel: string }[],
  incomingFiles: { rel: string; abs: string }[],
  labels: { from: string; to: string }
): { abs: string; target: string }[] {
  if (outgoingTargets.length === 0) throw new Error(`Modão has no record of what "${labels.from}" installed, so it cannot replace it.`)
  if (incomingFiles.length === 0) throw new Error(`"${labels.to}" has no files in the store, so Modão will not switch to it.`)

  const byRel = new Map<string, string>()
  const prefixes = new Set<string>()
  for (const target of outgoingTargets) {
    const t = target.toLowerCase()
    const source = outgoingFiles.find((f) => t === f.rel.toLowerCase() || t.endsWith(`/${f.rel.toLowerCase()}`))
    if (!source) {
      throw new Error(
        `Modão cannot tell which part of "${labels.from}" installed ${target}, so it will not guess what replaces it. ` +
          'Reinstall the mod and pick the option you want.'
      )
    }
    byRel.set(source.rel.toLowerCase(), target)
    prefixes.add(target.slice(0, target.length - source.rel.length).replace(/\/+$/, ''))
  }

  const swap: { abs: string; target: string }[] = []
  const claimed = new Set<string>()
  for (const f of incomingFiles) {
    const exact = byRel.get(f.rel.toLowerCase())
    if (!exact && prefixes.size > 1) {
      throw new Error(
        `"${labels.to}" ships ${f.rel}, which "${labels.from}" did not, and this mod spreads that group over more ` +
          'than one folder - Modão will not guess where it goes. Reinstall the mod and pick the option you want.'
      )
    }
    const prefix = [...prefixes][0] ?? ''
    const target = exact ?? (prefix ? `${prefix}/${f.rel}` : f.rel)
    if (claimed.has(target.toLowerCase())) {
      throw new Error(`"${labels.to}" would put two files at ${target}. Modão will not switch to it.`)
    }
    claimed.add(target.toLowerCase())
    swap.push({ abs: f.abs, target })
  }
  return swap
}

/**
 * Switches an already-installed mutually-exclusive variant to another option,
 * without touching the archive - every option's bytes were snapshotted into
 * the store at install time (`contentStore.ingestVariantOptions`).
 *
 * The outgoing option's files are REMOVED - from the store, from the game
 * folder and from this install's records - before the incoming option's are
 * written. Exactly one option is live afterwards, which is the whole point of
 * the group: a switch that left the old file beside the new one would be the
 * "nine presets installed at once" bug wearing a different hat. It is also
 * all-or-nothing. Everything is resolved before anything is moved, and a file
 * that cannot be placed throws with the group untouched, rather than reporting
 * success over a half-swapped install.
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
  const incoming = group.options.find((o) => o.id === optionId)
  if (!incoming) throw new Error('That option does not belong to this group.')
  if (group.chosenOptionId === optionId) return
  const outgoingLabel = group.options.find((o) => o.id === group.chosenOptionId)?.label ?? group.chosenOptionId

  // --- resolve everything first; nothing below this block may fail ----------
  const storeKey = row.store_key
  const swap = planVariantSwap(
    group.targetRelatives,
    await listVariantOption(storeKey, group.chosenOptionId),
    await listVariantOption(storeKey, optionId),
    { from: outgoingLabel, to: incoming.label }
  )

  const storeRoot = storeDir(storeKey)
  const outgoingRows = db
    .prepare('SELECT relative_path, backup_path, sha256, destination_class FROM install_file WHERE install_id = ?')
    .all(installId) as { relative_path: string; backup_path: string | null; sha256: string | null; destination_class: string }[]
  const mine = new Set(group.targetRelatives.map((t) => t.toLowerCase()))
  const leaving = outgoingRows.filter((r) => mine.has(r.relative_path.toLowerCase()))
  // Every file in the group shares one destination class - it is one folder in
  // one place - so the outgoing rows say what the incoming ones are.
  const destination = (leaving[0]?.destination_class ?? 'modloader-folder') as DestinationClass

  // --- from here on it is a swap, and it completes ---------------------------
  const profile = db.prepare('SELECT is_active FROM profile WHERE id = ?').get(row.profile_id) as { is_active: number } | undefined
  if (profile?.is_active) {
    const game = requireActiveGame()
    // A file the user edited by hand is theirs, whichever way it leaves.
    await quarantineEdited(
      game.path,
      leaving.map((r) => ({ relativePath: r.relative_path, sha256: r.sha256 })),
      path.join(Paths.quarantine(), 'variant', String(installId))
    )
    // The store copy goes first, so removing a path that reaches the store
    // through a junction cannot take the incoming bytes with it.
    for (const r of leaving) await fsp.rm(path.join(storeRoot, r.relative_path), { force: true })
    await dematerialise(
      game,
      leaving.map((r) => r.relative_path),
      leaving.filter((r) => r.backup_path).map((r) => ({ relativePath: r.relative_path, backupPath: r.backup_path! })),
      // Every path here is one this install wrote and this switch is replacing;
      // anything the user edited went to quarantine three lines up.
      { mayRemoveFile: () => true }
    )
  } else {
    for (const r of leaving) await fsp.rm(path.join(storeRoot, r.relative_path), { force: true })
  }

  const written: { target: string; sha256: string; size: number }[] = []
  for (const s of swap) {
    const dest = path.join(storeRoot, s.target)
    await fsp.mkdir(path.dirname(dest), { recursive: true })
    await fsp.copyFile(s.abs, dest)
    written.push({ target: s.target, sha256: await sha256File(dest), size: (await fsp.stat(dest)).size })
  }

  group.chosenOptionId = optionId
  group.targetRelatives = written.map((w) => w.target)
  // Every group's choice, not just this one: an install with two groups used to
  // lose the other one's label the moment either was switched.
  const variantChoice = groups.map((g) => g.chosenOptionId).join(' + ') || null

  db.transaction(() => {
    const dropFile = db.prepare('DELETE FROM install_file WHERE install_id = ? AND relative_path = ?')
    const dropProvides = db.prepare('DELETE FROM provides WHERE install_id = ? AND relative_path = ?')
    for (const r of leaving) {
      dropFile.run(installId, r.relative_path)
      dropProvides.run(installId, providesKey(r.relative_path))
    }
    const addFile = db.prepare(
      `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
       VALUES (?,?,?,?,0,NULL,?)`
    )
    const addProvides = db.prepare('INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,?,?)')
    for (const w of written) {
      addFile.run(installId, w.target, w.sha256, w.size, destination)
      addProvides.run(installId, providesKey(w.target), w.sha256, w.size)
    }
    db.prepare('UPDATE install SET variant_groups_json = ?, variant_choice = ? WHERE id = ?').run(
      JSON.stringify(groups),
      variantChoice,
      installId
    )
  })()

  // The store now holds the new bytes; re-link (or re-copy) so the game folder
  // picks them up too. A junctioned mod folder sees the change for free.
  await remateriliseInstall(installId)
}
