import path from 'node:path'
import fsp from 'node:fs/promises'
import type { ExistingSavesReport, SaveSlot, SaveSnapshot } from '@shared/types'
import { getDb, getSetting, setSetting } from '../db'
import { Paths } from '../util/paths'
import { activeGame } from '../game/detect'
import { gameDefinition } from '@shared/games'
import {
  copyRecursive,
  dirSize,
  exists,
  isDirectory,
  moveSafe,
  sha256File,
  sha256Text,
  timestampSlug,
  walk
} from '../util/fsx'

const MAX_AUTO_SNAPSHOTS = 10

/** Where the marker for every already-imported live save folder is recorded. */
const IMPORTED_FROM_KEY = 'saves.importedFrom'
/** The settings file the game writes next to the slots; imported with them. */
const SETTINGS_FILE = 'gta_sa.set'

/**
 * Save games live outside the game folder, in the per-game folder under
 * Documents - "GTA San Andreas User Files", "GTA3 User Files", and so on. Each
 * profile keeps its own copy; on a switch the current one is moved aside into
 * the outgoing profile's store and the incoming profile's saves take its place.
 * Nothing is ever deleted.
 */
export function liveSavesDir(): string {
  return Paths.userFiles(activeGame()?.kind ?? 'sa')
}

/** The save slot files of the game currently selected. */
function slotPattern(): RegExp {
  return gameDefinition(activeGame()?.kind ?? 'sa').saveSlotPattern
}

export function profileSavesDir(profileId: number): string {
  return Paths.profileSaves(profileId)
}

export async function readSlots(dir: string): Promise<SaveSlot[]> {
  if (!exists(dir)) return []
  const files = await walk(dir)
  return files
    .filter((f) => slotPattern().test(path.basename(f.rel)))
    .map((f) => ({
      file: path.basename(f.rel),
      index: Number.parseInt(/(\d)/.exec(path.basename(f.rel))?.[1] ?? '0', 10),
      size: f.size,
      modifiedAt: new Date(f.mtimeMs).toISOString()
    }))
    .sort((a, b) => a.index - b.index)
}

export async function snapshot(profileId: number, label: string, auto = true): Promise<SaveSnapshot> {
  const src = liveSavesDir()
  const dest = path.join(Paths.profileSnapshots(profileId), `${timestampSlug()}${auto ? '-auto' : ''}`)
  await fsp.mkdir(dest, { recursive: true })
  if (exists(src)) await copyRecursive(src, dest)
  const size = await dirSize(dest)
  const db = getDb()
  const info = db
    .prepare('INSERT INTO save_snapshot (profile_id, taken_at, path, label, size, auto) VALUES (?,?,?,?,?,?)')
    .run(profileId, new Date().toISOString(), dest, label, size, auto ? 1 : 0)
  if (auto) await pruneAuto(profileId)
  const row = db.prepare('SELECT * FROM save_snapshot WHERE id = ?').get(Number(info.lastInsertRowid)) as SnapshotRow
  return toSnapshot(row, await readSlots(dest))
}

interface SnapshotRow {
  id: number
  profile_id: number
  taken_at: string
  path: string
  label: string
  size: number
  auto: number
}

function toSnapshot(row: SnapshotRow, slots: SaveSlot[]): SaveSnapshot {
  return {
    id: row.id,
    profileId: row.profile_id,
    takenAt: row.taken_at,
    path: row.path,
    label: row.label,
    size: row.size,
    auto: !!row.auto,
    slots
  }
}

/** Keeps the last 10 automatic snapshots per profile; manual ones are kept forever. */
async function pruneAuto(profileId: number): Promise<void> {
  const db = getDb()
  const rows = db
    .prepare('SELECT * FROM save_snapshot WHERE profile_id = ? AND auto = 1 ORDER BY taken_at DESC')
    .all(profileId) as SnapshotRow[]
  for (const old of rows.slice(MAX_AUTO_SNAPSHOTS)) {
    // Move to quarantine rather than deleting - saves are irreplaceable.
    const q = path.join(Paths.quarantine(), 'save-snapshots', String(profileId), path.basename(old.path))
    await moveSafe(old.path, q).catch(() => undefined)
    db.prepare('UPDATE save_snapshot SET path = ? WHERE id = ?').run(q, old.id)
  }
}

