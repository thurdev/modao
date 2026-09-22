import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import type {
  DestinationClass,
  GameInstall,
  InstallPlan,
  PlanWarning,
  PlannedFile,
  ReadmeParse
} from '@shared/types'
import { getDb } from '../db'
import { Paths } from '../util/paths'
import { exists, sha256File, slugify, walk } from '../util/fsx'
import { archiveOrDirectory, effectiveRoot } from './archive'
import { findReadmes, parseReadme } from './readme'
import { classifyTree, type OverlayMatch } from './classify'
import { providesKey } from '../conflicts'
import { resolveDependencies } from '../deps/resolver'
import {
  knownAbout,
  layoutDisagreement,
  learnFromBinary,
  learnFromReadme,
  learnLayout,
  signatureForArchive
} from '../knowledge/learn'
import { t } from '../util/i18n'
import { dematerialise, ingest, materialise, ownedKey, quarantineEdited, storeKey } from '../store/contentStore'
import { requireActiveGame } from '../game/detect'
import { syncProfileIni } from '../profiles/materialize'

interface PlanState {
  plan: InstallPlan
  extractRoot: string
  stagingDir: string
  selections: Record<string, string>
  overrides: Record<string, DestinationClass>
  readmes: ReadmeParse[]
  profileId: number
  docs: string[]
  game: GameInstall
}

const PLANS = new Map<string, PlanState>()

export interface CreatePlanInput {
  archivePath: string
  profileId: number
  modId: number | null
  modVersionId: number | null
  title: string
  author: string
  sourceUrl: string | null
  onProgress?: (phase: string, current: number, total: number) => void
  signal?: AbortSignal
}

export async function createPlan(input: CreatePlanInput): Promise<InstallPlan> {
  const game = requireActiveGame()
  const planId = crypto.randomUUID()
  const stagingDir = path.join(Paths.staging(), planId)

  input.onProgress?.('extract', 0, 100)
  const extractedTo = await archiveOrDirectory(input.archivePath, stagingDir, {
    signal: input.signal,
    onProgress: (p) => input.onProgress?.('extract', Math.max(p, 0), 100)
  })
  const extractRoot = await effectiveRoot(extractedTo)

  input.onProgress?.('readme', 0, 1)
  const readmeFiles = await findReadmes(extractRoot)
  const readmes: ReadmeParse[] = []
  for (const f of readmeFiles.slice(0, 6)) readmes.push(await parseReadme(f))

  const state: PlanState = {
    plan: {} as InstallPlan,
    extractRoot,
    stagingDir,
    selections: {},
    overrides: {},
    readmes,
    profileId: input.profileId,
    docs: [],
    game
  }
  PLANS.set(planId, state)

  const plan = await buildPlan(planId, {
    planId,
    modId: input.modId,
    modVersionId: input.modVersionId,
    title: input.title,
    author: input.author,
    sourceUrl: input.sourceUrl,
    archivePath: input.archivePath,
    onProgress: input.onProgress
  })
  return plan
}

interface BuildMeta {
  planId: string
  modId: number | null
  modVersionId: number | null
  title: string
  author: string
  sourceUrl: string | null
  archivePath: string
  onProgress?: (phase: string, current: number, total: number) => void
}

