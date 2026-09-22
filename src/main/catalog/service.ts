import path from 'node:path'
import fsp from 'node:fs/promises'
import type { CatalogMod, DestinationClass, InstalledSummary, ModBlock, ModVersion } from '@shared/types'
import { getDb, getSetting, setSetting } from '../db'
import { Paths } from '../util/paths'
import { exists } from '../util/fsx'
import { computeRating, ratingInputsFor } from './rating'
import { gamesOfMod, type GameKind } from '@shared/games'
import { relevance } from '@shared/search'
import { activeGame } from '../game/detect'

interface SeedMod {
  slug: string
  title: string
  author: string
  category: string
  categories?: string[]
  sourceUrl: string
  description: string
  paywalled: boolean
  publishedAt: string | null
  updatedAt: string | null
  versions: { versionLabel: string; releaseDate: string | null; downloadUrl: string | null; fileSize: number | null }[]
  requirements: string[]
  incompatibilities: string[]
  relatedMods?: string[]
  ratingInputs: Record<string, unknown>
  blocks?: ModBlock[]
  images?: string[]
  videos?: string[]
}

interface SeedFile {
  version: number
  generatedAt?: string
  mods: SeedMod[]
}

interface CuratedDependency {
  mod: string
  kind: 'requires' | 'conflicts' | 'alt'
  target: string
  altGroup?: string
  versionRange?: string | null
  note?: string
}

/**
 * The bundled catalogue is scraped from the public MixMods pages with the same
 * parser a live crawl uses, so the two can never disagree about how a page is
 * read. The app is useful with no network at all; indexing only adds to it.
 */
export async function loadSeedCatalog(force = false): Promise<number> {
  const db = getDb()
  const seedFile = path.join(Paths.resources(), 'catalog.json')
  if (!exists(seedFile)) return 0
  const raw = JSON.parse(await fsp.readFile(seedFile, 'utf8')) as SeedFile
  const stamp = `${raw.version}:${raw.generatedAt ?? ''}`
  if (!force && getSetting('seed.version') === stamp) return 0

  const now = new Date().toISOString()
  const upsertMod = db.prepare(
    `INSERT INTO mod (slug,title,author,category,source_url,description,blocks_json,images_json,videos_json,
        requirements_json,incompatible_json,games_json,readme,paywalled,published_at,updated_at,first_seen_at,last_indexed_at,rating_inputs_json)
     VALUES (@slug,@title,@author,@category,@source_url,@description,@blocks_json,@images_json,@videos_json,
        @requirements_json,@incompatible_json,@games_json,NULL,@paywalled,@published_at,@updated_at,@now,NULL,@rating_inputs_json)
     ON CONFLICT(slug) DO UPDATE SET
        title=excluded.title, author=excluded.author, category=excluded.category,
        source_url=excluded.source_url, description=excluded.description,
        blocks_json=excluded.blocks_json, images_json=excluded.images_json, videos_json=excluded.videos_json,
        requirements_json=excluded.requirements_json, incompatible_json=excluded.incompatible_json,
        games_json=excluded.games_json,
        paywalled=excluded.paywalled, published_at=excluded.published_at, updated_at=excluded.updated_at,
        rating_inputs_json=excluded.rating_inputs_json`
  )

  db.transaction(() => {
    for (const m of raw.mods) {
      upsertMod.run({
        slug: m.slug,
        title: m.title,
        author: m.author,
        category: m.category,
        source_url: m.sourceUrl,
        description: m.description,
        blocks_json: JSON.stringify(m.blocks ?? []),
        images_json: JSON.stringify(m.images ?? []),
        videos_json: JSON.stringify(m.videos ?? []),
        requirements_json: JSON.stringify(m.requirements ?? []),
        incompatible_json: JSON.stringify(m.incompatibilities ?? []),
        // Which GTA the post is for, read from its title tag and categories.
        games_json: JSON.stringify(gamesOfMod(m.title, m.categories ?? []).games),
        paywalled: m.paywalled ? 1 : 0,
        published_at: m.publishedAt,
        updated_at: m.updatedAt,
        now,
        rating_inputs_json: JSON.stringify(m.ratingInputs ?? {})
      })
      const modId = (db.prepare('SELECT id FROM mod WHERE slug = ?').get(m.slug) as { id: number }).id
      for (const v of m.versions ?? []) {
        const known = db.prepare('SELECT id FROM mod_version WHERE mod_id = ? AND version_label = ?').get(modId, v.versionLabel)
        if (!known) {
          db.prepare('INSERT INTO mod_version (mod_id, version_label, release_date, download_url, file_size) VALUES (?,?,?,?,?)').run(
            modId,
            v.versionLabel,
            v.releaseDate,
            v.downloadUrl,
            v.fileSize
          )
        }
      }
    }
  })()

  await loadCuratedDependencies()
  markEssentials(raw)

  setSetting('seed.version', stamp)
  return raw.mods.length
}

