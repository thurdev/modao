import path from 'node:path'
import type { HealthCheck } from '@shared/types'
import {
  compareAgainstUpstream,
  resolveRepo,
  type InstalledBinary,
  type OutdatedBuild,
  type ReleaseAsset,
  type ReleaseFetcher,
  type UpstreamComparison,
  type UpstreamRelease,
  type UpstreamRepo
} from '@shared/upstream'
import { getDb, getSetting, setSetting } from '../db'
import { requireActiveGame } from '../game/detect'
import { readPe } from '../game/pe'
import { storeDir } from '../store/contentStore'
import { exists } from '../util/fsx'
import { t } from '../util/i18n'
import { log } from '../util/log'

/**
 * The I/O half of the outdated-build check: find the binaries this profile
 * installed, ask GitHub what the newest release of each one is, and hand both
 * to the pure comparison in @shared/upstream.
 *
 * There is no new HTTP client here. The request shape is the one
 * `resolveGithubRelease` in ../ipc.ts already uses - undici plus the
 * `userAgent()` the catalog crawler sends - and nothing new is added to
 * package.json for it.
 *
 * Everything that can fail is caught. A profile whose mods cannot be checked
 * gets a `skip`, a repo that cannot be reached gets `unknown`, and neither ever
 * becomes "your mod is out of date".
 */

/** Binaries worth comparing: the ones that are PE images and crash the game. */
const BINARY = /\.(asi|cleo|dll)$/i

/** A release is re-read at most this often; in between, the cached JSON answers. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000

/** Nobody needs 300 HTTP requests to answer "is anything obviously old?". */
const MAX_REPOS_PER_RUN = 12

interface CachedRelease {
  fetchedAt: number
  release: UpstreamRelease | null
}

function cacheKey(repo: UpstreamRepo): string {
  return `upstream:${repo.owner}/${repo.repo}`.toLowerCase()
}

function readCache(repo: UpstreamRepo): CachedRelease | null {
  const raw = getSetting(cacheKey(repo))
  if (!raw) return null
  try {
    return JSON.parse(raw) as CachedRelease
  } catch {
    return null
  }
}

/** GitHub writes digests as "sha256:<hex>"; older releases carry none at all. */
function assetSha(digest: unknown): string | null {
  if (typeof digest !== 'string') return null
  const m = /^sha256:([0-9a-f]{64})$/i.exec(digest.trim())
  return m ? m[1].toLowerCase() : null
}

interface GithubRelease {
  tag_name?: string
  published_at?: string
  html_url?: string
  assets?: { name?: string; size?: number; digest?: string }[]
}

/**
 * releases/latest for one repo, through undici, cached in the settings table.
 *
 * A stale cache is preferred over nothing when the network is down: the last
 * known release is still a better basis for "is this old?" than silence, and
 * the comparison it feeds is the same one either way.
 */
export const fetchLatestRelease: ReleaseFetcher = async (repo) => {
  const cached = readCache(repo)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.release

  const { request } = await import('undici')
  const { userAgent } = await import('../catalog/http')
  try {
    const res = await request(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, {
      headers: { 'user-agent': userAgent(), accept: 'application/vnd.github+json' },
      maxRedirections: 3
    })
    if (res.statusCode >= 400) {
      // 404 means "no releases", which is a real answer and worth caching so
      // the same repo is not asked again on every health check.
      await res.body.dump()
      if (res.statusCode === 404) {
        setSetting(cacheKey(repo), JSON.stringify({ fetchedAt: Date.now(), release: null } satisfies CachedRelease))
        return null
      }
      throw new Error(`GitHub answered ${res.statusCode} for ${repo.owner}/${repo.repo}`)
    }
    const body = (await res.body.json()) as GithubRelease
    const assets: ReleaseAsset[] = (body.assets ?? [])
      .filter((a): a is { name: string; size: number; digest?: string } => typeof a.name === 'string')
      .map((a) => ({ name: a.name, sizeBytes: Number(a.size ?? 0), sha256: assetSha(a.digest) }))
    const release: UpstreamRelease = {
      tag: body.tag_name ?? '',
      publishedAt: body.published_at ?? null,
      htmlUrl: body.html_url ?? null,
      assets
    }
    setSetting(cacheKey(repo), JSON.stringify({ fetchedAt: Date.now(), release } satisfies CachedRelease))
    return release
  } catch (e) {
    // Offline, rate limited, DNS gone: fall back to whatever was last known and
    // let the comparison decide. With no cache at all this throws on to
    // compareAgainstUpstream, which turns it into `unknown`.
    if (cached) {
      log('upstream check fell back to a stale release', { repo: `${repo.owner}/${repo.repo}` })
      return cached.release
    }
    throw e
  }
}