async function buildPlan(planId: string, meta: BuildMeta): Promise<InstallPlan> {
  const state = PLANS.get(planId)
  if (!state) throw new Error('This install plan has expired. Start the install again.')
  const { game, extractRoot, readmes, profileId } = state

  const asiRelative = game.asiDirectory ? path.relative(game.path, game.asiDirectory).replace(/\\/g, '/') : ''
  const fallbackName = sanitizeFolderName(meta.title)

  meta.onProgress?.('classify', 0, 1)
  const classified = await classifyTree(
    extractRoot,
    {
      asiRelative,
      readmes,
      fallbackName,
      findOverlayTarget: (rel, base) => findOverlay(profileId, rel, base)
    },
    state.selections
  )

  const files = classified.files.map((f) =>
    state.overrides[f.sourcePath] ? retarget(f, state.overrides[f.sourcePath], asiRelative, fallbackName) : f
  )

  meta.onProgress?.('hash', 0, files.length)
  let hashed = 0
  for (const f of files) {
    const abs = path.join(extractRoot, f.sourcePath)
    f.sha256 = await sha256File(abs).catch(() => '')
    meta.onProgress?.('hash', ++hashed, files.length)
  }

  const warnings: PlanWarning[] = [...classified.warnings]
  annotateOverwrites(profileId, game, files, warnings)
  await annotateTextures(extractRoot, files, warnings)

  const dependencies = meta.modId ? resolveDependencies({ modId: meta.modId, profileId, game }) : []

  // What the author wrote, and what the plugin itself asks for at runtime, are
  // better evidence than a curated list that only covers catalogued mods. Both
  // are checked against what this profile actually has.
  const stated = await statedRequirements(extractRoot, readmes)
  const missingRequirements: InstallPlan['missingRequirements'] = []
  for (const req of stated) {
    if (satisfiedInProfile(profileId, game, req.name)) continue
    if (req.kind === 'conflicts') {
      warnings.push({
        severity: 'warn',
        code: 'dependency-conflict-stated',
        message: t('messages.installDeps.statedConflict', { title: req.name }),
        detail: req.line
      })
      continue
    }
    missingRequirements.push({
      name: req.name,
      url: req.url,
      evidence: req.line,
      // One the app can find in the catalogue can be installed from the plan
      // itself; one that is only a link opens the author's page.
      catalogSlug: catalogSlugFor(req.name)
    })
    warnings.push({
      severity: 'warn',
      code: 'dependency-missing',
      message: t('messages.installDeps.missingRequirement', { title: req.name }),
      detail: `${req.line}${req.url ? ` (${req.url})` : ''}`
    })
  }
  for (const d of dependencies) {
    if (d.resolution === 'blocking') {
      warnings.push({ severity: 'error', code: 'dependency-conflict', message: d.note ?? `${d.title} must not be installed alongside this mod.` })
    } else if (d.resolution === 'missing') {
      // A dependency satisfied in ANOTHER profile counts for nothing - the game
      // only loads what is materialised now. But a missing one is a warning
      // with a way to fix it, not a locked door: the app can be wrong about
      // what a requirement even is, and being unable to install because of
      // that is worse than installing something that needs one more mod.
      warnings.push({
        severity: 'warn',
        code: 'dependency-missing',
        message: t('messages.installDeps.missingRequirement', { title: d.title }),
        detail:
          (d.note ? `${d.note} ` : '') +
          t('messages.installDeps.missingRequirementDetail', { profile: profileName(profileId) })
      })
    }
  }
  // What this archive is, and what the app already knows about archives like it.
  const archiveFiles = (await walk(extractRoot)).map((f) => f.rel)
  const signature = signatureForArchive(archiveFiles, readmes[0]?.raw ?? null)
  learnFromReadme(signature, readmes)
  for (const file of archiveFiles) {
    if (!/\.asi$/i.test(file)) continue
    const buf = await fsp.readFile(path.join(extractRoot, file)).catch(() => null)
    if (!buf) continue
    const { pluginEvidence } = await import('../formats/strings')
    const evidence = pluginEvidence(buf)
    learnFromBinary(signature, path.basename(file), evidence.probes, evidence.rootFolder)
  }
  const known = knownAbout(signature)
  const disagreement = layoutDisagreement(known.layout, files)
  if (disagreement) warnings.push(disagreement)

  if (readmes.length === 0) {
    warnings.push({ severity: 'info', code: 'no-readme', message: 'This archive ships no readme; the plan comes from file inspection alone.' })
  }

  const plan: InstallPlan = {
    planId,
    modId: meta.modId,
    modVersionId: meta.modVersionId,
    title: meta.title,
    author: meta.author,
    sourceUrl: meta.sourceUrl,
    archivePath: meta.archivePath,
    extractRoot,
    readmes,
    variants: classified.variants,
    files,
    dependencies,
    missingRequirements,
    warnings,
    totalSize: files.reduce((a, f) => a + f.size, 0),
    requiresVariantChoice: classified.variants.some((v) => !state.selections[v.id])
  }
  state.plan = plan
  state.docs = classified.docs
  return plan
}

