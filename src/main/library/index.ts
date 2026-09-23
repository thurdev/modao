import path from 'node:path'
import fsp from 'node:fs/promises'
import type { DestinationClass, InstalledMod, InstalledVariantGroup, SubMod, VariantSwapRecord } from '@shared/types'
import type { PersistedVariantGroup } from '@shared/variantGroups'
import { decideVariantRecovery } from '@shared/switchJournal'
import { loadOrderOf } from '@shared/loadOrder'
import { getDb } from '../db'
import { clampPriority } from '../game/modloaderIni'
import { remateriliseInstall, syncProfileIni } from '../profiles/materialize'
import { recordEarlyDisable } from '../catalog/rating'
import { requireActiveGame } from '../game/detect'
import { exists, isDirectory, isLink, sha256File } from '../util/fsx'
import { listVariantOption, quarantineEdited, storeDir } from '../store/contentStore'
import { setSubFolderEnabled } from '../store/folderSpelling'
import { openJournal, recordManifest, restoreFromJournal, setJournalState, snapshotFiles } from '../profiles/switchTx'
import { providesKey } from '../conflicts'
import { Paths } from '../util/paths'
import { learnPriorityOverride, learnVariantChoice } from '../knowledge/learn'

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
  load_first: number
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
              i.load_first, i.store_key, i.folder_name, i.variant_groups_json
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

  // LOAD ORDER, worked out once for the whole profile: Mod Loader loads .asi
  // plugins in alphabetical order of the mod folder name, "$" first. It reads
  // nothing from priority, and priority reads nothing from it - they answer
  // different questions and the UI says so.
  const rank = new Map<string, number | null>()
  for (const e of loadOrderOf(
    rows
      .filter((r) => r.folder_name)
      .map((r) => ({
        folder: r.folder_name!,
        enabled: !!r.enabled,
        loadFirst: !!r.load_first,
        priority: r.priority
      }))
  )) {
    rank.set(e.folder.toLowerCase(), e.rank)
  }

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
      folderName: r.folder_name,
      loadFirst: !!r.load_first,
      loadOrderRank: r.folder_name ? rank.get(r.folder_name.toLowerCase()) ?? null : null,
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

/**
 * Spells this mod's folder with - or without - the "$" that makes its .asi load
 * before the others.
 *
 * LOAD ORDER IS NOT PRIORITY. This changes when the plugin hooks the game and
 * nothing at all about which mod wins a duplicated file; `setPriority` is the
 * other one and they are deliberately separate calls.
 */
export async function setLoadFirst(installId: number, loadFirst: boolean): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT profile_id, folder_name FROM install WHERE id = ?').get(installId) as
    | { profile_id: number; folder_name: string | null }
    | undefined
  if (!row) throw new Error('That install no longer exists.')
  if (!row.folder_name) {
    throw new Error('Load order is a mod-folder name. This install does not own a folder in modloader\.')
  }
  db.prepare('UPDATE install SET load_first = ? WHERE id = ?').run(loadFirst ? 1 : 0, installId)
  await remateriliseInstall(installId)
}

export async function setPriority(installId: number, priority: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT profile_id, folder_name FROM install WHERE id = ?').get(installId) as
    | { profile_id: number; folder_name: string | null }
    | undefined
  if (!row) throw new Error('That install no longer exists.')
  const clamped = clampPriority(priority)
  db.prepare('UPDATE install SET priority = ? WHERE id = ?').run(clamped, installId)
  // A slider a person moved by hand is the strongest evidence the store has -
  // nothing else ever changes a priority away from the install default.
  if (row.folder_name) learnPriorityOverride(row.folder_name, clamped)
  await syncProfileIni(row.profile_id)
}

export async function applyPriorities(profileId: number, changes: { installId: number; priority: number }[]): Promise<void> {
  const db = getDb()
  const folders = new Map(
    (db.prepare('SELECT id, folder_name FROM install WHERE profile_id = ?').all(profileId) as { id: number; folder_name: string | null }[]).map(
      (r) => [r.id, r.folder_name]
    )
  )
  db.transaction(() => {
    for (const c of changes) {
      db.prepare('UPDATE install SET priority = ? WHERE id = ? AND profile_id = ?').run(clampPriority(c.priority), c.installId, profileId)
    }
  })()
  for (const c of changes) {
    const folder = folders.get(c.installId)
    if (folder) learnPriorityOverride(folder, clampPriority(c.priority))
  }
  await syncProfileIni(profileId)
}