/**
 * Dependencies are maintained by hand. The mod pages state requirements in
 * prose - "requires CLEO 4.4+", "do not use with SkyGfx" - which no scraper
 * can turn into a reliable graph, and getting this wrong either blocks a valid
 * install or lets a known-fatal pair through.
 */
async function loadCuratedDependencies(): Promise<void> {
  const db = getDb()
  const file = path.join(Paths.resources(), 'dependencies.json')
  if (!exists(file)) return
  const raw = JSON.parse(await fsp.readFile(file, 'utf8')) as { dependencies: CuratedDependency[] }
  const idOf = (slug: string): number | null =>
    (db.prepare('SELECT id FROM mod WHERE slug = ?').get(slug) as { id: number } | undefined)?.id ?? null

  db.transaction(() => {
    for (const d of raw.dependencies) {
      const modId = idOf(d.mod)
      if (!modId) continue
      db.prepare('DELETE FROM dependency WHERE mod_id = ? AND requires_slug = ?').run(modId, d.target)
      db.prepare(
        'INSERT INTO dependency (mod_id, requires_mod_id, requires_slug, kind, version_range, alt_group, note) VALUES (?,?,?,?,?,?,?)'
      ).run(modId, idOf(d.target), d.target, d.kind, d.versionRange ?? null, d.altGroup ?? null, d.note ?? null)
    }
  })()
}

/**
 * Membership of the official Essentials pack is the strongest quality signal
 * MixMods gives, and it is expressed as links out of the Essentials post -
 * so it is read from there rather than guessed.
 */
