import path from 'node:path'
import fsp from 'node:fs/promises'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { copyRecursive, exists, isDirectory, isLink, linkOrCopyFile, sha256File, walk } from '../util/fsx'
import { requireActiveGame } from '../game/detect'
import { storeDir, storeKey } from '../store/contentStore'
import { existsUnderAnySpelling, resolveSpelledPath } from '../store/folderSpelling'
import { spellFolderName } from '@shared/loadOrder'
import type {
  SnapshotEntry,
  SwitchFilePlan,
  SwitchJournal,
  SwitchPlan,
  SwitchState,
  SwitchVerification
} from '@shared/types'
import { isRestorableProfileSwitch, journalKindOf, type SwitchJournalKind } from '@shared/switchJournal'

/**
 * A profile switch removes files from a folder full of the user's own work, so
 * it is run as a transaction: everything it is about to remove or overwrite is
 * copied out and verified FIRST, the copy is written down in a journal, and the
 * removal only happens for files the snapshot provably holds. If the snapshot
 * does not verify, the switch does not start.
 *
 * This exists because it once did not. A switch deleted every loose .asi and
 * every CLEO script in a 48-mod install - files Modão had adopted but never
 * copied anywhere - and the quarantine folder held three of them.
 */

interface InstallRow {
  id: number
  store_key: string | null
  folder_name: string | null
  enabled: number
  priority: number
  /** The folder wears the "$" load-first prefix. Load order, not priority. */
  load_first: number
  destination_class: string
}

interface FileRow {
  install_id: number
  relative_path: string
  sha256: string | null
  size: number
}

function installsOf(profileId: number): InstallRow[] {
  return getDb().prepare('SELECT * FROM install WHERE profile_id = ? ORDER BY id').all(profileId) as InstallRow[]
}

function filesOfProfile(profileId: number): FileRow[] {
  return getDb()
    .prepare(
      `SELECT f.install_id, f.relative_path, f.sha256, f.size
         FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? ORDER BY f.install_id, f.relative_path`
    )
    .all(profileId) as FileRow[]
}

function labelOf(row: InstallRow, fallbackFile?: string): string {
  return row.folder_name ?? (fallbackFile ? path.basename(fallbackFile) : `install ${row.id}`)
}

/** modloader.ini is rewritten by every switch, so it is snapshotted like any other file. */
export function iniRelativePath(): string {
  return 'modloader/modloader.ini'
}

/**
 * Works out exactly what a switch would do, touching nothing. This is both the
 * dry run the user can ask for and the plan the real switch executes, so what
 * the dry run prints is what happens.
 */