export function readInstallReadme(installId: number): string | null {
  const row = getDb().prepare('SELECT readme_text FROM install WHERE id = ?').get(installId) as
    | { readme_text: string | null }
    | undefined
  return row?.readme_text ?? null
}

/**
 * Turns one nested sub-mod on or off - by RENAMING it, never by removing it.
 *
 * Mod Loader treats a folder inside a mod folder as its own unit, so its own
 * ". " (dot space) prefix works one level down exactly as it does at the top:
 * modloader\<Mod>\<Sub> becomes modloader\<Mod>\. <Sub> and Mod Loader stops
 * reading it.
 *
 * What was here before was the single most destructive line in the app:
 * `fsp.rm(target, { recursive: true, force: true })` on a path inside a mod
 * folder that is, for every junctioned install, THE CONTENT STORE ITSELF. It
 * deleted the sub-mod out of Modão's only copy, and re-enabling then copied it
 * back from the store path it had just destroyed - so a toggle off and on lost
 * the sub-mod for good. A rename cannot do that: the bytes never move and the
 * store is renamed with the game folder because they are the same directory.
 */
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
  const change = await setSubFolderEnabled(game.path, install.folder_name, relativePath, enabled)
  if (change.action === 'blocked') throw new Error(`Modão did not rename ${relativePath}: ${change.note}`)
  // Only when the folder is not on disk under ANY spelling is the store asked
  // for it - a profile that has never been materialised, say. The old code did
  // this on every enable, from a path it had itself just deleted.
  if (change.action === 'absent' && enabled && install.store_key) {
    const src = path.join(storeDir(install.store_key), 'modloader', install.folder_name, relativePath)
    const target = path.join(game.path, 'modloader', install.folder_name, relativePath)
    if (exists(src) && !exists(target)) {
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
 * folder and from this install's records - as the incoming option's are
 * written. Exactly one option is live afterwards, which is the whole point of
 * the group: a switch that left the old file beside the new one would be the
 * "nine presets installed at once" bug wearing a different hat.
 *
 * It is also all-or-nothing, in three stages:
 *
 * 1. RESOLVE. Which incoming file lands on which target is worked out in full
 *    (`planVariantSwap`) before anything moves. Anything ambiguous throws here,
 *    with the install untouched.
 * 2. STAGE. The outgoing bytes are snapshotted out of the store and hash-checked
 *    by `snapshotFiles` - the profile switch's own primitive - and the incoming
 *    bytes are staged and hash-checked beside them. Both states now exist on
 *    disk. Still nothing has been removed.
 * 3. SWAP. Store, then game folder, then rows, then relink. Any throw runs the
 *    undo: the staged bytes come out, the snapshot goes back, the rows are
 *    restored to exactly what they were, and the install is re-materialised. The
 *    caller sees the old option, live, and an error saying so - never a
 *    half-swap, and never rows describing bytes that are gone.
 *
 * Nothing unlinks a whole mod folder. A junctioned folder IS the store folder,
 * so it follows every store write on its own; a per-file install has only the
 * files being swapped touched.
 */
export async function switchVariant(installId: number, groupId: string, optionId: string): Promise<void> {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT i.profile_id, i.store_key, i.variant_groups_json, i.variant_choice, i.folder_name, m.title
         FROM install i
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.id = ?`
    )
    .get(installId) as
    | {
        profile_id: number
        store_key: string | null
        variant_groups_json: string | null
        variant_choice: string | null
        folder_name: string | null
        title: string
      }
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
    .prepare('SELECT relative_path, backup_path, sha256, size, was_overwrite, destination_class FROM install_file WHERE install_id = ?')
    .all(installId) as {
    relative_path: string
    backup_path: string | null
    sha256: string | null
    size: number
    was_overwrite: number
    destination_class: string
  }[]
  const mine = new Set(group.targetRelatives.map((t) => t.toLowerCase()))
  const leaving = outgoingRows.filter((r) => mine.has(r.relative_path.toLowerCase()))
  // Every file in the group shares one destination class - it is one folder in
  // one place - so the outgoing rows say what the incoming ones are.
  const destination = (leaving[0]?.destination_class ?? 'modloader-folder') as DestinationClass

  const profile = db.prepare('SELECT is_active FROM profile WHERE id = ?').get(row.profile_id) as { is_active: number } | undefined
  const game = profile?.is_active ? requireActiveGame() : null

  // --- staging: both states exist on disk, verified, before anything is lost -
  // Every destructive step below has a byte-for-byte copy behind it, taken and
  // hash-checked by the same `snapshotFiles` the profile switch uses, and the
  // whole thing is journalled the way a profile switch is, so a kill or a power
  // cut is recoverable and not only a thrown error. This branch exists because
  // a filesystem mutation with no verified undo destroyed a real install; a
  // variant swap gets the same treatment.
  // A journal this install left open across a boot describes a state that is
  // about to stop being anybody's: the swap below resolves and stages against
  // what the install row says RIGHT NOW, so once it runs, those older outgoing
  // bytes are no longer a state to go back to. Closing them here is what stops
  // a stale journal from later "recovering" over this swap's result.
  supersedeOpenSwaps(installId, 'a newer switch of the same install started')
  // `kind` is what keeps this row out of `lastRestorableSwitch` and out of the
  // switch history: it is a swap inside one mod's store folder, not a previous
  // state of the game folder, and "Restore previous state" must never see it.
  // `fromProfileId` is null for the same reason - there is no profile being
  // left here - which `restorePreviousState` refuses a second way.
  const journal = openJournal(null, row.profile_id, 'variant-swap')
  const workDir = journal.snapshotDir
  const rollback = await snapshotFiles(
    storeRoot,
    leaving.map((r) => r.relative_path),
    path.join(workDir, 'outgoing')
  )
  if (rollback.length !== leaving.length) {
    setJournalState(journal.id, 'restored', 'refused: the store no longer holds the outgoing option')
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
    throw new Error(
      `The store no longer holds every file "${outgoingLabel}" installed, so Modão cannot undo a switch away from it ` +
        'and will not start one. Reinstall the mod and pick the option you want.'
    )
  }
  const staged: { target: string; from: string; sha256: string; size: number }[] = []
  for (const s of swap) {
    const to = path.join(workDir, 'incoming', s.target)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(s.abs, to)
    const sha = await sha256File(to)
    if (sha !== (await sha256File(s.abs))) {
      setJournalState(journal.id, 'restored', `refused: the staged copy of ${s.target} did not verify`)
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
      throw new Error(`The staged copy of ${s.target} does not match the store. Nothing was changed.`)
    }
    staged.push({ target: s.target, from: to, sha256: sha, size: (await fsp.stat(to)).size })
  }

  // What the recovery needs if this process never reaches the end: which paths
  // the outgoing option owns (the manifest holds their verified bytes) and which
  // the incoming one would take, so an orphan of a half-finished swap can be
  // found and removed rather than left showing through a junction.
  recordManifest(journal.id, rollback)
  db.prepare('UPDATE switch_journal SET variant_swap_json = ? WHERE id = ?').run(
    JSON.stringify({
      installId,
      groupId,
      fromOptionId: group.chosenOptionId,
      toOptionId: optionId,
      outgoingTargets: leaving.map((r) => r.relative_path),
      incomingTargets: staged.map((s) => s.target)
    } satisfies VariantSwapRecord),
    journal.id
  )

  // A file the user edited by hand is theirs, whichever way it leaves. Copying
  // it out changes nothing, so it belongs in the staging half.
  if (game) {
    await quarantineEdited(
      game.path,
      leaving.map((r) => ({ relativePath: r.relative_path, sha256: r.sha256 })),
      path.join(Paths.quarantine(), 'variant', String(installId))
    )
  }

  /**
   * A mod folder materialised as a junction IS the store folder, so the game
   * folder follows every store write for free and must not be unlinked. Only a
   * per-file (hardlink or copy) install needs its own files touched - and then
   * only the ones being swapped, never the whole folder.
   */
  const followsStore = (rel: string): boolean => {
    if (!game) return true
    const m = /^modloader\/([^/]+)\//.exec(rel)
    return !!m && isLink(path.join(game.path, 'modloader', m[1]))
  }

  group.chosenOptionId = optionId
  group.targetRelatives = staged.map((s) => s.target)
  // Every group's choice, not just this one: an install with two groups used to
  // lose the other one's label the moment either was switched.
  const variantChoice = groups.map((g) => g.chosenOptionId).join(' + ') || null

  let committed = false
  const restoredBackups: string[] = []
  const undo = async (): Promise<void> => {
    // Newest first: drop what the incoming option wrote, then put the outgoing
    // bytes back where they came from, then the rows, then the game folder.
    for (const s of staged) await fsp.rm(path.join(storeRoot, s.target), { force: true }).catch(() => undefined)
    for (const b of rollback) {
      const to = path.join(storeRoot, b.relativePath)
      await fsp.mkdir(path.dirname(to), { recursive: true })
      await fsp.copyFile(b.backupPath, to)
    }
    for (const p of restoredBackups) await fsp.rm(p, { force: true }).catch(() => undefined)
    if (committed) {
      db.transaction(() => {
        for (const s of staged) {
          db.prepare('DELETE FROM install_file WHERE install_id = ? AND relative_path = ?').run(installId, s.target)
          db.prepare('DELETE FROM provides WHERE install_id = ? AND relative_path = ?').run(installId, providesKey(s.target))
        }
        const addFile = db.prepare(
          `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
           VALUES (?,?,?,?,?,?,?)`
        )
        const addProvides = db.prepare('INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,?,?)')
        for (const r of leaving) {
          addFile.run(installId, r.relative_path, r.sha256, r.size, r.was_overwrite, r.backup_path, r.destination_class)
          addProvides.run(installId, providesKey(r.relative_path), r.sha256, r.size)
        }
        db.prepare('UPDATE install SET variant_groups_json = ?, variant_choice = ? WHERE id = ?').run(
          row.variant_groups_json,
          row.variant_choice,
          installId
        )
      })()
    }
    await remateriliseInstall(installId)
  }

  try {
    // 1. The store: the outgoing bytes out, the staged bytes in.
    for (const r of leaving) await fsp.rm(path.join(storeRoot, r.relative_path), { force: true })
    for (const s of staged) {
      const dest = path.join(storeRoot, s.target)
      await fsp.mkdir(path.dirname(dest), { recursive: true })
      await fsp.copyFile(s.from, dest)
    }

    // 2. The game folder, only where it does not already follow the store, and
    //    only the files this swap replaces.
    if (game) {
      const keeping = new Set(staged.map((s) => s.target.toLowerCase()))
      for (const r of leaving) {
        if (followsStore(r.relative_path)) continue
        const p = path.join(game.path, r.relative_path)
        if (exists(p) && !isDirectory(p)) await fsp.rm(p, { force: true })
        // Nothing is taking this path over, so whatever it displaced comes back.
        if (r.backup_path && !keeping.has(r.relative_path.toLowerCase()) && exists(r.backup_path)) {
          await fsp.mkdir(path.dirname(p), { recursive: true })
          await fsp.copyFile(r.backup_path, p)
          restoredBackups.push(p)
        }
      }
    }

    // 3. The rows, in one SQLite transaction.
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
      for (const s of staged) {
        addFile.run(installId, s.target, s.sha256, s.size, destination)
        addProvides.run(installId, providesKey(s.target), s.sha256, s.size)
      }
      db.prepare('UPDATE install SET variant_groups_json = ?, variant_choice = ? WHERE id = ?').run(
        JSON.stringify(groups),
        variantChoice,
        installId
      )
    })()
    committed = true

    // 4. Link the new bytes into the game folder.
    await remateriliseInstall(installId)

    // A person switching a variant by hand after the install is exactly the
    // correction the spec means: it outranks whatever the detector guessed
    // when the archive first went in. Keyed by folder rather than the archive
    // signature - that survives a reinstall of the same mod, which a switch
    // usually follows.
    if (row.folder_name) learnVariantChoice(row.folder_name.toLowerCase(), 'folder', group, row.title)
  } catch (e) {
    try {
      await undo()
    } catch (undoError) {
      // The disk and the rows may now disagree with each other and with what
      // the journal recorded - a plain exception cannot undo a mutation that
      // itself failed. The journal is left in 'failed' rather than silently
      // dropped, so the next boot's `recoverStaleVariantSwaps` tries again
      // from the install row's own answer instead of never looking.
      setJournalState(
        journal.id,
        'failed',
        `switch failed (${(e as Error).message}) AND the rollback failed (${(undoError as Error).message})`
      )
      throw new Error(
        `Switching to "${incoming.label}" failed (${(e as Error).message}) AND the rollback failed ` +
          `(${(undoError as Error).message}). A verified copy of "${outgoingLabel}" is in ${path.join(workDir, 'outgoing')}.`
      )
    }
    setJournalState(journal.id, 'restored', `switch failed and was rolled back: ${(e as Error).message}`)
    throw new Error(
      `Switching to "${incoming.label}" failed, so Modão put "${outgoingLabel}" back: ${(e as Error).message}`
    )
  }

  setJournalState(journal.id, 'verified')
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => undefined)
}

/**
 * Finds a variant swap that started but never recorded how it ended -
 * `openJournal` ran and the process is simply gone before `switchVariant`
 * reached its own `setJournalState` again, the way a kill or a power cut
 * leaves things. SQLite's own atomicity means the install row is never caught
 * mid-write: by the time this runs, it already names either the option the
 * swap was leaving or the one it was going to, in full. That answer is read
 * first and the disk is reconciled to match it, rather than guessed at from
 * the journal alone - the same "the row says what won" split a profile
 * switch's own recovery leans on.
 *
 * Meant to run once at boot, before anything else touches a profile: the
 * dangerous window this closes is a junctioned mod folder showing the
 * incoming bytes - because the folder IS the store - while the row still
 * names the outgoing option, which a kill mid-swap can leave open with no
 * error ever thrown for `switchVariant`'s own try/catch to catch.
 */
export async function recoverStaleVariantSwaps(): Promise<{ recovered: number; problems: string[] }> {
  const db = getDb()
  // Variant swaps only. The kind column is the discriminator; the COALESCE
  // reads a row written before that column existed exactly as `journalKindOf`
  // does, so a journal left open by an older build is still picked up here -
  // and a profile switch's journal is still never picked up here.
  const rows = db
    .prepare(
      `SELECT id FROM switch_journal
        WHERE COALESCE(kind, CASE WHEN variant_swap_json IS NOT NULL THEN 'variant-swap' ELSE 'profile-switch' END)
              = 'variant-swap'
          AND variant_swap_json IS NOT NULL
          AND state IN ('snapshotted','failed')`
    )
    .all() as { id: number }[]
  const problems: string[] = []
  let recovered = 0

  for (const row of rows) {
    // Whatever happens below, this journal reaches a terminal state before the
    // loop moves on. A row left at 'snapshotted' is a row the NEXT boot would
    // act on again, against an install that has moved on in the meantime -
    // which is how a stale journal came to be able to stomp a later,
    // fully-successful swap.
    let close: { state: 'verified' | 'restored' | 'failed'; note: string | null } = {
      state: 'failed',
      note: 'recovery did not run to completion'
    }
    try {
      const journalRow = db.prepare('SELECT variant_swap_json FROM switch_journal WHERE id = ?').get(row.id) as
        | { variant_swap_json: string | null }
        | undefined
      if (!journalRow?.variant_swap_json) {
        close = { state: 'restored', note: 'the journal carries no variant-swap record' }
        continue
      }
      const record = JSON.parse(journalRow.variant_swap_json) as VariantSwapRecord

      const install = db
        .prepare('SELECT store_key, variant_groups_json, profile_id FROM install WHERE id = ?')
        .get(record.installId) as { store_key: string | null; variant_groups_json: string | null; profile_id: number } | undefined
      if (!install?.store_key) {
        // The install (or its store payload) is gone some other way; nothing
        // is left to reconcile. Close the journal rather than retry forever.
        close = { state: 'restored', note: 'the install this swap belonged to no longer has a store payload' }
        recovered++
        continue
      }

      const groups = parseVariantGroups(install.variant_groups_json)
      const group = groups.find((g) => g.id === record.groupId)
      const profile = db.prepare('SELECT is_active FROM profile WHERE id = ?').get(install.profile_id) as
        | { is_active: number }
        | undefined
      // Never "not landed, therefore still on the old option". The row is
      // checked against BOTH ends of the swap, and if it names neither - a
      // later swap of this group already succeeded, or a reinstall reshaped
      // the group so its id no longer resolves - this journal's manifest is
      // older than whatever is live and putting it back would destroy a
      // legitimate choice silently. It stands down instead.
      const decision = decideVariantRecovery(record, group?.chosenOptionId)

      if (decision === 'stand-down') {
        close = {
          state: 'restored',
          note:
            `stood down: this install now has "${group?.chosenOptionId ?? 'no recorded option for that group'}", ` +
            `which is neither the option the swap was leaving ("${record.fromOptionId}") nor the one it was going to ` +
            `("${record.toOptionId}"), so its snapshot is no longer a state to restore`
        }
        recovered++
        continue
      }

      if (decision === 'materialise-again') {
        // The row already names the new option, so the swap committed before
        // the crash. Only its materialisation into the game folder might be
        // unfinished; redoing it is always safe.
        const relinked = await relink(profile?.is_active ? record.installId : null)
        if (relinked) problems.push(`swap #${row.id}: ${relinked}`)
        close = { state: 'verified', note: relinked }
      } else {
        // The row still names the old option: the swap never committed.
        // Whatever the store shows is put back from the verified snapshot -
        // pointed at the store, not the game folder, because a junction
        // mirrors the store and fixing the store is what fixes the junction.
        const result = await restoreFromJournal(row.id, { baseDir: storeDir(install.store_key) })
        problems.push(...result.problems.map((p) => `swap #${row.id}: ${p}`))
        // An incoming file that landed nowhere the outgoing option also used
        // is an orphan of the half-finished swap; nothing references it once
        // the outgoing bytes are back, so it comes out rather than lingering.
        for (const target of record.incomingTargets) {
          if (record.outgoingTargets.some((t) => t.toLowerCase() === target.toLowerCase())) continue
          await fsp.rm(path.join(storeDir(install.store_key), target), { force: true }).catch(() => undefined)
        }
        const relinked = await relink(profile?.is_active ? record.installId : null)
        if (relinked) problems.push(`swap #${row.id}: ${relinked}`)
        // `restoreFromJournal` already moved the row to 'restored'; re-stating
        // it keeps the note, and keeps every exit from this loop terminal.
        close = { state: 'restored', note: relinked }
      }
      recovered++
    } catch (e) {
      problems.push(`swap #${row.id}: ${(e as Error).message}`)
      close = { state: 'failed', note: `recovery failed: ${(e as Error).message}` }
    } finally {
      try {
        setJournalState(row.id, close.state, close.note)
      } catch (e) {
        problems.push(`swap #${row.id}: the journal could not be closed (${(e as Error).message})`)
      }
    }
  }
  return { recovered, problems }
}

