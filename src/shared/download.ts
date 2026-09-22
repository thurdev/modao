/**
 * Which download links Modão can actually fetch, and which ones are a page
 * with a button on it.
 *
 * MixMods almost never links a file: its download buttons point at sharemods,
 * MediaFire, Mega or Google Drive landing pages, which serve HTML to a browser
 * and 403 to anything else. Fetching one of those produces "Download failed:
 * HTTP 403" and tells the user nothing. Recognising the shape of the link up
 * front is what lets the app say "download this yourself, then hand me the
 * archive" before it wastes a request.
 */

const ARCHIVE_EXTENSION = /\.(7z|zip|rar)(\?|#|$)/i

/** Hosts that only ever serve an interstitial page, whatever the path looks like. */
const LANDING_PAGE_HOSTS = [
  'sharemods.com',
  'mediafire.com',
  'mega.nz',
  'mega.io',
  'drive.google.com',
  'docs.google.com',
  '1fichier.com',
  'gofile.io',
  'pixeldrain.com',
  'zippyshare.com',
  'gtainside.com',
  'patreon.com',
  'boosty.to',
  'ko-fi.com',
  'dropbox.com',
  // Link shorteners and ad gates the scene wraps downloads in.
  'linkshrink.net',
  'j.gs',
  'ouo.io',
  'adf.ly',
  'bc.vc',
  'shorte.st'
]

export interface DownloadKind {
  /** True when Modão can end up with the file on its own. */
  direct: boolean
  /** How it gets there. */
  kind: 'file' | 'github-release' | 'landing' | 'none'
  host: string
  /** Why it cannot be fetched, in words the UI can show as-is. */
  reason: string | null
}

export function classifyDownload(url: string | null): DownloadKind {
  if (!url) return { direct: false, kind: 'none', host: '', reason: 'No download link is recorded for this release.' }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { direct: false, kind: 'none', host: '', reason: 'The recorded download link is not a valid URL.' }
  }
  const host = parsed.hostname.replace(/^www\./, '')

  if (LANDING_PAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    return {
      direct: false,
      kind: 'landing',
      host,
      reason: `${host} serves a download page rather than the file itself, and refuses requests that are not a browser.`
    }
  }

  if (host === 'github.com') {
    // An asset URL is the file. A release page is not - but GitHub publishes
    // its releases through an API, so Modão can find the asset itself
    // rather than sending the user off to look for it.
    if (/\/releases\/download\//.test(parsed.pathname)) return { direct: true, kind: 'file', host, reason: null }
    if (githubRepo(parsed)) return { direct: true, kind: 'github-release', host, reason: null }
    return { direct: false, kind: 'landing', host, reason: 'That GitHub link is not a release.' }
  }

  if (!ARCHIVE_EXTENSION.test(parsed.pathname)) {
    return { direct: false, kind: 'landing', host, reason: `${host} did not give a link ending in .7z, .zip or .rar.` }
  }
  return { direct: true, kind: 'file', host, reason: null }
}

/** owner/repo for any github.com/<owner>/<repo>/releases… URL. */
export function githubRepo(url: URL): { owner: string; repo: string; tag: string | null } | null {
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 3 || parts[2] !== 'releases') return null
  const tagIndex = parts.indexOf('tag')
  return { owner: parts[0], repo: parts[1], tag: tagIndex > 0 ? (parts[tagIndex + 1] ?? null) : null }
}

/**
 * What the bytes actually are. A landing page that answers 200 still hands back
 * HTML, and writing that to disk as "mod.7z" fails later with a confusing
 * extraction error rather than here with an honest one.
 */
export function looksLikeArchive(head: Uint8Array): boolean {
  if (head.length < 4) return false
  const [a, b, c, d] = head
  if (a === 0x50 && b === 0x4b) return true // PK.. zip
  if (a === 0x37 && b === 0x7a && c === 0xbc && d === 0xaf) return true // 7z
  if (a === 0x52 && b === 0x61 && c === 0x72 && d === 0x21) return true // Rar!
  return false
}

/**
 * Some hosts have a page Modão can drive and a page it cannot. Google Drive
 * is the clear case: /file/d/<id>/view is an app shell that refuses to load
 * outside a normal browsing context, while /uc?export=download&id=<id> is the
 * endpoint that either hands over the file or shows the virus-scan notice the
 * page driver knows how to answer.
 */
export function normalizeForFetch(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const host = parsed.hostname.replace(/^www\./, '')

  if (host === 'drive.google.com') {
    const byPath = /\/file\/d\/([^/]+)/.exec(parsed.pathname)?.[1]
    const id = byPath ?? parsed.searchParams.get('id')
    if (id) return `https://drive.google.com/uc?export=download&id=${id}`
  }

  // MediaFire sometimes links the folder view of a single file.
  if (host === 'mediafire.com' && parsed.pathname.startsWith('/folder/')) return url

  return url
}
