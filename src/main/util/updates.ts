import { app } from 'electron'
import { getSetting, setSetting } from '../db'
import { userAgent } from '../catalog/http'

/**
 * Update checking, done the way a desktop app should: it asks GitHub for the
 * latest release, it tells the user once, and it never installs anything on its
 * own. Dismissing a version is remembered, so the same release cannot nag twice.
 *
 * Nothing here phones home with anything about the user: it is one GET to the
 * public releases endpoint, and it can be turned off in Settings.
 */
const RELEASES_API = 'https://api.github.com/repos/thurdev/modao/releases/latest'
const DISMISSED_KEY = 'updates.dismissedVersion'
const LAST_CHECK_KEY = 'updates.lastCheck'
const ENABLED_KEY = 'updates.checkOnStart'
/** One check a day is plenty for a mod manager, and it keeps the API happy. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface UpdateStatus {
  /** The version running right now. */
  current: string
  /** The newest published release, when a check has succeeded. */
  latest: string | null
  available: boolean
  /** True when the user has already dismissed exactly this version. */
  dismissed: boolean
  releaseUrl: string | null
  publishedAt: string | null
  notes: string | null
  checkedAt: string | null
  /** Why the last check could not answer, if it could not. */
  error: string | null
}

/** Compares "1.2.10" with "1.10.0" the way a human would, not alphabetically. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string): number[] =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((p) => Number.parseInt(p, 10))
      .map((n) => (Number.isFinite(n) ? n : 0))
  const a = parse(candidate)
  const b = parse(current)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }
  return false
}

export function updateChecksEnabled(): boolean {
  return getSetting(ENABLED_KEY, '1') === '1'
}

export function setUpdateChecksEnabled(on: boolean): void {
  setSetting(ENABLED_KEY, on ? '1' : '0')
}

/** Stops this exact version from being offered again. */
export function dismissUpdate(version: string): void {
  setSetting(DISMISSED_KEY, version.replace(/^v/i, ''))
}

function statusFrom(
  latest: string | null,
  extra: Partial<UpdateStatus> = {}
): UpdateStatus {
  const current = app.getVersion()
  const dismissed = latest !== null && getSetting(DISMISSED_KEY, '') === latest.replace(/^v/i, '')
  return {
    current,
    latest,
    available: latest !== null && isNewer(latest, current),
    dismissed,
    releaseUrl: null,
    publishedAt: null,
    notes: null,
    checkedAt: getSetting(LAST_CHECK_KEY, null),
    error: null,
    ...extra
  }
}

/**
 * Asks GitHub what the latest release is.
 *
 * `force` is the Settings button: it ignores both the daily interval and the
 * "check on start" setting, because the user asked directly.
 */
export async function checkForUpdate(force = false): Promise<UpdateStatus> {
  if (!force) {
    if (!updateChecksEnabled()) return statusFrom(null, { error: null })
    const last = getSetting(LAST_CHECK_KEY, null)
    if (last && Date.now() - new Date(last).getTime() < CHECK_INTERVAL_MS) {
      const remembered = getSetting('updates.latestSeen', null)
      return statusFrom(remembered, {
        releaseUrl: getSetting('updates.latestUrl', null),
        notes: getSetting('updates.latestNotes', null),
        publishedAt: getSetting('updates.latestPublished', null)
      })
    }
  }

  try {
    const { request } = await import('undici')
    const res = await request(RELEASES_API, {
      headers: { 'user-agent': userAgent(), accept: 'application/vnd.github+json' },
      maxRedirections: 3
    })
    if (res.statusCode === 404) {
      // No release published yet: not an error worth showing anyone.
      setSetting(LAST_CHECK_KEY, new Date().toISOString())
      return statusFrom(null)
    }
    if (res.statusCode >= 400) {
      return statusFrom(null, { error: `GitHub answered HTTP ${res.statusCode}.` })
    }
    const body = (await res.body.json()) as {
      tag_name?: string
      html_url?: string
      published_at?: string
      body?: string
      draft?: boolean
      prerelease?: boolean
    }
    if (body.draft || body.prerelease || !body.tag_name) {
      setSetting(LAST_CHECK_KEY, new Date().toISOString())
      return statusFrom(null)
    }

    const latest = body.tag_name.replace(/^v/i, '')
    setSetting(LAST_CHECK_KEY, new Date().toISOString())
    setSetting('updates.latestSeen', latest)
    if (body.html_url) setSetting('updates.latestUrl', body.html_url)
    if (body.published_at) setSetting('updates.latestPublished', body.published_at)
    if (body.body) setSetting('updates.latestNotes', body.body.slice(0, 4000))

    return statusFrom(latest, {
      releaseUrl: body.html_url ?? null,
      publishedAt: body.published_at ?? null,
      notes: body.body?.slice(0, 4000) ?? null,
      checkedAt: new Date().toISOString()
    })
  } catch (e) {
    return statusFrom(null, { error: (e as Error).message })
  }
}