interface InstallRow {
  id: number
  store_key: string | null
  folder_name: string | null
  slug: string
  title: string
  source_url: string
  download_url: string | null
}

interface FileRow {
  install_id: number
  relative_path: string
  sha256: string | null
  size: number
}

/** Where the bytes of an installed file actually live, store or game folder. */
function fileLocation(gamePath: string, storeKey: string | null, relativePath: string): string {
  return storeKey ? path.join(storeDir(storeKey), relativePath) : path.join(gamePath, relativePath)
}

export interface UpstreamScan {
  /** Mods whose installed binary lost the comparison against the newest release. */
  outdated: OutdatedBuild[]
  /** Mods that were resolved to a repo and compared. */
  checked: number
  /** Mods resolved to a repo whose verdict could not be reached (offline, no asset). */
  unknown: number
  /** True when nothing could be resolved to a repo at all. */
  empty: boolean
}

/**
 * Every enabled mod in a profile that resolves to a GitHub repo, compared
 * against that repo's newest release.
 *
 * The fetcher is a parameter so the whole scan can be driven from a stub; the
 * default is the cached undici one above.
 */
export async function scanUpstream(profileId: number, fetchRelease: ReleaseFetcher = fetchLatestRelease): Promise<UpstreamScan> {
  const game = requireActiveGame()
  const installs = getDb()
    .prepare(
      `SELECT i.id, i.store_key, i.folder_name, m.slug, m.title, m.source_url, v.download_url
         FROM install i
         JOIN mod_version v ON v.id = i.mod_version_id
         JOIN mod m ON m.id = v.mod_id
        WHERE i.profile_id = ? AND i.enabled = 1
        ORDER BY i.id`
    )
    .all(profileId) as InstallRow[]
  if (installs.length === 0) return { outdated: [], checked: 0, unknown: 0, empty: true }

  const files = getDb()
    .prepare(
      `SELECT f.install_id, f.relative_path, f.sha256, f.size
         FROM install_file f JOIN install i ON i.id = f.install_id
        WHERE i.profile_id = ? AND i.enabled = 1`
    )
    .all(profileId) as FileRow[]
  const byInstall = new Map<number, FileRow[]>()
  for (const f of files) {
    if (!BINARY.test(f.relative_path)) continue
    const list = byInstall.get(f.install_id)
    if (list) list.push(f)
    else byInstall.set(f.install_id, [f])
  }

  const out: UpstreamScan = { outdated: [], checked: 0, unknown: 0, empty: true }
  let repos = 0
  for (const install of installs) {
    const binaries = byInstall.get(install.id) ?? []
    const repo = resolveRepo({
      slug: install.slug,
      sourceUrl: install.source_url,
      downloadUrl: install.download_url,
      fileNames: binaries.map((b) => b.relative_path)
    })
    if (!repo) continue
    out.empty = false
    if (++repos > MAX_REPOS_PER_RUN) break

    // The binary that names the mod is the one worth comparing; with several,
    // the largest is the plugin and the rest are its helpers.
    const candidate = [...binaries].sort((a, b) => b.size - a.size)[0]
    if (!candidate) {
      out.unknown++
      continue
    }
    const file = fileLocation(game.path, install.store_key, candidate.relative_path)
    let installed: InstalledBinary = {
      relativePath: candidate.relative_path,
      sizeBytes: candidate.size,
      sha256: candidate.sha256,
      peTimestamp: null
    }
    if (exists(file)) {
      // readPe is the app's only PE reader; it also re-hashes the file, which
      // is what catches a binary edited in place since the install recorded it.
      const pe = await readPe(file).catch(() => null)
      if (pe) installed = { relativePath: candidate.relative_path, sizeBytes: pe.sizeBytes, sha256: pe.sha256, peTimestamp: pe.timestamp }
    }

    const verdict: UpstreamComparison = await compareAgainstUpstream(installed, repo, fetchRelease)
    out.checked++
    if (verdict.state === 'outdated') {
      out.outdated.push({
        installId: install.id,
        title: install.folder_name ?? install.title,
        relativePath: candidate.relative_path,
        repo: `${repo.owner}/${repo.repo}`,
        installedBytes: installed.sizeBytes,
        upstreamBytes: verdict.asset?.sizeBytes ?? null,
        upstreamTag: verdict.release?.tag ?? '',
        releaseUrl: verdict.release?.htmlUrl ?? `https://github.com/${repo.owner}/${repo.repo}/releases/latest`,
        reason: verdict.reason
      })
    } else if (verdict.state === 'unknown') {
      out.unknown++
    }
  }
  return out
}

