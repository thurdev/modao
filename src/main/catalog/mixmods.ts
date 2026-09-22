import { getDb } from '../db'
import { fetchPage } from './http'
import {
  MIXMODS_ORIGIN,
  SA_ARCHIVES,
  parseArchiveLastPage,
  parseArchivePostLinks,
  parseModPage,
  type ScrapedMod
} from './mixmodsParse'

export * from './mixmodsParse'

export interface CrawlReport {
  visited: number
  /** Pages that produced a mod the catalogue had never seen. */
  indexed: number
  /** Pages that refreshed a mod already in the catalogue. */
  updated: number
  skipped: number
  errors: string[]
}

/**
 * Crawls every GTA: San Andreas mod page on MixMods, enumerated from the
 * /gta-sa/ and /gta-sa-de/ category archives rather than the sitemap: the
 * sitemap lists all 3,600 posts on the site with no way to tell which game a
 * post belongs to, and this app manages San Andreas.
 *
 * Polite throughout - one request per second, ETag-validated, and a page that
 * was read in the last day is served from cache instead of being fetched
 * again, which is what makes a re-index cheap.
 */
export async function crawl(
  opts: {
    maxPages?: number
    signal?: AbortSignal
    onProgress?: (done: number, total: number, label: string) => void
  } = {}
): Promise<CrawlReport> {
  const report: CrawlReport = { visited: 0, indexed: 0, skipped: 0, updated: 0, errors: [] }
  // 0 means "everything"; a positive value is a deliberate cap from settings.
  const cap = opts.maxPages && opts.maxPages > 0 ? opts.maxPages : Number.MAX_SAFE_INTEGER

  const postUrls = new Set<string>()
  for (const archive of SA_ARCHIVES) {
    if (opts.signal?.aborted) break
    let lastPage = 1
    for (let page = 1; page <= lastPage; page++) {
      if (opts.signal?.aborted) break
      if (postUrls.size >= cap) break
      const url = page === 1 ? `${MIXMODS_ORIGIN}${archive}` : `${MIXMODS_ORIGIN}${archive}page/${page}/`
      try {
        const res = await fetchPage(url)
        if (res.skippedReason === 'robots') break
        if (page === 1) lastPage = parseArchiveLastPage(res.body)
        for (const link of parseArchivePostLinks(res.body)) postUrls.add(link)
        opts.onProgress?.(postUrls.size, 0, `listing ${archive} page ${page}/${lastPage}`)
      } catch (e) {
        report.errors.push(`${url}: ${(e as Error).message}`)
        break
      }
    }
  }

  const list = [...postUrls].slice(0, cap)
  let done = 0
  for (const url of list) {
    if (opts.signal?.aborted) break
    try {
      const res = await fetchPage(url)
      report.visited++
      if (res.skippedReason === 'robots') {
        report.skipped++
        continue
      }
      const mod = parseModPage(res.body, url)
      if (!mod || mod.description.length < 120) {
        report.skipped++
        continue
      }
      const outcome = upsertScraped(mod)
      if (outcome.created) report.indexed++
      else report.updated++
    } catch (e) {
      report.errors.push(`${url}: ${(e as Error).message}`)
    }
    opts.onProgress?.(++done, list.length, url)
  }
  return report
}

export function upsertScraped(mod: ScrapedMod): { modId: number; created: boolean } {
  const db = getDb()
  const now = new Date().toISOString()
  const existing = db.prepare('SELECT id FROM mod WHERE slug = ?').get(mod.slug) as { id: number } | undefined
  const values = {
    slug: mod.slug,
    title: mod.title,
    author: mod.authors.join(', '),
    category: mod.category,
    source_url: mod.sourceUrl,
    description: mod.description,
    blocks_json: JSON.stringify(mod.blocks ?? []),
    images_json: JSON.stringify(mod.images),
    videos_json: JSON.stringify(mod.videos),
    requirements_json: JSON.stringify(mod.requirements),
    incompatible_json: JSON.stringify(mod.incompatibilities),
    readme: mod.readme,
    paywalled: mod.paywalled ? 1 : 0,
    published_at: mod.publishedAt,
    updated_at: mod.updatedAt,
    last_indexed_at: now
  }
  let modId: number
  if (existing) {
    db.prepare(
      `UPDATE mod SET title=@title, author=@author, category=@category, source_url=@source_url,
        description=@description, blocks_json=@blocks_json, images_json=@images_json, videos_json=@videos_json,
        requirements_json=@requirements_json, incompatible_json=@incompatible_json, readme=@readme,
        paywalled=@paywalled, published_at=@published_at, updated_at=@updated_at, last_indexed_at=@last_indexed_at
       WHERE slug=@slug`
    ).run(values)
    modId = existing.id
  } else {
    modId = Number(
      db
        .prepare(
          `INSERT INTO mod (slug,title,author,category,source_url,description,blocks_json,images_json,videos_json,
            requirements_json,incompatible_json,readme,paywalled,published_at,updated_at,first_seen_at,last_indexed_at,rating_inputs_json)
           VALUES (@slug,@title,@author,@category,@source_url,@description,@blocks_json,@images_json,@videos_json,
            @requirements_json,@incompatible_json,@readme,@paywalled,@published_at,@updated_at,@first_seen_at,@last_indexed_at,'{}')`
        )
        .run({ ...values, first_seen_at: now }).lastInsertRowid
    )
  }
  const label = mod.version ?? (mod.updatedAt ?? mod.publishedAt ?? now).slice(0, 10)
  const known = db.prepare('SELECT id FROM mod_version WHERE mod_id = ? AND version_label = ?').get(modId, label) as
    | { id: number }
    | undefined
  if (!known) {
    db.prepare('INSERT INTO mod_version (mod_id, version_label, release_date, download_url, file_size) VALUES (?,?,?,?,?)').run(
      modId,
      label,
      mod.updatedAt ?? mod.publishedAt,
      mod.downloadUrls[0] ?? null,
      mod.fileSize
    )
  }
  return { modId, created: !existing }
}

export async function refreshMod(modId: number): Promise<boolean> {
  const db = getDb()
  const row = db.prepare('SELECT source_url FROM mod WHERE id = ?').get(modId) as { source_url: string } | undefined
  if (!row?.source_url) return false
  const res = await fetchPage(row.source_url, { force: true })
  if (res.skippedReason === 'robots') return false
  const parsed = parseModPage(res.body, row.source_url)
  if (!parsed) return false
  upsertScraped(parsed)
  return true
}