function retarget(f: PlannedFile, dest: DestinationClass, asiRelative: string, fallbackName: string): PlannedFile {
  const base = path.basename(f.sourcePath)
  const target =
    dest === 'asi-plugin'
      ? [asiRelative, base].filter(Boolean).join('/')
      : dest === 'cleo-plugin' || dest === 'cleo-script'
        ? `cleo/${base}`
        : dest === 'root-file'
          ? base
          : `modloader/${fallbackName}/${f.sourcePath}`
  return { ...f, destination: dest, targetRelative: target }
}

/** Marks files that would land on top of something already installed. */
function annotateOverwrites(profileId: number, game: GameInstall, files: PlannedFile[], warnings: PlanWarning[]): void {
  const db = getDb()
  const stmt = db.prepare(
    `SELECT m.title FROM install_file f
       JOIN install i ON i.id = f.install_id
       JOIN mod_version mv ON mv.id = i.mod_version_id
       JOIN mod m ON m.id = mv.mod_id
      WHERE i.profile_id = ? AND lower(f.relative_path) = ?`
  )
  for (const f of files) {
    const owner = stmt.get(profileId, f.targetRelative.toLowerCase()) as { title: string } | undefined
    if (owner) {
      f.overwrites = true
      f.overwritesMod = owner.title
    } else if (exists(path.join(game.path, f.targetRelative))) {
      f.overwrites = true
      f.overwritesMod = f.overwritesMod ?? null
    }
  }
  const overwriting = files.filter((f) => f.overwrites)
  if (overwriting.length) {
    warnings.push({
      severity: 'warn',
      code: 'overwrite',
      message: `${overwriting.length} file(s) already exist at their destination.`,
      detail: 'Every one of them is backed up before it is replaced and restored on uninstall.'
    })
  }
}

async function annotateTextures(extractRoot: string, files: PlannedFile[], warnings: PlanWarning[]): Promise<void> {
  const { analyzeTxd } = await import('../formats/txd')
  let budget = 30
  for (const f of files) {
    if (budget <= 0) break
    if (!/\.txd$/i.test(f.sourcePath)) continue
    budget--
    const a = await analyzeTxd(path.join(extractRoot, f.sourcePath)).catch(() => null)
    if (!a) continue
    if (a.nonPowerOfTwo.length) {
      warnings.push({
        severity: 'warn',
        code: 'npot-texture',
        message: `${path.basename(f.sourcePath)} contains ${a.nonPowerOfTwo.length} non-power-of-two texture(s).`,
        detail: a.nonPowerOfTwo.map((t) => `${t.name} ${t.width}x${t.height}`).join(', ')
      })
    }
  }
}

/** Overlay detection: does this file replace a file that belongs to another installed mod? */
function findOverlay(profileId: number, relInsideArchive: string, base: string): OverlayMatch | null {
  const db = getDb()
  const key = providesKey(relInsideArchive.toLowerCase())
  const tail = key.split('/').slice(-2).join('/')
  const rows = db
    .prepare(
      `SELECT i.id AS install_id, m.title, f.relative_path
         FROM install_file f
         JOIN install i ON i.id = f.install_id
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ?
          AND (lower(f.relative_path) LIKE ? OR lower(f.relative_path) LIKE ?)
        LIMIT 4`
    )
    .all(profileId, `%/${tail}`, `%/${base.toLowerCase()}`) as {
    install_id: number
    title: string
    relative_path: string
  }[]
  if (rows.length !== 1) return null
  const [row] = rows
  // Only treat it as an overlay when the incoming file is not a whole mod of its own.
  if (!row.relative_path.toLowerCase().startsWith('modloader/')) return null
  return { installId: row.install_id, title: row.title, targetRelative: row.relative_path }
}