/** One line of evidence per outdated mod, in whichever language is active. */
export function describeOutdated(entry: OutdatedBuild): string {
  return t('checks.upstreamItem', {
    title: entry.title,
    file: entry.relativePath,
    installed: entry.installedBytes.toLocaleString(),
    latest: entry.upstreamBytes === null ? t('checks.unknown') : entry.upstreamBytes.toLocaleString(),
    tag: entry.upstreamTag || t('checks.unknown'),
    repo: entry.repo
  })
}

/**
 * The health-check face of the scan.
 *
 * `warn`, never `fail`: an old build is a strong suspect, not a proven fault,
 * and the user may be pinned to that version on purpose. `skip` covers both
 * "nothing here is on GitHub" and "the network did not answer" - the two cases
 * that must never look like a verdict about the mods.
 */
export async function outdatedBuildCheck(
  profileId: number,
  fetchRelease: ReleaseFetcher = fetchLatestRelease
): Promise<HealthCheck> {
  let scan: UpstreamScan
  try {
    scan = await scanUpstream(profileId, fetchRelease)
  } catch (e) {
    log('upstream check could not run', { error: (e as Error).message })
    return { id: 'upstream', title: t('checks.upstreamTitle'), status: 'skip', summary: t('checks.upstreamUnavailable') }
  }

  if (scan.empty) {
    return { id: 'upstream', title: t('checks.upstreamTitle'), status: 'skip', summary: t('checks.upstreamNoRepos') }
  }
  if (scan.outdated.length === 0 && scan.checked === 0) {
    return { id: 'upstream', title: t('checks.upstreamTitle'), status: 'skip', summary: t('checks.upstreamUnavailable') }
  }
  if (scan.outdated.length === 0) {
    return {
      id: 'upstream',
      title: t('checks.upstreamTitle'),
      status: 'pass',
      summary: t('checks.upstreamCurrent', { count: scan.checked }),
      detail: scan.unknown ? t('checks.upstreamSomeUnknown', { count: scan.unknown }) : undefined
    }
  }
  return {
    id: 'upstream',
    title: t('checks.upstreamTitle'),
    status: 'warn',
    summary: t('checks.upstreamOutdated', { count: scan.outdated.length }),
    detail: t('checks.upstreamDetail'),
    items: scan.outdated.map(describeOutdated)
  }
}
