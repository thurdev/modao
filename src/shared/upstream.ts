import { githubRepo } from './download'

/**
 * "Is this build simply old?" - the cheapest question in a crash investigation,
 * and the one nobody asks.
 *
 * The field report that produced this module spent days bisecting a crash that
 * came from a 2021-12-26 build of Collectibles on Radar (282,112 B). Upstream
 * v1.0.4 (253,440 B) fixed it outright. GInput, Discord Rich Presence, .asi
 * load order and a CLEO hook collision were each blamed and each disproved by
 * test before anyone compared the installed file against the release it came
 * from. Ruling an outdated build out costs one HTTP request; a bisect costs an
 * evening.
 *
 * This half is deliberately free of Electron, of undici and of the filesystem:
 * the release fetcher is injected, so every rule below is unit-testable and
 * runs outside the app - the same split as ./crashlist.ts and ./crashRecord.ts.
 *
 * The one rule that matters more than any other: a comparison that could not be
 * made is `unknown`. Never `outdated`. Someone offline must not be told their
 * mods are stale, because "outdated" is an instruction to go and re-download,
 * and sending a user to chase a file that is already current is worse than
 * saying nothing at all.
 */

// --- what a repo is, and how a mod is resolved to one -----------------------

export interface UpstreamRepo {
  owner: string
  repo: string
}

/** How a mod got matched to a repo, so the UI can say why it is being checked. */
export type RepoMatch = 'slug' | 'url' | 'file' | 'none'

export interface ResolvedRepo extends UpstreamRepo {
  via: RepoMatch
}

/**
 * The seeded registry.
 *
 * `slugs` are catalog slugs as MixMods writes them (the seed catalog in
 * resources/seed/catalog.json is the source for the four that exist there);
 * `files` match the binary a mod actually ships, which is what identifies a mod
 * installed from an archive that never went through the catalog at all.
 */
export interface RegistryEntry extends UpstreamRepo {
  slugs: string[]
  files: RegExp[]
}

export const UPSTREAM_REGISTRY: RegistryEntry[] = [
  {
    owner: 'kong78',
    repo: 'collectibles-on-radar-gta-sa',
    slugs: ['collectibles-on-radar', 'collectibles-on-radar-gta-sa'],
    files: [/^collectibles[ _.-]?on[ _.-]?radar\.(asi|cleo)$/i]
  },
  {
    owner: 'Flentric',
    repo: 'SA.MapCollectibles',
    slugs: ['sa-map-collectibles', 'map-collectibles'],
    files: [/^(sa[ _.-])?map[ _.-]?collectibles\.(asi|cleo)$/i]
  },
  {
    owner: 'CookiePLMonster',
    repo: 'SilentPatch',
    slugs: ['sa-silentpatch', 'silentpatch'],
    files: [/^silentpatch(sa|vc|iii)?\.asi$/i]
  },
  {
    owner: 'GTAmodding',
    repo: 'III.VC.SA.LimitAdjuster',
    slugs: ['open-limit-adjuster', 'iii-vc-sa-limitadjuster'],
    files: [/^(iii\.vc\.sa\.)?limitadjuster\.asi$/i, /^openlimitadjuster\.asi$/i]
  },
  {
    owner: 'JuniorDjjr',
    repo: 'CLEOPlus',
    slugs: ['cleoplus', 'cleo-plus'],
    files: [/^cleo\+?\.cleo$/i, /^cleoplus\.cleo$/i]
  },
  {
    owner: 'cleolibrary',
    repo: 'CLEO4',
    slugs: ['biblioteca-cleo-4-4', 'cleo4', 'cleo-4'],
    files: [/^cleo\.asi$/i]
  },
  {
    owner: 'ThirteenAG',
    repo: 'III.VC.SA.WindowedMode',
    slugs: ['iii-vc-sa-windowedmode', 'windowed-mode'],
    files: [/^(iii\.vc\.sa\.)?windowedmode\.asi$/i]
  }
]

/** Everything known about a mod that could point at a repo. */
export interface RepoCandidate {
  slug?: string | null
  /** mod.source_url - the MixMods post, or occasionally the repo itself. */
  sourceUrl?: string | null
  /** mod_version.download_url - a GitHub release link for a good number of mods. */
  downloadUrl?: string | null
  /** Base names of the binaries this install placed. */
  fileNames?: string[]
}

