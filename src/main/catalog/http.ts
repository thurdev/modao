import path from 'node:path'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { request } from 'undici'
import { app } from 'electron'
import { Paths } from '../util/paths'
import { exists } from '../util/fsx'

/**
 * A polite HTTP client for the catalog crawler.
 *
 * Modão is a discovery client for someone else's site, not a mirror:
 * robots.txt is honoured, requests are rate limited to one per second with
 * backoff, responses are cached on disk with ETag / Last-Modified validation,
 * and a page is never re-crawled more than once a day.
 */
const MIN_INTERVAL_MS = 1000
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export function userAgent(): string {
  return `Modão/${app.getVersion()} (GTA SA mod manager; +https://github.com/modao/modao) undici`
}

let lastRequestAt = 0
let backoffMs = 0

async function pace(): Promise<void> {
  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS + backoffMs - Date.now())
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

interface CacheEntry {
  url: string
  etag: string | null
  lastModified: string | null
  fetchedAt: number
  status: number
  body: string
}

function cachePath(url: string): string {
  return path.join(Paths.httpCache(), `${crypto.createHash('sha1').update(url).digest('hex')}.json`)
}

async function readCache(url: string): Promise<CacheEntry | null> {
  const file = cachePath(url)
  if (!exists(file)) return null
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as CacheEntry
  } catch {
    return null
  }
}

async function writeCache(entry: CacheEntry): Promise<void> {
  await fsp.writeFile(cachePath(entry.url), JSON.stringify(entry), 'utf8')
}

// --- robots.txt -------------------------------------------------------------

interface Robots {
  disallow: string[]
  allow: string[]
  crawlDelayMs: number
  fetchedAt: number
}

const robotsByOrigin = new Map<string, Robots>()

export async function loadRobots(origin: string): Promise<Robots> {
  const cached = robotsByOrigin.get(origin)
  if (cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) return cached
  const robots: Robots = { disallow: [], allow: [], crawlDelayMs: 0, fetchedAt: Date.now() }
  try {
    await pace()
    const res = await request(`${origin}/robots.txt`, { headers: { 'user-agent': userAgent() } })
    const text = await res.body.text()
    let applies = false
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, '').trim()
      if (!line) continue
      const [keyRaw, ...rest] = line.split(':')
      const key = keyRaw.trim().toLowerCase()
      const value = rest.join(':').trim()
      if (key === 'user-agent') applies = value === '*' || value.toLowerCase().includes('modao')
      else if (!applies) continue
      else if (key === 'disallow' && value) robots.disallow.push(value)
      else if (key === 'allow' && value) robots.allow.push(value)
      else if (key === 'crawl-delay') robots.crawlDelayMs = (Number.parseFloat(value) || 0) * 1000
    }
  } catch {
    // No robots.txt reachable: stay conservative and keep the 1 req/s pace.
  }
  robotsByOrigin.set(origin, robots)
  return robots
}

export async function isAllowed(url: string): Promise<boolean> {
  const u = new URL(url)
  const robots = await loadRobots(u.origin)
  const p = u.pathname
  const matches = (rule: string): boolean => p.startsWith(rule.replace(/\*$/, ''))
  if (robots.allow.some(matches)) return true
  return !robots.disallow.some(matches)
}

export interface FetchResult {
  url: string
  status: number
  body: string
  fromCache: boolean
  skippedReason?: 'robots' | 'fresh'
}

export async function fetchPage(url: string, opts: { force?: boolean } = {}): Promise<FetchResult> {
  const cached = await readCache(url)
  if (!opts.force && cached && Date.now() - cached.fetchedAt < MAX_AGE_MS) {
    return { url, status: cached.status, body: cached.body, fromCache: true, skippedReason: 'fresh' }
  }
  if (!(await isAllowed(url))) {
    return { url, status: 999, body: cached?.body ?? '', fromCache: !!cached, skippedReason: 'robots' }
  }

  const robots = await loadRobots(new URL(url).origin)
  if (robots.crawlDelayMs > MIN_INTERVAL_MS) backoffMs = robots.crawlDelayMs - MIN_INTERVAL_MS

  await pace()
  const headers: Record<string, string> = { 'user-agent': userAgent(), accept: 'text/html,application/xhtml+xml' }
  if (cached?.etag) headers['if-none-match'] = cached.etag
  if (cached?.lastModified) headers['if-modified-since'] = cached.lastModified

  const res = await request(url, { headers, maxRedirections: 3 })
  if (res.statusCode === 429 || res.statusCode >= 500) {
    backoffMs = Math.min(60_000, Math.max(2000, backoffMs * 2 || 2000))
    throw new Error(`${url} responded ${res.statusCode}; backing off to ${Math.round(backoffMs / 1000)}s`)
  }
  backoffMs = 0

  if (res.statusCode === 304 && cached) {
    const entry: CacheEntry = { ...cached, fetchedAt: Date.now() }
    await writeCache(entry)
    return { url, status: 304, body: cached.body, fromCache: true }
  }

  const body = await res.body.text()
  const entry: CacheEntry = {
    url,
    etag: (res.headers['etag'] as string) ?? null,
    lastModified: (res.headers['last-modified'] as string) ?? null,
    fetchedAt: Date.now(),
    status: res.statusCode,
    body
  }
  await writeCache(entry)
  return { url, status: res.statusCode, body, fromCache: false }
}