export async function planSwitch(toProfileId: number): Promise<SwitchPlan> {
  const db = getDb()
  const game = requireActiveGame()
  const from = db.prepare('SELECT id, name FROM profile WHERE is_active = 1').get() as
    | { id: number; name: string }
    | undefined
  const to = db.prepare('SELECT id, name FROM profile WHERE id = ?').get(toProfileId) as
    | { id: number; name: string }
    | undefined
  if (!to) throw new Error('That profile no longer exists.')

  const outgoing: SwitchFilePlan[] = []
  const toIngest: SwitchPlan['toIngest'] = []
  let totalBytes = 0

  if (from) {
    const rows = installsOf(from.id)
    const byId = new Map(rows.map((r) => [r.id, r]))
    const files = filesOfProfile(from.id)
    const perInstall = new Map<number, number>()
    for (const f of files) perInstall.set(f.install_id, (perInstall.get(f.install_id) ?? 0) + 1)

    for (const row of rows) {
      if (row.store_key) continue
      const count = perInstall.get(row.id) ?? 0
      if (count > 0) toIngest.push({ installId: row.id, label: labelOf(row), files: count })
    }

    for (const f of files) {
      const row = byId.get(f.install_id)
      if (!row) continue
      const abs = path.join(game.path, f.relative_path)
      const label = labelOf(row, f.relative_path)
      if (isLink(abs)) {
        outgoing.push({
          relativePath: f.relative_path,
          action: 'drop-link',
          installId: row.id,
          label,
          reason: 'a link into the Modão store; the payload stays in the store',
          sizeBytes: 0
        })
        continue
      }
      if (!exists(abs)) continue
      totalBytes += f.size
      outgoing.push({
        relativePath: f.relative_path,
        action: 'snapshot-and-remove',
        installId: row.id,
        label,
        reason: row.store_key ? 'managed file; a verified copy is taken first' : 'adopted file; copied into the store and snapshotted first',
        sizeBytes: f.size
      })
    }

    const ini = path.join(game.path, iniRelativePath())
    if (exists(ini)) {
      outgoing.push({
        relativePath: iniRelativePath(),
        action: 'snapshot-and-remove',
        installId: null,
        label: 'modloader.ini',
        reason: 'rewritten by the switch; the current one is kept',
        sizeBytes: (await fsp.stat(ini)).size
      })
    }
  }

  // Everything in the target profile that will be placed into the game folder,
  // plus anything that cannot be: a mod with no payload would otherwise just not
  // appear, with nothing said about it.
  const incoming: SwitchFilePlan[] = []
  const unresolved: SwitchPlan['unresolved'] = []
  // Split by where the bytes are, because that is what decides whether a file
  // sitting at an incoming path belongs to Modão or to the user. An adopted
  // install IS the file in the game folder. A store-backed install is about to
  // put its own copy over whatever is there.
  const adoptedInPlace = new Set<string>()
  const fromStore = new Set<string>()
  const targetRows = installsOf(to.id)
  const targetFiles = filesOfProfile(to.id)
  const filesByInstall = new Map<number, FileRow[]>()
  for (const f of targetFiles) {
    const list = filesByInstall.get(f.install_id)
    if (list) list.push(f)
    else filesByInstall.set(f.install_id, [f])
  }
  for (const row of targetRows) {
    if (!row.enabled) continue
    const files = filesByInstall.get(row.id) ?? []
    const label = labelOf(row, files[0]?.relative_path)
    if (files.length === 0) {
      unresolved.push({ installId: row.id, label, reason: 'no files are recorded for this install' })
      continue
    }
    if (!row.store_key) {
      const live = files.filter((f) => existsUnderAnySpelling(game.path, f.relative_path))
      if (live.length === 0) {
        unresolved.push({
          installId: row.id,
          label,
          reason: 'adopted from the game folder, but its files are no longer there and it was never copied into the store'
        })
        continue
      }
      for (const f of live) {
        adoptedInPlace.add(f.relative_path.toLowerCase())
        incoming.push({
          relativePath: f.relative_path,
          action: 'materialise',
          installId: row.id,
          label,
          reason: 'already in place (adopted); it will be copied into the store on the way out',
          sizeBytes: f.size
        })
      }
      continue
    }
    const src = storeDir(row.store_key)
    const missing = files.filter((f) => !exists(path.join(src, f.relative_path)))
    if (missing.length === files.length) {
      unresolved.push({ installId: row.id, label, reason: `no payload in the store (${row.store_key})` })
      continue
    }
    if (missing.length > 0) {
      unresolved.push({
        installId: row.id,
        label,
        reason: `${missing.length} of ${files.length} file(s) are missing from the store: ${missing
          .slice(0, 3)
          .map((f) => f.relative_path)
          .join(', ')}`
      })
    }
    for (const f of files) {
      if (missing.includes(f)) continue
      fromStore.add(f.relative_path.toLowerCase())
      incoming.push({
        relativePath: f.relative_path,
        action: 'materialise',
        installId: row.id,
        label,
        reason: 'linked from the Modão store',
        sizeBytes: f.size
      })
    }
  }

  // What Modão can account for: the files the outgoing profile put there, and
  // the files an adopted incoming install literally IS. Everything else loose
  // in scripts\ and cleo\ is the user's.
  //
  // The incoming profile's store-backed targets are deliberately NOT in here.
  // Folding them in hid the one case that matters: a file of the user's at a
  // path the incoming profile is about to write. It was filtered out of the
  // report and then destroyed without ever being named.
  const known = new Set([...outgoing.map((p) => p.relativePath.toLowerCase()), ...adoptedInPlace])
  const loose = await unmanagedFiles(game.path, known)
  const displacedFolders = await unmanagedFolderFiles(game.path, known, fromStore)
  const unmanaged = [...loose, ...displacedFolders].sort()
  const willBeOverwritten = [...loose.filter((rel) => fromStore.has(rel.toLowerCase())), ...displacedFolders].sort()

  const priorities: Record<string, number> = {}
  for (const row of targetRows) {
    if (!row.folder_name) continue
    priorities[row.folder_name] = row.enabled ? row.priority : 0
  }

  return {
    fromProfileId: from?.id ?? null,
    fromProfileName: from?.name ?? null,
    toProfileId: to.id,
    toProfileName: to.name,
    outgoing,
    incoming,
    toIngest,
    unresolved,
    unmanaged,
    willBeOverwritten,
    iniPath: path.join(game.path, iniRelativePath()),
    iniPriorities: priorities,
    totalBytes
  }
}