function markEssentials(seed: SeedFile): void {
  const db = getDb()
  const essentials = seed.mods.find((m) => /essentials/i.test(m.slug) && /^\[?sa/i.test(m.title))
  if (!essentials?.relatedMods?.length) return
  const slugs = essentials.relatedMods
    .map((url) => url.replace(/\/$/, '').split('/').pop() ?? '')
    .filter(Boolean)
  for (const slug of slugs) {
    const row = db.prepare('SELECT id, rating_inputs_json FROM mod WHERE slug = ?').get(slug) as
      | { id: number; rating_inputs_json: string }
      | undefined
    if (!row) continue
    let inputs: Record<string, unknown> = {}
    try {
      inputs = JSON.parse(row.rating_inputs_json) as Record<string, unknown>
    } catch {
      inputs = {}
    }
    inputs.inEssentials = true
    db.prepare('UPDATE mod SET rating_inputs_json = ? WHERE id = ?').run(JSON.stringify(inputs), row.id)
  }
}

interface ModRow {
  id: number
  slug: string
  title: string
  author: string
  category: string
  source_url: string
  description: string
  blocks_json: string
  images_json: string
  videos_json: string
  requirements_json: string
  incompatible_json: string
  readme: string | null
  paywalled: number
  published_at: string | null
  updated_at: string | null
  first_seen_at: string
  last_indexed_at: string | null
}

export interface CatalogQuery {
  search?: string
  category?: string
  sort?: 'rating' | 'updated' | 'title' | 'author'
  installedOnly?: boolean
  profileId?: number | null
  limit?: number
  /** How many rows to skip, for the endless list the UI scrolls. */
  offset?: number
  /** Only posts for this game. Defaults to the active install's game. */
  game?: GameKind | 'all'
}


/**
 * The games a catalogue row is for. Rows written before the games column
 * existed - and rows whose crawl predates this build - are classified from the
 * title tag and categories on the spot, so an old index needs no re-crawl.
 */
export function gamesOfRow(row: { title: string; category: string; games_json?: string | null }): GameKind[] {
  try {
    const stored = JSON.parse(row.games_json || '[]') as GameKind[]
    if (Array.isArray(stored) && stored.length) return stored
  } catch {
    // fall through to deriving it
  }
  return gamesOfMod(row.title, row.category ? [row.category] : []).games
}

export function listCatalog(q: CatalogQuery): { mods: CatalogMod[]; categories: string[]; total: number } {
  const db = getDb()
  const where: string[] = []
  const params: unknown[] = []
  // Filtering happens in JS: SQL LIKE cannot ignore accents, and "animacoes"
  // has to find "Animações" in a catalogue written in Portuguese.

  if (q.category && q.category !== 'All') {
    where.push('category = ?')
    params.push(q.category)
  }
  const rows = db
    .prepare(`SELECT * FROM mod ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`)
    .all(...params) as ModRow[]

  // A mod for Vice City has no business in a San Andreas library, so the game
  // filter is applied in JS rather than SQL: rows indexed before the games
  // column existed carry an empty list and are classified on read.
  const wanted = q.game ?? activeGame()?.kind ?? 'sa'
  const forThisGame = (r: ModRow): boolean => {
    if (wanted === 'all') return true
    return gamesOfRow(r).includes(wanted)
  }

  const categories = [...new Set(rows.filter(forThisGame).map((r) => r.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  )

  const scored = rows
    .filter(forThisGame)
    .map((r) => ({ row: r, score: q.search ? relevance(r, q.search) : 1 }))
    .filter((entry) => entry.score > 0)

  let mods = scored.map((entry) => ({ ...toCatalogMod(entry.row, q.profileId ?? null), score: entry.score }))
  if (q.installedOnly) mods = mods.filter((m) => m.installed)

  const sort = q.sort ?? 'rating'
  mods.sort((a, b) => {
    // A search is answered by relevance first; the chosen sort breaks ties.
    if (q.search && a.score !== b.score) return b.score - a.score
    if (sort === 'title') return a.title.localeCompare(b.title)
    if (sort === 'author') return a.author.localeCompare(b.author) || a.title.localeCompare(b.title)
    if (sort === 'updated') return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
    return b.rating - a.rating || a.title.localeCompare(b.title)
  })

  const total = mods.length
  const offset = Math.max(0, q.offset ?? 0)
  const page = q.limit ? mods.slice(offset, offset + q.limit) : mods.slice(offset)
  // The score ranked the page; it is not something the UI needs to carry.
  return { mods: page.map(({ score: _score, ...mod }) => mod), categories: ['All', ...categories], total }
}

export function getCatalogMod(modId: number, profileId: number | null): CatalogMod | null {
  const row = getDb().prepare('SELECT * FROM mod WHERE id = ?').get(modId) as ModRow | undefined
  return row ? toCatalogMod(row, profileId) : null
}

function toCatalogMod(row: ModRow, profileId: number | null): CatalogMod {
  const db = getDb()
  const versions = (db.prepare('SELECT * FROM mod_version WHERE mod_id = ? ORDER BY id DESC').all(row.id) as {
    id: number
    mod_id: number
    version_label: string
    release_date: string | null
    download_url: string | null
    file_size: number | null
    sha256: string | null
    changelog: string | null
  }[]).map<ModVersion>((v) => ({
    id: v.id,
    modId: v.mod_id,
    versionLabel: v.version_label,
    releaseDate: v.release_date,
    downloadUrl: v.download_url,
    fileSize: v.file_size,
    sha256: v.sha256,
    changelog: v.changelog
  }))

  const inputs = ratingInputsFor(row.id)
  let installed: InstalledSummary | null = null
  if (profileId) {
    const inst = db
      .prepare(
        `SELECT i.id, i.enabled, i.priority, i.destination_class, mv.version_label, mv.id AS version_id
           FROM install i JOIN mod_version mv ON mv.id = i.mod_version_id
          WHERE i.profile_id = ? AND mv.mod_id = ? ORDER BY i.id DESC LIMIT 1`
      )
      .get(profileId, row.id) as
      | { id: number; enabled: number; priority: number; destination_class: string; version_label: string; version_id: number }
      | undefined
    if (inst) {
      const newest = versions[0]
      installed = {
        installId: inst.id,
        versionLabel: inst.version_label,
        enabled: !!inst.enabled,
        priority: inst.priority,
        destinationClass: inst.destination_class as DestinationClass,
        updateAvailable: !!newest && newest.id !== inst.version_id
      }
    }
  }

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    author: row.author,
    category: row.category,
    sourceUrl: row.source_url,
    description: row.description,
    blocks: safeBlocks(row.blocks_json),
    images: safeArray(row.images_json),
    videos: safeArray(row.videos_json),
    requirementsText: safeArray(row.requirements_json),
    incompatibleText: safeArray(row.incompatible_json),
    games: gamesOfRow(row),
    readme: row.readme,
    paywalled: !!row.paywalled,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    firstSeenAt: row.first_seen_at,
    lastIndexedAt: row.last_indexed_at,
    ratingInputs: inputs,
    rating: computeRating(inputs),
    versions,
    installed
  }
}

/** Blocks are only present for entries indexed after the post-layout change. */
function safeBlocks(json: string | null): ModBlock[] {
  if (!json) return []
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? (value as ModBlock[]) : []
  } catch {
    return []
  }
}

function safeArray(json: string): string[] {
  try {
    const v = JSON.parse(json)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

export function seedInfo(): { count: number; lastCrawl: string | null; crawlEnabled: boolean } {
  const count = (getDb().prepare('SELECT COUNT(*) c FROM mod').get() as { c: number }).c
  return {
    count,
    lastCrawl: getSetting('catalog.lastCrawl'),
    crawlEnabled: getSetting('catalog.crawlEnabled', '0') === '1'
  }
}