function repoFromUrl(value: string | null | undefined): UpstreamRepo | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.hostname.replace(/^www\./, '') !== 'github.com') return null
  // A releases URL is what githubRepo understands; a bare repo link is not, and
  // is common enough in mod.source_url to be worth reading here.
  const release = githubRepo(url)
  if (release) return { owner: release.owner, repo: release.repo }
  const parts = url.pathname.split('/').filter(Boolean)
  if (parts.length < 2) return null
  return { owner: parts[0], repo: parts[1].replace(/\.git$/i, '') }
}

/**
 * A mod to a repo, in the order that is most likely to be right: an explicit
 * registry entry beats a URL found in the catalog, and a URL beats a filename
 * guess. Returns null when nothing matches - most mods are not on GitHub, and
 * a mod with no repo is simply not checked, never reported as anything.
 */
export function resolveRepo(candidate: RepoCandidate, registry: RegistryEntry[] = UPSTREAM_REGISTRY): ResolvedRepo | null {
  const slug = (candidate.slug ?? '').toLowerCase()
  if (slug) {
    const bySlug = registry.find((e) => e.slugs.some((s) => s.toLowerCase() === slug))
    if (bySlug) return { owner: bySlug.owner, repo: bySlug.repo, via: 'slug' }
  }

  const fromUrl = repoFromUrl(candidate.downloadUrl) ?? repoFromUrl(candidate.sourceUrl)
  if (fromUrl) return { ...fromUrl, via: 'url' }

  for (const name of candidate.fileNames ?? []) {
    const base = name.split(/[\\/]/).pop() ?? name
    const byFile = registry.find((e) => e.files.some((re) => re.test(base)))
    if (byFile) return { owner: byFile.owner, repo: byFile.repo, via: 'file' }
  }
  return null
}

// --- the release, as much of it as the comparison needs ---------------------

export interface ReleaseAsset {
  name: string
  sizeBytes: number
  /** GitHub's `digest`, normalised to a bare lowercase sha256 hex, when present. */
  sha256: string | null
}

export interface UpstreamRelease {
  tag: string
  /** ISO-8601, or null when the API did not say. */
  publishedAt: string | null
  htmlUrl: string | null
  assets: ReleaseAsset[]
}

/** The injected half: anything that can produce a release for a repo. */
export type ReleaseFetcher = (repo: UpstreamRepo) => Promise<UpstreamRelease | null>

/** The installed side of the comparison - exactly what readPe() already returns. */
export interface InstalledBinary {
  /** Path as the install recorded it, for display. */
  relativePath: string
  sizeBytes: number
  sha256: string | null
  /** PE TimeDateStamp in seconds since the epoch; null when it could not be read. */
  peTimestamp: number | null
}

export type UpstreamState = 'current' | 'outdated' | 'unknown'

/**
 * Why the verdict is what it is. Kept as a code rather than a sentence so the
 * strings live in the catalogues and both languages say the same thing.
 */
export type UpstreamReason =
  | 'sha-match'
  | 'size-match'
  | 'sha-differs'
  | 'size-differs'
  | 'pe-older-than-release'
  | 'no-release'
  | 'no-comparable-asset'
  | 'fetch-failed'
  | 'not-a-pe'

export interface UpstreamComparison {
  state: UpstreamState
  reason: UpstreamReason
  installed: InstalledBinary
  release: UpstreamRelease | null
  /** The asset the verdict was drawn from, when one matched by name. */
  asset: ReleaseAsset | null
}

/**
 * A release published this much later than the binary was compiled is taken as
 * a hint that the binary is old. Two weeks of slack keeps a re-tagged release
 * of an unchanged build from being called outdated.
 */
export const PE_HINT_SLACK_MS = 14 * 24 * 60 * 60 * 1000

function normaliseName(name: string): string {
  return (name.split(/[\\/]/).pop() ?? name).toLowerCase()
}

/** The asset that IS this file: same name, so its size and digest are comparable. */
export function matchAsset(binary: InstalledBinary, release: UpstreamRelease): ReleaseAsset | null {
  const want = normaliseName(binary.relativePath)
  return release.assets.find((a) => normaliseName(a.name) === want) ?? null
}

/**
 * The comparison itself, with no I/O in it.
 *
 * Size and hash decide when the release ships the same file by name. When it
 * ships an archive instead - which most of these repos do - there is nothing to
 * compare byte for byte, and the PE timestamp is the only hint available: a
 * binary compiled well before the newest release was published is probably not
 * from that release. That is a hint and it is treated as one; everything else
 * that cannot be decided is `unknown`.
 */