/**
 * Loose plugins in the game folder that no managed install claims. A switch
 * leaves these exactly where they are: they are the user's, Modão did not put
 * them there, and removing them is what destroyed an install once already.
 *
 * The one exception is a path the incoming profile itself writes, which cannot
 * be left in place. Those come back in `willBeOverwritten` as well as here:
 * they are snapshotted with the rest of the switch and copied to quarantine
 * before the mod takes the path, so the file survives either way.
 *
 * This covers loose plugins; `unmanagedFolderFiles` covers a real
 * `modloader\<Folder>\` an incoming junction would take the place of.
 */
async function unmanagedFiles(gamePath: string, known: Set<string>): Promise<string[]> {
  const out: string[] = []
  const game = requireActiveGame()
  const dirs: { dir: string; match: RegExp }[] = [
    { dir: game.asiDirectory ?? gamePath, match: /\.asi$/i },
    { dir: path.join(gamePath, 'cleo'), match: /\.(cleo\d?|cs|cm)$/i }
  ]
  for (const d of dirs) {
    if (!exists(d.dir)) continue
    for (const e of await fsp.readdir(d.dir, { withFileTypes: true })) {
      if (!e.isFile() || !d.match.test(e.name)) continue
      const rel = path.relative(gamePath, path.join(d.dir, e.name)).replace(/\\/g, '/')
      if (known.has(rel.toLowerCase())) continue
      out.push(rel)
    }
  }
  return out.sort()
}

/**
 * The contents of a real `modloader\<Folder>\` that an incoming junction is
 * about to take the place of.
 *
 * A mod folder Modão materialised is a junction, and dropping a junction
 * destroys nothing - the payload is in the store. A REAL directory there is
 * either a folder some managed install claims, in which case `known` holds
 * files inside it, or it is the user's own: built by hand, or left by another
 * tool. That last one is what `createJunction` recursed straight over, because
 * `removeLinkOrDir` is `fsp.rm(recursive, force)`.
 *
 * Reported file by file rather than as one folder, because that is the
 * granularity the snapshot, the journal manifest and the restore all work at -
 * `snapshotFiles` skips a directory outright.
 */
async function unmanagedFolderFiles(gamePath: string, known: Set<string>, fromStore: Set<string>): Promise<string[]> {
  const root = path.join(gamePath, 'modloader')
  if (!exists(root)) return []
  const incomingKeys = [...fromStore]
  const out: string[] = []
  for (const e of await fsp.readdir(root, { withFileTypes: true })) {
    const abs = path.join(root, e.name)
    // A junction is Modão's own and reports as a link, not a directory, on Windows.
    if (!e.isDirectory() || isLink(abs)) continue
    const prefix = `modloader/${e.name.toLowerCase()}/`
    if (!incomingKeys.some((k) => k.startsWith(prefix))) continue
    // Per file, not per folder: a folder holding one tracked file and one file
    // nobody tracks is not a folder Modão owns, and the untracked one is
    // exactly what the junction used to take with it.
    for (const f of await walk(abs)) {
      const rel = path.relative(gamePath, f.abs).replace(/\\/g, '/')
      if (known.has(rel.toLowerCase())) continue
      out.push(rel)
    }
  }
  return out.sort()
}