export async function listSnapshots(profileId: number): Promise<SaveSnapshot[]> {
  const rows = getDb()
    .prepare('SELECT * FROM save_snapshot WHERE profile_id = ? ORDER BY taken_at DESC')
    .all(profileId) as SnapshotRow[]
  const out: SaveSnapshot[] = []
  for (const r of rows) out.push(toSnapshot(r, await readSlots(r.path)))
  return out
}

export async function restoreSnapshot(snapshotId: number): Promise<void> {
  const db = getDb()
  const row = db.prepare('SELECT * FROM save_snapshot WHERE id = ?').get(snapshotId) as SnapshotRow | undefined
  if (!row) throw new Error('That snapshot no longer exists.')
  // A row can outlive its folder: quarantine is a user-visible directory they may
  // have moved or emptied. Say so instead of failing with a raw ENOENT mid-copy.
  if (!exists(row.path)) {
    throw new Error(`The files for snapshot "${row.label}" are no longer at ${row.path}. Nothing was changed.`)
  }
  // Snapshot what is there now before replacing it, so a restore is itself undoable.
  await snapshot(row.profile_id, 'before restore', true)
  const live = liveSavesDir()
  await fsp.mkdir(live, { recursive: true })
  await copyRecursive(row.path, live)
  await copyRecursive(row.path, profileSavesDir(row.profile_id))
}

// ---------------------------------------------------------------------------
// Saves that were already on the machine before Modão
// ---------------------------------------------------------------------------

interface SaveImportRecord {
  /** Content marker of the live folder at the moment it was imported. */
  marker: string
  profileId: number
  snapshotId: number
  importedAt: string
  slots: number
}