export async function choose(planId: string, groupId: string, optionId: string): Promise<InstallPlan> {
  const s = PLANS.get(planId)
  if (!s) throw new Error('This install plan has expired. Start the install again.')
  s.selections[groupId] = optionId
  return rebuild(planId)
}

export async function setDestination(planId: string, sourcePath: string, destination: DestinationClass): Promise<InstallPlan> {
  const s = PLANS.get(planId)
  if (!s) throw new Error('This install plan has expired. Start the install again.')
  s.overrides[sourcePath] = destination
  return rebuild(planId)
}

async function rebuild(planId: string): Promise<InstallPlan> {
  const s = PLANS.get(planId)!
  const p = s.plan
  return buildPlan(planId, {
    planId,
    modId: p.modId,
    modVersionId: p.modVersionId,
    title: p.title,
    author: p.author,
    sourceUrl: p.sourceUrl,
    archivePath: p.archivePath
  })
}

export async function discardPlan(planId: string): Promise<void> {
  const s = PLANS.get(planId)
  if (!s) return
  PLANS.delete(planId)
  await fsp.rm(s.stagingDir, { recursive: true, force: true }).catch(() => undefined)
}

export interface ApplyResult {
  installId: number
  written: number
  backedUp: number
  mode: string
}

/**
 * Applies a plan as a single reversible transaction: every file written is
 * recorded, everything displaced is backed up, and nothing is ever deleted.
 */
export async function applyPlan(
  planId: string,
  profileId: number,
  onProgress?: (phase: string, current: number, total: number) => void,
  opts: { acceptMissingDependencies?: boolean } = {}
): Promise<ApplyResult> {
  const state = PLANS.get(planId)
  if (!state) throw new Error('This install plan has expired. Start the install again.')
  const plan = state.plan
  const game = state.game

  if (plan.requiresVariantChoice) throw new Error('Choose a variant before installing.')
  // The layout the user accepted is the layout to expect next time an archive
  // of this shape turns up.
  learnLayout(
    signatureForArchive(
      plan.files.map((f) => f.sourcePath),
      plan.readmes[0]?.raw ?? null
    ),
    plan.files,
    'inference'
  )
  // Dependencies never block: they are reported on the plan and offered for
  // install, and the user decides. Only a plan that cannot be carried out at
  // all - nothing to install, a variant unchosen - stops here.
  void opts
  const blocking = plan.warnings.filter((w) => w.severity === 'error' && w.code !== 'empty')
  if (blocking.length) throw new Error(blocking.map((b) => b.message).join(' '))
  if (plan.files.length === 0) throw new Error('This plan installs no files.')

  const db = getDb()
  const modVersionId = plan.modVersionId ?? ensureLocalModVersion(plan)
  const modRow = db
    .prepare('SELECT m.slug FROM mod_version mv JOIN mod m ON m.id = mv.mod_id WHERE mv.id = ?')
    .get(modVersionId) as { slug: string }
  const versionLabel = (db.prepare('SELECT version_label FROM mod_version WHERE id = ?').get(modVersionId) as {
    version_label: string
  }).version_label

  const variantChoice = Object.values(state.selections).join(' + ') || null
  const key = storeKey(modRow.slug, versionLabel, variantChoice)

  onProgress?.('store', 0, plan.files.length)
  const stored = await ingest(key, plan.extractRoot, plan.files, (d, t) => onProgress?.('store', d, t))

  const folderName = primaryFolder(stored)
  const readmeText = state.readmes[0]?.raw ?? null

  const installId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO install (profile_id, mod_version_id, installed_at, destination_class, variant_choice,
                              enabled, priority, store_key, folder_name, readme_text, source_archive)
         VALUES (?,?,?,?,?,1,?,?,?,?,?)`
      )
      .run(
        profileId,
        modVersionId,
        new Date().toISOString(),
        dominantClass(stored),
        variantChoice,
        50,
        key,
        folderName,
        readmeText,
        plan.archivePath
      )
    const id = Number(info.lastInsertRowid)
    const fileStmt = db.prepare(
      `INSERT INTO install_file (install_id, relative_path, sha256, size, was_overwrite, backup_path, destination_class)
       VALUES (?,?,?,?,?,?,?)`
    )
    const providesStmt = db.prepare(
      'INSERT OR REPLACE INTO provides (install_id, relative_path, sha256, size) VALUES (?,?,?,?)'
    )
    for (const f of stored) {
      fileStmt.run(id, f.targetRelative, f.sha256, f.size, f.overwrites ? 1 : 0, null, f.destination)
      providesStmt.run(id, providesKey(f.targetRelative), f.sha256, f.size)
    }
    db.prepare(
      `INSERT INTO telemetry (mod_id, install_count, last_installed_at)
       VALUES ((SELECT mod_id FROM mod_version WHERE id = ?), 1, ?)
       ON CONFLICT(mod_id) DO UPDATE SET install_count = install_count + 1, last_installed_at = excluded.last_installed_at`
    ).run(modVersionId, new Date().toISOString())
    return id
  })()

  onProgress?.('link', 0, stored.length)
  const backupDir = path.join(Paths.profileBackups(profileId), String(installId))
  const owned = ownedPaths(profileId, installId)
  const result = await materialise(
    game,
    key,
    stored.map((f) => f.targetRelative),
    { allowJunction: canJunction(stored), backupDir, ownedPaths: owned }
  )

  const backupStmt = db.prepare('UPDATE install_file SET backup_path = ?, was_overwrite = 1 WHERE install_id = ? AND relative_path = ?')
  for (const b of result.backedUp) backupStmt.run(b.backupPath, installId, b.relativePath)

  db.prepare('INSERT INTO transaction_log (install_id, profile_id, kind, payload_json, created_at) VALUES (?,?,?,?,?)').run(
    installId,
    profileId,
    'install',
    JSON.stringify({ key, mode: result.mode, files: stored.length, backedUp: result.backedUp.length }),
    new Date().toISOString()
  )

  await syncProfileIni(profileId)
  await discardPlan(planId)

  return { installId, written: stored.length, backedUp: result.backedUp.length, mode: result.mode }
}

function canJunction(files: PlannedFile[]): boolean {
  return files.every((f) => f.destination === 'modloader-folder') && !files.some((f) => f.destination === 'overlay')
}

/** Every file the rest of this profile already owns, in the one spelling ownership is compared under. */
function ownedPaths(profileId: number, exceptInstallId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT f.relative_path p FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.id != ?`
    )
    .all(profileId, exceptInstallId) as { p: string }[]
  return new Set(rows.map((r) => ownedKey(r.p)))
}

