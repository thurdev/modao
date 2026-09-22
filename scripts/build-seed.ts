/**
 * Builds resources/seed/catalog.json from the real MixMods site, using the
 * exact parser the app ships (src/main/catalog/mixmods.ts) so the bundled
 * catalogue and a live crawl can never disagree about how a page is read.
 *
 * Polite by construction: one request per second, sitemap-driven, and no
 * paywalled file is ever fetched - only its page URL is recorded.
 *
 *   npm run seed            refresh the bundled catalogue
 *   npm run seed -- 80      with a different page budget
 */
import fs from 'node:fs'
import path from 'node:path'
import { request } from 'undici'
import {
  SA_ARCHIVES,
  parseArchiveLastPage,
  parseArchivePostLinks,
  parseModPage,
  type ScrapedMod
} from '../src/main/catalog/mixmodsParse'

const ORIGIN = 'https://www.mixmods.com.br'
const UA = 'Modão/1.0 (GTA SA mod manager; catalogue seed builder; +https://github.com/modao/modao)'
const PACE_MS = 1100

/** Mods the scene treats as load-bearing; always included if they are found. */
const PRIORITY_SLUGS = [
  'cleoplus',
  'cleo-redux',
  'crashinfo',
  'fastman92-limit-adjuster',
  'open-limit-adjuster',
  'modloader',
  'sa-mod-loader',
  'mod-loader',
  'sa-cleo',
  'cleo',
  'sa-cleo-redux',
  'asi-loader',
  'sa-silentpatch',
  'silentpatch',
  'sa-proper-shaders',
  'sa-proper-fixes',
  'sa-skygfx',
  'sa-vehfuncs',
  'sa-mixsets',
  'sa-crashinfo',
  'sa-project2dfx',
  'widescreen-fix',
  'sa-open-limit-adjuster',
  'sa-fastman92-limit-adjuster',
  'sa-soundize',
  'sa-real-linear-lighting'
]

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * MixMods cross-lists a handful of posts for its other games under /gta-sa/.
 * The bracket tag in the title is what states the game:
 * "[III|VC|SA] CrashInfo" belongs in this catalogue, "[VC] SilentPatch" does
 * not. A post with no tag at all is assumed to be San Andreas, which is what
 * the archive it came from says.
 */
function isForSanAndreas(title: string): boolean {
  const tag = /^\[([^\]]+)\]/.exec(title)?.[1]
  if (!tag) return !/^(nfs|nfsu|nfsmw|guitar hero|gh3|beamng|earth ?2150)\b/i.test(title)
  return /\b(sa|sade|sa:de|samp|mta)\b/i.test(tag)
}

async function get(url: string): Promise<string> {
  const res = await request(url, { headers: { 'user-agent': UA }, maxRedirections: 3 })
  if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`)
  return res.body.text()
}

async function main(): Promise<void> {
  const budget = Number.parseInt(process.argv[2] ?? '', 10) || 0
  const cap = budget > 0 ? budget : Number.MAX_SAFE_INTEGER

  const robots = await get(`${ORIGIN}/robots.txt`)
  if (/Disallow:\s*\/\s*$/m.test(robots)) throw new Error('robots.txt disallows crawling; aborting')
  console.log('robots.txt allows crawling')

  // The category archives are what make this San Andreas only: the sitemap
  // lists every post on the site, including the other games MixMods covers.
  const urls: string[] = []
  for (const archive of SA_ARCHIVES) {
    let lastPage = 1
    for (let page = 1; page <= lastPage; page++) {
      if (urls.length >= cap) break
      await sleep(PACE_MS)
      const html = await get(page === 1 ? `${ORIGIN}${archive}` : `${ORIGIN}${archive}page/${page}/`)
      if (page === 1) {
        lastPage = parseArchiveLastPage(html)
        console.log(`${archive} -> ${lastPage} archive pages`)
      }
      for (const link of parseArchivePostLinks(html)) if (!urls.includes(link)) urls.push(link)
      if (page % 25 === 0 || page === lastPage) console.log(`  ${archive} page ${page}/${lastPage}: ${urls.length} posts`)
    }
  }
  console.log(`${urls.length} San Andreas post(s) to read`)

  const chosen = urls.slice(0, cap)
  const mods: ScrapedMod[] = []
  let failures = 0
  for (const [i, url] of chosen.entries()) {
    await sleep(PACE_MS)
    try {
      const mod = parseModPage(await get(url), url)
      if (!mod || mod.description.length < 150) continue
      if (!isForSanAndreas(mod.title)) continue
      // A few old posts live on Blogger subdomains; the catalogue only carries
      // pages on the main site, so attribution always points somewhere stable.
      if (!mod.sourceUrl.startsWith(`${ORIGIN}/`)) continue
      if (mods.some((m) => m.slug === mod.slug)) continue
      mods.push(mod)
      if (mods.length % 25 === 0) {
        console.log(`  ${String(i + 1).padStart(4)}/${chosen.length} kept ${mods.length}  last: ${mod.title.slice(0, 48)}`)
      }
    } catch (e) {
      failures++
      if (failures < 12) console.log(`  fail ${url}: ${(e as Error).message}`)
    }
  }
  console.log(`parsed ${mods.length} mods, ${failures} failures`)

  const seed = {
    format: 'modao-seed',
    version: 2,
    generatedAt: new Date().toISOString(),
    source: ORIGIN,
    note:
      'Scraped from the public MixMods pages with the same parser the app ships. Every entry links back to its page ' +
      'and its author; no file is mirrored, and paywalled releases carry only their page URL.',
    mods: mods.map((m) => ({
      slug: m.slug,
      title: m.title,
      author: m.authors.join(', '),
      category: m.category,
      categories: m.categories,
      sourceUrl: m.sourceUrl,
      // A summary and a link, not the author's post. The seed that ships inside
      // the installer is a way to find someone else's work offline; Modão reads
      // the full post from MixMods when the user opens a mod, and caches it for
      // that user alone.
      description: excerpt(m.description, 400),
      blocks: [],
      images: m.images.slice(0, 3),
      videos: m.videos.slice(0, 4),
      paywalled: m.paywalled,
      publishedAt: m.publishedAt,
      updatedAt: m.updatedAt,
      requirements: m.requirements,
      incompatibilities: m.incompatibilities,
      relatedMods: m.relatedMods,
      versions: [
        {
          versionLabel: m.version ?? ((m.updatedAt ?? m.publishedAt ?? '').slice(0, 10) || 'unknown'),
          releaseDate: m.updatedAt ?? m.publishedAt,
          downloadUrl: m.downloadUrls[0] ?? null,
          fileSize: m.fileSize
        }
      ],
      ratingInputs: {}
    }))
  }

  const out = path.join('resources', 'seed', 'catalog.json')
  fs.writeFileSync(out, JSON.stringify(seed, null, 2), 'utf8')
  const kb = (fs.statSync(out).size / 1024).toFixed(0)
  console.log(`\n${seed.mods.length} mods written to ${out} (${kb} KB)`)
  console.log(`  with images:      ${seed.mods.filter((m) => m.images.length).length}`)
  console.log(`  with a download:  ${seed.mods.filter((m) => m.versions[0].downloadUrl).length}`)
  console.log(`  paywalled:        ${seed.mods.filter((m) => m.paywalled).length}`)
}

void main()

/** The first sentences of a post, for a search result that reads. */
function excerpt(text: string, limit: number): string {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= limit) return t
  const cut = t.slice(0, limit)
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (stop > limit * 0.5 ? cut.slice(0, stop + 1) : `${cut.trimEnd()}…`).trim()
}