function importRecords(): SaveImportRecord[] {
  const raw = getSetting(IMPORTED_FROM_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as SaveImportRecord[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function rememberImport(record: SaveImportRecord): void {
  setSetting(IMPORTED_FROM_KEY, JSON.stringify([...importRecords(), record]))
}

/**
 * Identifies a set of save files by content rather than by location. The live
 * folder belongs to the user: it can be played, emptied, restored from a backup
 * or replaced behind our back, so "have these already been imported?" cannot be
 * answered by the folder being empty. Null when there is nothing to import.
 */
async function savesMarker(dir: string): Promise<string | null> {
  if (!exists(dir)) return null
  const files = (await walk(dir)).filter(
    (f) => /^GTASAsf\d\.b$/i.test(path.basename(f.rel)) || path.basename(f.rel).toLowerCase() === SETTINGS_FILE
  )
  if (files.length === 0) return null
  const lines: string[] = []
  for (const f of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    lines.push(`${f.rel.toLowerCase()}:${f.size}:${await sha256File(f.abs)}`)
  }
  return sha256Text(lines.join('|'))
}

export interface DetectedSaves extends ExistingSavesReport {
  /** Content marker used to recognise a folder that was already imported. */
  marker: string | null
}

/**
 * Reads the live user-files folder without touching a byte of it. Called before
 * adoption and before every profile switch, so saves that predate Modão are
 * never carried into a profile that did not create them.
 */
export async function detectExistingSaves(): Promise<DetectedSaves> {
  const dir = liveSavesDir()
  const slots = await readSlots(dir)
  const hasSettings = exists(path.join(dir, SETTINGS_FILE))
  const marker = await savesMarker(dir)
  const record = marker ? importRecords().filter((r) => r.marker === marker).pop() : undefined
  return {
    found: slots.length > 0 || hasSettings,
    path: dir,
    slots,
    sizeBytes: exists(dir) ? await dirSize(dir) : 0,
    importedIntoProfileId: record?.profileId ?? null,
    hasSettings,
    marker
  }
}

/**
 * Copies - never moves - the live save folder into a profile and takes a manual
 * (non-auto, never pruned) snapshot of it. The user's own folder is left exactly
 * as it was, and the state they arrived with stays recoverable forever.
 */
export async function importExistingSaves(profileId: number, label: string): Promise<{ snapshotId: number; slots: number }> {
  const detected = await detectExistingSaves()
  if (!detected.found) throw new Error(`There are no save games in ${detected.path} to import.`)
  await copyRecursive(liveSavesDir(), profileSavesDir(profileId))
  const snap = await snapshot(profileId, label, false)
  if (detected.marker) {
    rememberImport({
      marker: detected.marker,
      profileId,
      snapshotId: snap.id,
      importedAt: snap.takenAt,
      slots: snap.slots.length
    })
  }
  return { snapshotId: snap.id, slots: snap.slots.length }
}

export interface SwapResult {
  movedOut: number
  movedIn: number
  snapshotId: number | null
  /** Set when saves belonging to no profile were rescued before the swap. */
  rescuedSnapshotId: number | null
}

/**
 * Swaps the live save folder from one profile to another. Both sides are
 * preserved: saves that belong to no profile are copied into one first, the
 * outgoing profile's previous copy moves to quarantine instead of being
 * deleted, and nothing leaves the live folder before it exists elsewhere.
 */
export async function swapSaves(fromProfileId: number | null, toProfileId: number): Promise<SwapResult> {
  const live = liveSavesDir()
  let snapshotId: number | null = null
  let rescuedSnapshotId: number | null = null
  let movedOut = 0
  let movedIn = 0

  // Unclaimed saves exist in exactly one place on the machine. They are copied
  // into a profile before anything is moved, and that rescue ignores the
  // automatic-snapshot setting because there is no other copy to fall back on.
  const detected = await detectExistingSaves()
  if (detected.found && detected.importedIntoProfileId === null) {
    const owner = fromProfileId ?? toProfileId
    const rescued = await importExistingSaves(owner, 'Found in your save folder, not yet in a profile')
    rescuedSnapshotId = rescued.snapshotId
  }

  if (fromProfileId !== null && exists(live)) {
    if (getSetting('saves.autoSnapshot', '1') === '1') {
      const snap = await snapshot(fromProfileId, 'automatic - profile switch', true)
      snapshotId = snap.id
    }
    const store = profileSavesDir(fromProfileId)
    // The outgoing profile's previous copy is replaced by the live folder. It
    // moves to quarantine first: no file is removed before it exists elsewhere.
    if ((await walk(store)).length) {
      await moveSafe(store, path.join(Paths.quarantine(), 'profile-saves', String(fromProfileId), timestampSlug()))
    }
    await fsp.rm(store, { recursive: true, force: true })
    await moveSafe(live, store)
    movedOut = (await walk(store)).length
  }

  const incoming = profileSavesDir(toProfileId)
  await fsp.mkdir(incoming, { recursive: true })
  if (exists(live) && isDirectory(live)) {
    // Nothing owned the live folder (first run): keep it as the incoming profile's saves.
    const files = await walk(live)
    if (files.length) {
      // Copied into the incoming profile before the live folder is cleared.
      await copyRecursive(live, incoming)
      movedIn = files.length
    }
    await fsp.rm(live, { recursive: true, force: true })
  }
  await fsp.mkdir(live, { recursive: true })
  await copyRecursive(incoming, live)
  movedIn = (await walk(live)).length
  return { movedOut, movedIn, snapshotId, rescuedSnapshotId }
}

/** Reads the live folder as a pseudo-snapshot so the Saves screen can show current slots. */
export async function currentSlots(profileId: number): Promise<SaveSnapshot | null> {
  const live = liveSavesDir()
  if (!exists(live)) return null
  return {
    id: -1,
    profileId,
    takenAt: new Date().toISOString(),
    path: live,
    label: 'Live save folder',
    size: await dirSize(live),
    auto: false,
    slots: await readSlots(live)
  }
}