/**
 * Copies every file of an install that has no store payload into the store,
 * hashing each one, so the game folder can be vacated without the content
 * existing in exactly one place. Hardlinks where the volume allows it, so a
 * 6 GB adopted install costs no extra disk.
 *
 * Returns what could not be ingested; the caller must refuse to remove those.
 */
export async function ingestUnstoredInstalls(
  profileId: number,
  gamePath: string,
  onProgress?: (done: number, total: number, label: string) => void
): Promise<{ ingested: number; files: number; failed: { installId: number; label: string; reason: string }[] }> {
  const db = getDb()
  const rows = installsOf(profileId).filter((r) => !r.store_key)
  const failed: { installId: number; label: string; reason: string }[] = []
  let ingested = 0
  let files = 0
  let done = 0

  for (const row of rows) {
    const rels = db
      .prepare('SELECT relative_path, size FROM install_file WHERE install_id = ? ORDER BY relative_path')
      .all(row.id) as { relative_path: string; size: number }[]
    const label = labelOf(row, rels[0]?.relative_path)
    onProgress?.(++done, rows.length, label)
    if (rels.length === 0) {
      failed.push({ installId: row.id, label, reason: 'no files are recorded for this install' })
      continue
    }
    const slug = (
      db
        .prepare('SELECT m.slug FROM mod_version mv JOIN mod m ON m.id = mv.mod_id JOIN install i ON i.mod_version_id = mv.id WHERE i.id = ?')
        .get(row.id) as { slug: string } | undefined
    )?.slug
    // The key includes the install id: two profiles can each have adopted a
    // differently-edited copy of the same mod, and they must not share one slot.
    const key = storeKey(slug ?? `install-${row.id}`, 'adopted', String(row.id))
    const dest = storeDir(key)
    let copied = 0
    const absent: string[] = []
    for (const r of rels) {
      // Read through whatever spelling the folder wears: a mod the user has
      // switched off sits at "modloader\. <name>\...", and an adopted one that
      // was never copied into the store is the single most irreplaceable thing
      // in the game folder. Ingesting it is what makes it survivable at all.
      const from = resolveSpelledPath(gamePath, r.relative_path)
      if (!from) {
        absent.push(r.relative_path)
        continue
      }
      const to = path.join(dest, r.relative_path)
      await fsp.mkdir(path.dirname(to), { recursive: true })
      if (isDirectory(from)) await copyRecursive(from, to)
      else if (!exists(to)) await linkOrCopyFile(from, to)
      const sha = await sha256File(to)
      const size = (await fsp.stat(to)).size
      db.prepare('UPDATE install_file SET sha256 = ?, size = ? WHERE install_id = ? AND relative_path = ?').run(
        sha,
        size,
        row.id,
        r.relative_path
      )
      copied++
      files++
    }
    if (copied === 0) {
      failed.push({ installId: row.id, label, reason: `none of its ${rels.length} file(s) are in the game folder any more` })
      continue
    }
    if (absent.length) {
      failed.push({
        installId: row.id,
        label,
        reason: `${absent.length} file(s) were already gone from the game folder: ${absent.slice(0, 3).join(', ')}`
      })
    }
    db.prepare('UPDATE install SET store_key = ? WHERE id = ?').run(key, row.id)
    ingested++
  }
  return { ingested, files, failed }
}

/**
 * Copies the given game-relative files into a snapshot directory and verifies
 * every copy by hash. Throws if a single file does not verify - the caller then
 * abandons the switch with the game folder untouched.
 */