function primaryFolder(files: PlannedFile[]): string | null {
  for (const f of files) {
    const m = /^modloader\/([^/]+)\//.exec(f.targetRelative)
    if (m) return m[1]
  }
  return null
}

function dominantClass(files: PlannedFile[]): DestinationClass {
  const counts = new Map<DestinationClass, number>()
  for (const f of files) counts.set(f.destination, (counts.get(f.destination) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown'
}

/** A mod installed from a local archive still gets catalogue rows so it behaves like any other. */
function ensureLocalModVersion(plan: InstallPlan): number {
  const db = getDb()
  const slug = slugify(plan.title) || `local-${Date.now()}`
  const now = new Date().toISOString()
  let mod = db.prepare('SELECT id FROM mod WHERE slug = ?').get(slug) as { id: number } | undefined
  if (!mod) {
    const info = db
      .prepare(
        `INSERT INTO mod (slug, title, author, category, source_url, description, first_seen_at, rating_inputs_json)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(slug, plan.title, plan.author || 'Unknown', 'Local', plan.sourceUrl ?? '', 'Installed from a local archive.', now, '{}')
    mod = { id: Number(info.lastInsertRowid) }
  }
  const label = `local ${new Date().toISOString().slice(0, 10)}`
  const info = db
    .prepare('INSERT INTO mod_version (mod_id, version_label, release_date, download_url, file_size) VALUES (?,?,?,?,?)')
    .run(mod.id, label, now, null, plan.totalSize)
  return Number(info.lastInsertRowid)
}

export interface UninstallResult {
  restored: number
  quarantined: string[]
  /** Paths left in place because another install in this profile also owns them. */
  kept: string[]
}

/** Uninstall restores the game folder to exactly the state it had before the install. */
export async function uninstall(installId: number): Promise<UninstallResult> {
  const db = getDb()
  const install = db.prepare('SELECT * FROM install WHERE id = ?').get(installId) as
    | { id: number; profile_id: number; store_key: string | null; enabled: number }
    | undefined
  if (!install) throw new Error('That install no longer exists.')
  const game = requireActiveGame()

  const files = db
    .prepare('SELECT relative_path, backup_path, sha256 FROM install_file WHERE install_id = ?')
    .all(installId) as { relative_path: string; backup_path: string | null; sha256: string | null }[]

  // The user (or another tool) may have changed a file after we wrote it: keep it.
  const quarantined = await quarantineEdited(
    game.path,
    files.map((f) => ({ relativePath: f.relative_path, sha256: f.sha256 })),
    path.join(Paths.quarantine(), String(installId))
  )

  // A file another install in this profile also owns is not this install's to
  // remove. Two copies of the same pack, one disabled, share every path: the
  // disabled one was deleted to tidy up and it took gta_sa.exe, modloader.asi
  // and CLEO.asi with it - files the copy that stayed was still providing.
  const sharedWith = sharedPaths(install.profile_id, installId)
  const mine = files.filter((f) => !sharedWith.has(ownedKey(f.relative_path)))
  const shared = files.filter((f) => sharedWith.has(ownedKey(f.relative_path)))

  const { restored } = await dematerialise(
    game,
    mine.map((f) => f.relative_path),
    mine.filter((f) => f.backup_path).map((f) => ({ relativePath: f.relative_path, backupPath: f.backup_path! }))
  )

  db.transaction(() => {
    db.prepare('DELETE FROM provides WHERE install_id = ?').run(installId)
    db.prepare('DELETE FROM install_file WHERE install_id = ?').run(installId)
    db.prepare('DELETE FROM install WHERE id = ?').run(installId)
    db.prepare('INSERT INTO transaction_log (install_id, profile_id, kind, payload_json, created_at) VALUES (?,?,?,?,?)').run(
      installId,
      install.profile_id,
      'uninstall',
      JSON.stringify({ restored, quarantined, keptForOtherInstalls: shared.map((f) => f.relative_path) }),
      new Date().toISOString()
    )
  })()

  await syncProfileIni(install.profile_id)
  return { restored, quarantined, kept: shared.map((f) => f.relative_path) }
}

/**
 * The game-relative paths another install in this profile also claims.
 *
 * Ownership is per file, not per mod: two mods can ship the same .asi, and the
 * same mod installed twice shares all of them. Removing one must leave whatever
 * the other still provides.
 */
function sharedPaths(profileId: number, exceptInstallId: number): Set<string> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT f.relative_path p FROM install_file f
         JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.id != ?`
    )
    .all(profileId, exceptInstallId) as { p: string }[]
  return new Set(rows.map((r) => ownedKey(r.p)))
}

/** What an uninstall would do, file by file, shown before the user commits. */
export function rollbackPreview(installId: number): { relativePath: string; action: string }[] {
  const files = getDb()
    .prepare('SELECT relative_path, backup_path, was_overwrite FROM install_file WHERE install_id = ? ORDER BY relative_path')
    .all(installId) as { relative_path: string; backup_path: string | null; was_overwrite: number }[]
  return files.map((f) => ({
    relativePath: f.relative_path,
    action: f.backup_path ? 'remove, then restore the file it replaced' : f.was_overwrite ? 'remove (original already restored)' : 'remove'
  }))
}

function sanitizeFolderName(title: string): string {
  return title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Mod'
}

/** The profile's name, for messages that have to say which one is missing something. */
function profileName(profileId: number): string {
  const row = getDb().prepare('SELECT name FROM profile WHERE id = ?').get(profileId) as { name: string } | undefined
  return row?.name ?? `#${profileId}`
}

/**
 * Requirements stated by the mod itself: the readme's own words first, then the
 * plugin binary's runtime probes.
 *
 * A curated dependency list only knows catalogued mods. These two sources know
 * whatever the author shipped, which is what actually crashes when missing.
 */
async function statedRequirements(
  extractRoot: string,
  readmes: ReadmeParse[]
): Promise<{ kind: 'requires' | 'conflicts'; name: string; line: string; url: string | null }[]> {
  const out: { kind: 'requires' | 'conflicts'; name: string; line: string; url: string | null }[] = []
  const seen = new Set<string>()
  const add = (kind: 'requires' | 'conflicts', name: string, line: string, url: string | null): void => {
    const key = `${kind}:${name.toLowerCase()}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ kind, name, line, url })
  }

  for (const r of readmes) {
    for (const d of r.declared) {
      // "includes" is the archive bringing its own copy of something - a
      // collision to watch, not a requirement to satisfy.
      if (d.kind === 'includes') continue
      add(d.kind, d.name, d.line, d.url)
    }
  }

  // The plugin's own strings: Proper Shaders prints "SilentPatch is installed."
  // because it looks for it, which is the requirement stated in machine form.
  const { pluginEvidence } = await import('../formats/strings')
  for (const file of await walk(extractRoot)) {
    if (!/\.asi$/i.test(file.rel) || file.size > 32 * 1024 * 1024) continue
    const buf = await fsp.readFile(path.join(extractRoot, file.rel)).catch(() => null)
    if (!buf) continue
    for (const probe of pluginEvidence(buf).probes) {
      add('requires', probe, `${path.basename(file.rel)} looks for ${probe} at runtime`, null)
    }
  }
  return out
}

/**
 * Is this named thing present in THIS profile, or loose in the game folder?
 *
 * Name matching is deliberately loose - "Open Limit Adjuster" in a readme is
 * "OpenLimitAdjuster.asi" on disk - and a plugin sitting in the ASI directory
 * counts even though no profile installed it, because the game will load it.
 */
function satisfiedInProfile(profileId: number, game: GameInstall, name: string): boolean {
  const needle = name.toLowerCase().replace(/[^a-z0-9+]/g, '')
  if (!needle) return true
  if (/^(modloader|modloader)$/.test(needle)) return game.hasModLoader
  if (needle === 'cleo') return !!game.cleoVersion

  const rows = getDb()
    .prepare(
      `SELECT f.relative_path p, m.title t FROM install_file f
         JOIN install i ON i.id = f.install_id
         JOIN mod_version mv ON mv.id = i.mod_version_id
         JOIN mod m ON m.id = mv.mod_id
        WHERE i.profile_id = ? AND i.enabled = 1`
    )
    .all(profileId) as { p: string; t: string }[]
  const flat = (v: string): string => v.toLowerCase().replace(/[^a-z0-9+]/g, '')
  if (rows.some((r) => flat(r.p).includes(needle) || flat(r.t).includes(needle))) return true

  const asiDir = game.asiDirectory ?? game.path
  if (exists(asiDir)) {
    const loose: string[] = fs.readdirSync(asiDir)
    if (loose.some((f) => /\.(asi|dll)$/i.test(f) && flat(f).includes(needle))) return true
  }
  return false
}

/** The catalogue entry for a requirement named in prose, if there is one. */
function catalogSlugFor(name: string): string | null {
  const flat = name.toLowerCase().replace(/[^a-z0-9+]/g, '')
  if (!flat) return null
  const rows = getDb().prepare('SELECT slug, title FROM mod').all() as { slug: string; title: string }[]
  const match = rows.find((r) => {
    const title = r.title.toLowerCase().replace(/[^a-z0-9+]/g, '')
    const slug = r.slug.toLowerCase().replace(/[^a-z0-9+]/g, '')
    return title.includes(flat) || slug.includes(flat)
  })
  return match?.slug ?? null
}