export function compareToRelease(binary: InstalledBinary, release: UpstreamRelease | null): UpstreamComparison {
  const base = { installed: binary, release, asset: null as ReleaseAsset | null }
  if (!release) return { ...base, state: 'unknown', reason: 'no-release' }

  const asset = matchAsset(binary, release)
  if (asset) {
    if (asset.sha256 && binary.sha256) {
      const same = asset.sha256.toLowerCase() === binary.sha256.toLowerCase()
      return { ...base, asset, state: same ? 'current' : 'outdated', reason: same ? 'sha-match' : 'sha-differs' }
    }
    const same = asset.sizeBytes === binary.sizeBytes
    return { ...base, asset, state: same ? 'current' : 'outdated', reason: same ? 'size-match' : 'size-differs' }
  }

  // No asset carries this file's name: fall back to the PE timestamp hint.
  const publishedAt = release.publishedAt ? Date.parse(release.publishedAt) : NaN
  if (binary.peTimestamp === null) return { ...base, state: 'unknown', reason: 'not-a-pe' }
  if (!Number.isFinite(publishedAt)) return { ...base, state: 'unknown', reason: 'no-comparable-asset' }
  if (publishedAt - binary.peTimestamp * 1000 > PE_HINT_SLACK_MS) {
    return { ...base, state: 'outdated', reason: 'pe-older-than-release' }
  }
  return { ...base, state: 'unknown', reason: 'no-comparable-asset' }
}

/**
 * The same comparison with the fetch in front of it. Any failure from the
 * injected fetcher - offline, rate limited, 404, malformed JSON - lands on
 * `unknown`, which is the whole point of catching it here rather than letting
 * it out to a caller that might render it as a problem with the mod.
 */
export async function compareAgainstUpstream(
  binary: InstalledBinary,
  repo: UpstreamRepo,
  fetchRelease: ReleaseFetcher
): Promise<UpstreamComparison> {
  let release: UpstreamRelease | null
  try {
    release = await fetchRelease(repo)
  } catch {
    return { state: 'unknown', reason: 'fetch-failed', installed: binary, release: null, asset: null }
  }
  return compareToRelease(binary, release)
}

/** One line per mod, as the health check and the bisect refusal both report it. */
export interface OutdatedBuild {
  installId: number
  title: string
  relativePath: string
  repo: string
  installedBytes: number
  upstreamBytes: number | null
  upstreamTag: string
  releaseUrl: string | null
  reason: UpstreamReason
}

/** What startBisect is allowed to do, and what it has to say first. */
export interface BisectGate {
  proceed: boolean
  outdated: OutdatedBuild[]
  /** The refusal, as a catalogue key plus its placeholders - never a sentence. */
  refusal: { key: string; params: Record<string, string | number> } | null
}

/**
 * The precondition on a bisect, as a rule rather than as code inside an
 * Electron module.
 *
 * A bisect is an evening of launching the game and writing down what happened.
 * An outdated build is one download. So the first time a profile with an
 * outdated mod asks for a bisect, it does not get one: it gets the name of the
 * mod, the version it has and the version upstream has.
 *
 * It refuses ONCE. The second ask goes through, carrying the same findings on
 * the session, because someone who has read the warning and still wants to
 * bisect - they are pinned to that version, or they already know - must not be
 * locked out of the tool by a check that cannot possibly be sure.
 *
 * A scan that found nothing, or that could not reach the network at all, never
 * refuses: `outdated` is empty in both cases and the bisect simply starts.
 */
export function bisectGate(outdated: OutdatedBuild[], acknowledged: boolean): BisectGate {
  if (outdated.length === 0 || acknowledged) return { proceed: true, outdated, refusal: null }
  const first = outdated[0]
  return {
    proceed: false,
    outdated,
    refusal: {
      key: 'messages.bisect.outdatedFirst',
      params: {
        count: outdated.length,
        title: first.title,
        installed: first.installedBytes.toLocaleString(),
        latest: first.upstreamBytes === null ? '?' : first.upstreamBytes.toLocaleString(),
        repo: first.repo,
        url: first.releaseUrl ?? `https://github.com/${first.repo}/releases/latest`
      }
    }
  }
}