export async function snapshotFiles(gamePath: string, relativePaths: string[], destDir: string): Promise<SnapshotEntry[]> {
  await fsp.mkdir(destDir, { recursive: true })
  const entries: SnapshotEntry[] = []
  for (const rel of relativePaths) {
    const from = path.join(gamePath, rel)
    if (!exists(from) || isDirectory(from)) continue
    const to = path.join(destDir, rel)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
    const source = await sha256File(from)
    const copy = await sha256File(to)
    if (source !== copy) {
      throw new Error(
        `The backup copy of ${rel} does not match the file it was taken from (${source.slice(0, 12)} vs ${copy.slice(0, 12)}). ` +
          'The switch was abandoned; nothing in the game folder was touched.'
      )
    }
    entries.push({ relativePath: rel, backupPath: to, sha256: copy, size: (await fsp.stat(to)).size })
  }
  return entries
}

/** Re-reads a snapshot and confirms it still holds what it claims. */
export async function verifySnapshot(entries: SnapshotEntry[]): Promise<{ ok: boolean; checked: number; problems: string[] }> {
  const problems: string[] = []
  for (const e of entries) {
    if (!exists(e.backupPath)) {
      problems.push(`${e.relativePath}: the backup copy is missing from ${e.backupPath}`)
      continue
    }
    const sha = await sha256File(e.backupPath)
    if (sha !== e.sha256) problems.push(`${e.relativePath}: the backup copy changed after it was written`)
  }
  return { ok: problems.length === 0, checked: entries.length, problems }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * Opens a journal row. `kind` says which operation is writing it, and is the
 * ONLY thing that separates a profile switch from a variant swap afterwards -
 * they reach the same states, keep the same columns, and a variant swap is
 * routinely the newest row. Everything that reads the table back asks for the
 * kind it means.
 */
export function openJournal(
  fromProfileId: number | null,
  toProfileId: number,
  kind: SwitchJournalKind = 'profile-switch'
): { id: number; snapshotDir: string } {
  const startedAt = new Date().toISOString()
  const id = Number(
    getDb()
      .prepare(
        `INSERT INTO switch_journal (started_at, from_profile_id, to_profile_id, state, snapshot_dir, kind)
         VALUES (?,?,?,'snapshotted','',?)`
      )
      .run(startedAt, fromProfileId, toProfileId, kind).lastInsertRowid
  )
  const snapshotDir = path.join(
    Paths.profileBackups(fromProfileId ?? toProfileId),
    `switch-${String(id).padStart(4, '0')}-${startedAt.replace(/[:.]/g, '-')}`
  )
  getDb().prepare('UPDATE switch_journal SET snapshot_dir = ? WHERE id = ?').run(snapshotDir, id)
  return { id, snapshotDir }
}

export function recordManifest(journalId: number, entries: SnapshotEntry[]): void {
  getDb().prepare('UPDATE switch_journal SET manifest_json = ? WHERE id = ?').run(JSON.stringify(entries), journalId)
}

export function setJournalState(journalId: number, state: SwitchState, error?: string | null): void {
  getDb()
    .prepare('UPDATE switch_journal SET state = ?, error = ?, completed_at = ? WHERE id = ?')
    .run(state, error ?? null, state === 'snapshotted' ? null : new Date().toISOString(), journalId)
}

export function recordVerification(journalId: number, verification: SwitchVerification): void {
  getDb().prepare('UPDATE switch_journal SET verification_json = ? WHERE id = ?').run(JSON.stringify(verification), journalId)
}

function rowToJournal(r: {
  id: number
  started_at: string
  completed_at: string | null
  from_profile_id: number | null
  to_profile_id: number
  state: string
  snapshot_dir: string
  manifest_json: string
  verification_json: string | null
  error: string | null
  restored_at: string | null
  kind?: string | null
  variant_swap_json?: string | null
}): SwitchJournal {
  return {
    id: r.id,
    kind: journalKindOf(r),
    startedAt: r.started_at,
    completedAt: r.completed_at,
    fromProfileId: r.from_profile_id,
    toProfileId: r.to_profile_id,
    state: r.state as SwitchState,
    snapshotDir: r.snapshot_dir,
    manifest: JSON.parse(r.manifest_json || '[]') as SnapshotEntry[],
    verification: r.verification_json ? (JSON.parse(r.verification_json) as SwitchVerification) : null,
    error: r.error,
    restoredAt: r.restored_at
  }
}

/**
 * Recent journal rows, newest first. Pass `kind` to get one operation's rows
 * only - anything that presents a row to the user as a switch, or acts on one
 * as a switch, must pass 'profile-switch'.
 */
export function listJournals(limit = 20, kind?: SwitchJournalKind): SwitchJournal[] {
  const rows = getDb().prepare('SELECT * FROM switch_journal ORDER BY id DESC LIMIT ?').all(limit) as Parameters<
    typeof rowToJournal
  >[0][]
  const journals = rows.map(rowToJournal)
  return kind ? journals.filter((j) => j.kind === kind) : journals
}

/**
 * The most recent PROFILE SWITCH that still has a snapshot to roll back to.
 *
 * The kind filter is the whole point of this query. A variant swap lands in
 * the same table with the same terminal states and a NULL `restored_at`, and
 * it is usually the newest row - the user adjusts a variant long after they
 * last changed profile. Without the filter, "Restore previous state" picked
 * one up, vacated the entire active profile, and dropped a couple of variant
 * files into the game root in its place while reporting success.
 *
 * The SQL already excludes them; `isRestorableProfileSwitch` re-checks each
 * candidate through the same pure rule, so a row that somehow arrives with no
 * `kind` (one written by a build older than schema 12, say) is still read as a
 * variant swap when it carries a variant-swap payload.
 */
export function lastRestorableSwitch(): SwitchJournal | null {
  const rows = getDb()
    .prepare(
      `SELECT * FROM switch_journal
        WHERE state IN ('applied','verified','failed')
          AND restored_at IS NULL
          AND COALESCE(kind, CASE WHEN variant_swap_json IS NOT NULL THEN 'variant-swap' ELSE 'profile-switch' END)
              = 'profile-switch'
        ORDER BY id DESC LIMIT 25`
    )
    .all() as Parameters<typeof rowToJournal>[0][]
  return rows.map(rowToJournal).find(isRestorableProfileSwitch) ?? null
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

async function countFiles(dir: string, match: RegExp): Promise<number> {
  if (!exists(dir)) return 0
  const entries = await fsp.readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isFile() && match.test(e.name)).length
}

/**
 * The switch is not "done" because no exception was thrown. It is done when the
 * game folder actually holds what the profile says it holds - every mod
 * materialised, the plugin counts as expected, and a modloader.ini that parses
 * and names exactly this profile's mods.
 *
 * Anything that says otherwise lands in `blockingProblems`, and `activateProfile`
 * refuses the switch on it: a mod that did not arrive used to be reported in a
 * log the user never read, while the profile was already recorded active.
 */
export async function verifySwitch(profileId: number): Promise<SwitchVerification> {
  const db = getDb()
  const game = requireActiveGame()
  const profile = db.prepare('SELECT name FROM profile WHERE id = ?').get(profileId) as { name: string }
  const rows = installsOf(profileId).filter((r) => r.enabled)
  const missingMods: SwitchVerification['missingMods'] = []
  let materialised = 0

  for (const row of rows) {
    const files = db.prepare('SELECT relative_path FROM install_file WHERE install_id = ?').all(row.id) as {
      relative_path: string
    }[]
    const label = labelOf(row, files[0]?.relative_path)
    if (files.length === 0) {
      missingMods.push({ installId: row.id, label, reason: 'no files are recorded for this install' })
      continue
    }
    const present = files.filter((f) => existsUnderAnySpelling(game.path, f.relative_path)).length
    if (present === 0) {
      missingMods.push({ installId: row.id, label, reason: 'not one of its files is in the game folder' })
      continue
    }
    if (present < files.length) {
      missingMods.push({
        installId: row.id,
        label,
        reason: `only ${present} of ${files.length} file(s) reached the game folder`
      })
      continue
    }
    materialised++
  }

  const { readIniFile, readPriorities } = await import('../game/modloaderIni')
  const { iniProfileName } = await import('./materialize')
  const iniPath = path.join(game.path, iniRelativePath())
  let iniParsed = false
  let iniMissingKeys: string[] = []
  let iniStaleKeys: string[] = []
  try {
    const ini = await readIniFile(iniPath)
    const written = readPriorities(ini, iniProfileName(profile.name))
    iniParsed = true
    // Compared under the name the folder actually has in modloader\: a mod that
    // is switched off is spelled ". <name>" and one set to load first "$<name>",
    // and that is the key `syncProfileIni` writes, because it is the key Mod
    // Loader matches. Comparing canonical names here would report every one of
    // them as a line naming a mod the profile does not have, and block the
    // switch on a rename.
    const spelled = (r: { folder_name: string | null; enabled: number; load_first: number }): string =>
      spellFolderName(r.folder_name!, { enabled: !!r.enabled, loadFirst: !!r.load_first })
    const expected = new Set(rows.filter((r) => r.folder_name).map(spelled))
    const all = installsOf(profileId).filter((r) => r.folder_name)
    const knownToProfile = new Set(all.map(spelled))
    iniMissingKeys = [...expected].filter((k) => !(k in written))
    iniStaleKeys = Object.keys(written).filter((k) => !knownToProfile.has(k))
  } catch (e) {
    iniParsed = false
    iniMissingKeys = [`modloader.ini could not be parsed: ${(e as Error).message}`]
  }

  const asiDir = game.asiDirectory ?? game.path
  const asiCount = await countFiles(asiDir, /\.asi$/i)
  const cleoDir = path.join(game.path, 'cleo')
  const cleoPluginCount = await countFiles(cleoDir, /\.cleo\d?$/i)
  const cleoScriptCount = await countFiles(cleoDir, /\.(cs|cm)$/i)

  const unresolvedDependencies = await unresolvedDeps(profileId)

  // Blocking: the game folder does not hold what the profile says it holds.
  // Every one of these is a mod the user would have gone looking for in-game.
  const blockingProblems: string[] = []
  if (missingMods.length) {
    blockingProblems.push(
      `${missingMods.length} mod(s) in this profile did not reach the game folder: ` +
        missingMods
          .slice(0, 5)
          .map((m) => `${m.label} (${m.reason})`)
          .join('; ')
    )
  }
  if (!iniParsed) blockingProblems.push('modloader.ini could not be read back after the switch.')
  if (iniMissingKeys.length && iniParsed) {
    blockingProblems.push(`modloader.ini is missing a priority line for: ${iniMissingKeys.slice(0, 5).join(', ')}`)
  }
  if (iniStaleKeys.length) {
    blockingProblems.push(
      `modloader.ini still names mod(s) this profile does not have: ${iniStaleKeys.slice(0, 5).join(', ')}`
    )
  }

  // Advisory: these are about mods that ARE in place, so they are reported and
  // never block. A missing dependency is the user's to resolve, not a failed
  // materialisation.
  const problems = [...blockingProblems]
  if (unresolvedDependencies.length) {
    problems.push(`${unresolvedDependencies.length} unresolved dependency/dependencies.`)
  }

  return {
    ok: problems.length === 0,
    profileId,
    profileName: profile.name,
    modsExpected: rows.length,
    modsMaterialised: materialised,
    missingMods,
    asiCount,
    cleoPluginCount,
    cleoScriptCount,
    iniParsed,
    iniPath,
    iniMissingKeys,
    iniStaleKeys,
    unresolvedDependencies,
    problems,
    blockingProblems,
    checkedAt: new Date().toISOString()
  }
}

async function unresolvedDeps(profileId: number): Promise<string[]> {
  const { profileDependencyProblems } = await import('../deps/resolver')
  return profileDependencyProblems(profileId, requireActiveGame()).map(
    (n) => `${n.title}${n.kind === 'conflicts' ? ' (conflict)' : ''}${n.note ? ` - ${n.note}` : ''}`
  )
}

/**
 * Puts the game folder back exactly as the snapshot found it: every file in the
 * manifest is copied back and re-hashed, and anything Modão linked in after
 * the snapshot is removed first. Used by "Restore previous state".
 *
 * `baseDir` is where the manifest's relative paths are restored under. A
 * profile switch's manifest is game-relative, so it defaults to the active
 * game folder. A variant swap's manifest is store-relative instead - a
 * junctioned mod folder is a live view of the store, so putting the store
 * back is what puts the junction back too, without the game even needing to
 * be open - so a caller recovering one of those passes its store directory
 * explicitly and never pays for `requireActiveGame()`.
 */
export async function restoreFromJournal(
  journalId: number,
  opts: { removeFirst?: string[]; baseDir?: string } = {}
): Promise<{ restored: number; problems: string[] }> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM switch_journal WHERE id = ?').get(journalId) as
    | Parameters<typeof rowToJournal>[0]
    | undefined
  if (!row) throw new Error(`Switch #${journalId} is not in the journal.`)
  const journal = rowToJournal(row)
  const baseDir = opts.baseDir ?? requireActiveGame().path
  const problems: string[] = []

  for (const rel of opts.removeFirst ?? []) {
    const abs = path.join(baseDir, rel)
    if (isLink(abs)) await fsp.rm(abs, { recursive: true, force: true }).catch(() => undefined)
  }

  let restored = 0
  for (const entry of journal.manifest) {
    if (!exists(entry.backupPath)) {
      problems.push(`${entry.relativePath}: the backup copy is gone; it was not restored`)
      continue
    }
    const sha = await sha256File(entry.backupPath)
    if (sha !== entry.sha256) {
      problems.push(`${entry.relativePath}: the backup copy no longer matches its recorded hash; it was not restored`)
      continue
    }
    const to = path.join(baseDir, entry.relativePath)
    await fsp.mkdir(path.dirname(to), { recursive: true })
    if (isLink(to)) await fsp.rm(to, { recursive: true, force: true }).catch(() => undefined)
    await fsp.copyFile(entry.backupPath, to)
    restored++
  }

  db.prepare("UPDATE switch_journal SET state = 'restored', restored_at = ? WHERE id = ?").run(new Date().toISOString(), journalId)
  return { restored, problems }
}