/**
 * Re-links an install into the game folder, reporting a failure instead of
 * throwing it.
 *
 * Re-materialising is the LAST step of a recovery and never the thing being
 * recovered: the store and the rows already agree by the time it runs. A
 * transient failure here (no game detected yet, a file held open) used to
 * escape into the per-row catch before the journal was closed, leaving the row
 * open for the next boot to act on all over again - against an install that
 * may have been switched, correctly, in between.
 */
async function relink(installId: number | null): Promise<string | null> {
  if (installId === null) return null
  try {
    await remateriliseInstall(installId)
    return null
  } catch (e) {
    return `the store and the records agree again, but re-linking into the game folder failed: ${(e as Error).message}`
  }
}

/**
 * Closes any variant-swap journal this install left open.
 *
 * An open journal is a claim that the install is still mid-swap. The moment a
 * new swap of the same install resolves and stages against the install's
 * CURRENT row, that claim is stale: its outgoing bytes describe a state the
 * user has since moved away from deliberately. Left open, the next boot's
 * recovery would find it and - before this round, unconditionally - restore
 * that older option over the newer one.
 */
function supersedeOpenSwaps(installId: number, why: string): void {
  const db = getDb()
  const rows = db
    .prepare(
      `SELECT id, variant_swap_json FROM switch_journal
        WHERE COALESCE(kind, CASE WHEN variant_swap_json IS NOT NULL THEN 'variant-swap' ELSE 'profile-switch' END)
              = 'variant-swap'
          AND variant_swap_json IS NOT NULL
          AND state IN ('snapshotted','failed')`
    )
    .all() as { id: number; variant_swap_json: string | null }[]
  for (const r of rows) {
    try {
      const record = JSON.parse(r.variant_swap_json ?? '{}') as Partial<VariantSwapRecord>
      if (record.installId !== installId) continue
      setJournalState(r.id, 'restored', `superseded: ${why}`)
    } catch {
      // A journal whose record will not parse cannot be matched to an install
      // and is never acted on by the recovery either; leave it alone.
    }
  }
}