export interface ForgottenInstall {
  installId: number
  label: string
  /** The paths that are gone, so the user can see what they are losing. */
  files: string[]
}

/**
 * Drops installs whose payload no longer exists anywhere.
 *
 * A profile can end up holding mods that are gone: adopted from the game folder
 * before the app copied anything into its store, then deleted from that folder.
 * Nothing can materialise them, so the switch refuses to run - correctly, but
 * it leaves the user with a profile they cannot open at all.
 *
 * This forgets those entries and nothing else. A mod with files still in the
 * game folder, or a payload in the store, is never touched, and no file is
 * removed from disk: the rows go, the disk does not change.
 */
export function forgetMissingInstalls(profileId: number): ForgottenInstall[] {
  const db = getDb()
  const game = requireActiveGame()
  const forgotten: ForgottenInstall[] = []

  for (const row of installsOf(profileId)) {
    const files = db.prepare('SELECT relative_path FROM install_file WHERE install_id = ?').all(row.id) as {
      relative_path: string
    }[]
    const anyLive = files.some((f) => existsUnderAnySpelling(game.path, f.relative_path))
    const hasPayload = row.store_key
      ? files.some((f) => exists(path.join(storeDir(row.store_key as string), f.relative_path)))
      : false
    if (anyLive || hasPayload) continue

    forgotten.push({
      installId: row.id,
      label: labelOf(row, files[0]?.relative_path),
      files: files.map((f) => f.relative_path)
    })
    db.transaction(() => {
      db.prepare('DELETE FROM provides WHERE install_id = ?').run(row.id)
      db.prepare('DELETE FROM install_file WHERE install_id = ?').run(row.id)
      db.prepare('DELETE FROM submod_state WHERE install_id = ?').run(row.id)
      db.prepare('DELETE FROM install WHERE id = ?').run(row.id)
    })()
  }
  return forgotten
}
