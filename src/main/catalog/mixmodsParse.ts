import * as cheerio from 'cheerio'

/**
 * cheerio's own element and selection types, named once. The library's generics
 * changed shape between versions, so the block reader pins them here rather
 * than repeating a long structural type at every call site.
 */
type CheerioNode = ReturnType<cheerio.CheerioAPI>
type DomNode = NonNullable<CheerioNode['0']>
import { slugify } from '../util/fsx'

export const MIXMODS_ORIGIN = 'https://www.mixmods.com.br'

/**
 * One piece of a mod page, in the order the author wrote it. A mod page is a
 * post - text, screenshots, headings and videos interleaved - and flattening
 * it into "a string plus a pile of images" loses the thing the user came to
 * read.
 */
export type ModBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'image'; src: string; caption: string | null }
  | { type: 'video'; src: string }

export interface ScrapedMod {
  blocks: ModBlock[]
  slug: string
  title: string
  authors: string[]
  version: string | null
  publishedAt: string | null
  updatedAt: string | null
  category: string
  categories: string[]
  description: string
  images: string[]
  videos: string[]
  downloadUrls: string[]
  fileSize: number | null
  requirements: string[]
  incompatibilities: string[]
  relatedMods: string[]
  readme: string | null
  sourceUrl: string
  paywalled: boolean
}

/**
 * MixMods runs WordPress (Yoast), not Blogger. Every mod page follows the same
 * shape and it is worth naming precisely, because guessing here is what makes a
 * catalogue full of empty descriptions:
 *
 *   h1                         the mod title, e.g. "[SA] VehFuncs v2.5.5"
 *   .entry-content             the whole post body the author wrote
 *   a[href*="/author/"]        the author, e.g. Junior_Djjr
 *   a[href*="/gta-sa/..."]     the category links shown under the title
 *   meta[article:*_time]       publish and last-update timestamps
 *   a > img.download_bt1       the download buttons, pointing at sharemods,
 *                              MediaFire, Mega, GitHub releases or Patreon
 *
 * Images are lazy-loaded: the src attribute holds a base64 placeholder and the
 * real URL lives in data-lazy-src / data-src, or in the parent anchor when the
 * thumbnail links to the full-size version.
 */
export function parseModPage(html: string, url: string): ScrapedMod | null {
  const $ = cheerio.load(html)

  // Posts from the Blogger era are still linked by their old http .html URLs
  // and redirect; the canonical link is what the site itself considers the
  // page, and what a user should be sent to.
  const canonical = $('link[rel="canonical"]').attr('href') ?? $('meta[property="og:url"]').attr('content') ?? ''
  const pageUrl = /^https:\/\/www\.mixmods\.com\.br\/\d{4}\/\d{2}\//.test(canonical) ? canonical : url

  const title = clean(
    $('h1.entry-title').first().text() ||
      $('h1').first().text() ||
      ($('meta[property="og:title"]').attr('content') ?? '').replace(/\s*-\s*MixMods.*$/i, '')
  )
  if (!title) return null

  const content = $('.entry-content').first()
  if (content.length === 0) return null

  // WordPress serves its 404 with the same shell, and "Página não encontrada"
  // would otherwise be indexed as a mod.
  const is404 = $('body').hasClass('error404') || /^(não encontrado|page not found|nada encontrado)\.?$/i.test(title)
  const isArticle = !!$('meta[property="article:published_time"]').attr('content') || $('article').length > 0
  if (is404 || !isArticle) return null

  // Strip the furniture WordPress adds around the author's own words.
  const body = content.clone()
  body.find('script, style, .sharedaddy, .jp-relatedposts, .code-block, ins, .adsbygoogle').remove()

  // cheerio's .text() concatenates block elements with no separator, which
  // turns a whole post into one unreadable run of sentences. Every block and
  // every <br> gets an explicit newline before the text is taken.
  body.find('br').replaceWith('\n')
  body.find('p, div, li, h1, h2, h3, h4, blockquote, tr, pre, figure').each((_, el) => {
    $(el).prepend('\n')
    $(el).append('\n')
  })

  const description = body
    .text()
    .replace(/ /g, ' ')
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 20000)

  const blocks = readBlocks($, body)

  const images = uniq(
    content
      .find('img')
      .map((_, el) => {
        const $el = $(el)
        const src =
          $el.attr('data-lazy-src') ||
          $el.attr('data-src') ||
          $el.attr('data-lazy-srcset')?.split(' ')[0] ||
          $el.attr('src') ||
          ''
        if (src && !src.startsWith('data:')) return src
        // A lazy thumbnail often sits inside a link to the full-size image.
        const parentHref = $el.parent('a').attr('href') ?? ''
        return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(parentHref) ? parentHref : ''
      })
      .get()
      .filter(Boolean)
  ).filter((src) => !/download_bt|logo-mixmods|avatar/i.test(src))

  const videos = uniq(
    content
      .find('iframe')
      .map((_, el) => $(el).attr('src') ?? $(el).attr('data-lazy-src') ?? '')
      .get()
      .filter((s) => /youtube|youtu\.be|vimeo|streamable/i.test(s))
  )

  // The download buttons are images with the download_bt class inside an anchor.
  const downloadUrls = uniq(
    content
      .find('a')
      .map((_, el) => {
        const $a = $(el)
        const href = $a.attr('href') ?? ''
        if (!/^https?:/i.test(href)) return ''
        // A link to another MixMods post is a related mod, never a download -
        // treating it as one gives the catalogue links that lead to an article.
        if (/mixmods\.com\.br\/\d{4}\/\d{2}\//.test(href)) return ''
        const isButton = $a.find('img[class*="download_bt"]').length > 0
        const looksLikeHost = /sharemods|mediafire|mega\.nz|drive\.google|github\.com\/[^/]+\/[^/]+\/releases|gtainside|1fichier/i.test(href)
        const saysDownload = /^\s*(download|baixar)/i.test(clean($a.text()))
        return isButton || looksLikeHost || saysDownload ? href : ''
      })
      .get()
      .filter(Boolean)
  )

  const authors = uniqCaseless(
    $('a[href*="/author/"], [rel="author"], .author.vcard a')
      .map((_, el) => clean($(el).text()))
      .get()
      .filter((a) => a.length > 1 && a.length < 40)
  ).slice(0, 3)

  // Category links sit next to the author and tag links in the same header, so
  // they are picked by their href shape: a non-dated path that is not an
  // author, tag or search page.
  const categories = uniqCaseless(
    $('.entry-header a[href*="mixmods.com.br/"], .cat-links a, a[rel~="category"]')
      .map((_, el) => {
        const href = $(el).attr('href') ?? ''
        const isPost = /mixmods\.com\.br\/\d{4}\/\d{2}\//.test(href)
        const isMeta = /\/(author|tag|page|feed|wp-content)\//.test(href)
        const isRoot = /mixmods\.com\.br\/?$/.test(href)
        if (!href || isPost || isMeta || isRoot) return ''
        return clean($(el).text())
      })
      .get()
      .filter((c) => c.length > 1 && c.length < 40 && !/^https?:/.test(c))
  )

  const publishedAt = $('meta[property="article:published_time"]').attr('content') ?? null
  const updatedAt = $('meta[property="article:modified_time"]').attr('content') ?? null

  // "[SA] VehFuncs v2.5.5" -> 2.5.5; otherwise look for a version line in the body.
  // The title is where MixMods states the version: "[SA] VehFuncs v2.5.5",
  // "ModLoader 0.3.10", "SilentPatch (Build 34.1 - 2026)". Body prose is only a
  // fallback, because a "versão:" line inside a post usually describes the game
  // or another mod rather than this release.
  const version =
    /\bv\.?\s?(\d+(?:\.\d+)+[a-z]?)\b/i.exec(title)?.[1] ??
    /\bbuild\s+(\d+(?:\.\d+)*)/i.exec(title)?.[1] ??
    /\b(\d+\.\d+(?:\.\d+)*[a-z]?)\b/.exec(title)?.[1] ??
    firstMatch(description, [/^vers[aã]o\s*:?\s*([\d.]{1,12})\s*$/im, /^version\s*:?\s*([\d.]{1,12})\s*$/im]) ??
    null

  const requirements = extractList(description, /(?:requer|requisitos?|requires?|necess[aá]rio|need(?:s|ed)?)\s*:?\s*(.+)/gi)
  const incompatibilities = extractList(
    description,
    /(?:incompat[ií]vel|incompatible|n[aã]o funciona com|conflita com|conflicts? with)\s*:?\s*(.+)/gi
  )

  // Other MixMods posts linked from the body - the scene's real dependency graph.
  const relatedMods = uniq(
    content
      .find('a')
      .map((_, el) => $(el).attr('href') ?? '')
      .get()
      .filter((h) => /^https:\/\/www\.mixmods\.com\.br\/\d{4}\/\d{2}\//.test(h) && h !== pageUrl)
  ).slice(0, 12)

  // Patreon-gated builds: the link alone is not enough, the text has to say so.
  const patreonLinked = /patreon\.com/i.test(html)
  const gatedWording = /(early ?access|alpha backers?|beta backers?|apoiador|antecipad|exclusiv|backers? only)/i.test(description)

  return {
    blocks,
    slug: slugFromUrl(pageUrl) || slugify(title),
    title,
    authors: authors.length ? authors : ['MixMods'],
    version,
    publishedAt,
    updatedAt,
    category: primaryCategory(categories),
    categories,
    description,
    images,
    videos,
    downloadUrls,
    fileSize: parseSize(description),
    requirements,
    incompatibilities,
    relatedMods,
    readme: null,
    sourceUrl: pageUrl,
    paywalled: patreonLinked && gatedWording
  }
}


/**
 * Walks the post body in document order and emits the blocks that carry
 * meaning. Anything else - ad slots, share widgets, empty wrappers - is
 * skipped, and a container is only descended into when it holds no text of its
 * own, so a paragraph is never emitted twice.
 */
function readBlocks($: cheerio.CheerioAPI, body: CheerioNode): ModBlock[] {
  const blocks: ModBlock[] = []
  const seenImages = new Set<string>()

  const pushText = (text: string): void => {
    const value = text.replace(/ /g, ' ').replace(/[ 	]+/g, ' ').trim()
    if (value.length < 2) return
    const last = blocks[blocks.length - 1]
    if (last?.type === 'text' && last.text === value) return
    blocks.push({ type: 'text', text: value })
  }

  const imageOf = ($el: CheerioNode): string => {
    const src =
      $el.attr('data-lazy-src') || $el.attr('data-src') || $el.attr('data-lazy-srcset')?.split(' ')[0] || $el.attr('src') || ''
    if (src && !src.startsWith('data:')) return src
    const parentHref = $el.parent('a').attr('href') ?? ''
    return /\.(jpe?g|png|webp|gif)(\?|$)/i.test(parentHref) ? parentHref : ''
  }

  const walk = (node: DomNode): void => {
    const $el = $(node) as unknown as CheerioNode
    const tag = (node as { tagName?: string }).tagName?.toLowerCase() ?? ''

    if (tag === 'img') {
      const src = imageOf($el)
      if (src && !seenImages.has(src) && !/download_bt|logo-mixmods|avatar|smiley/i.test(src)) {
        seenImages.add(src)
        blocks.push({ type: 'image', src, caption: $el.attr('alt')?.trim() || null })
      }
      return
    }
    if (tag === 'iframe') {
      const src = $el.attr('src') ?? $el.attr('data-lazy-src') ?? ''
      if (/youtube|youtu\.be|vimeo|streamable/i.test(src)) blocks.push({ type: 'video', src })
      return
    }
    if (/^h[1-4]$/.test(tag)) {
      const text = $el.text().replace(/\s+/g, ' ').trim()
      if (text) blocks.push({ type: 'heading', text })
      return
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = $el
        .children('li')
        .map((_, li) => $(li).text().replace(/\s+/g, ' ').trim())
        .get()
        .filter(Boolean)
      if (items.length) blocks.push({ type: 'list', items })
      $el.find('img, iframe').each((_, child) => walk(child))
      return
    }

    const children = $el.children().toArray()
    if (tag === 'p' || tag === 'blockquote') {
      // A paragraph may wrap an image; emit the image, then the text around it.
      $el.find('img, iframe').each((_, child) => walk(child))
      pushText($el.clone().find('img, iframe, script, style').remove().end().text())
      return
    }
    if (children.length === 0) {
      pushText($el.text())
      return
    }
    for (const child of children) walk(child)
  }

  for (const node of body.children().toArray()) walk(node)
  return blocks
}

/**
 * Posts carry several categories at once, and the first one is usually a
 * site-wide bucket ("Nossas criações", "DESTAQUES") rather than what the mod
 * is. The most specific one is the useful label for a filter.
 */
const GENERIC_CATEGORIES = new Set([
  'nossas criações',
  'nossas criacoes',
  'our creations',
  'destaques',
  'highlights',
  'mods scripts etc',
  'mods rápidos',
  'mods rapidos',
  'gta sa',
  'gta sa: de',
  'sem categoria',
  'uncategorised',
  'uncategorized'
])

function primaryCategory(categories: string[]): string {
  const specific = categories.find((c) => !GENERIC_CATEGORIES.has(c.toLowerCase()))
  return specific ?? categories[0] ?? 'Uncategorised'
}

/** mixmods.com.br/2025/12/sa-vehfuncs/ -> sa-vehfuncs */
export function slugFromUrl(url: string): string {
  const m = /mixmods\.com\.br\/\d{4}\/\d{2}\/([^/?#]+)/.exec(url)
  return m ? m[1] : ''
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Dedupes ignoring case and stray whitespace: the same author appears in several places on a page. */
function uniqCaseless(items: string[]): string[] {
  const seen = new Map<string, string>()
  for (const raw of items) {
    const value = raw.replace(/ /g, ' ').trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (!seen.has(key)) seen.set(key, value)
  }
  return [...seen.values()]
}

function uniq(items: string[]): string[] {
  return [...new Set(items.map((s) => s.trim()).filter(Boolean))]
}

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(text)
    if (m) return m[1].trim()
  }
  return null
}

function extractList(text: string, re: RegExp): string[] {
  const out: string[] = []
  for (const m of text.matchAll(re)) {
    const line = m[1].split(/[.\n]/)[0].trim()
    if (line && line.length < 200) out.push(line)
  }
  return uniq(out).slice(0, 8)
}

function parseSize(description: string): number | null {
  const m = /\b(\d+(?:[.,]\d+)?)\s*(kb|mb|gb)\b/i.exec(description)
  if (!m) return null
  const n = Number.parseFloat(m[1].replace(',', '.'))
  const unit = m[2].toLowerCase()
  return Math.round(n * (unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : 1024 ** 3))
}

/**
 * Yoast publishes a sitemap index, so the crawler never has to guess at listing
 * pages: post-sitemap*.xml enumerates every post with its last-modified date,
 * which is also the cheapest way to know what changed since the last crawl.
 */
export function parseSitemapUrls(xml: string): { url: string; lastmod: string | null }[] {
  const out: { url: string; lastmod: string | null }[] = []
  for (const block of xml.split('<url>').slice(1)) {
    const url = /<loc>([^<]+)<\/loc>/.exec(block)?.[1]
    if (!url) continue
    out.push({ url: url.trim(), lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(block)?.[1]?.trim() ?? null })
  }
  return out
}

export function parseSitemapIndex(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()).filter((u) => /post-sitemap\d*\.xml$/i.test(u))
}

/** A post is a mod page when its URL is dated and its title carries a game tag. */
export function looksLikeModPost(url: string, title?: string): boolean {
  if (!/mixmods\.com\.br\/\d{4}\/\d{2}\//.test(url)) return false
  if (title && /^\[(sa|vc|iii|gta|samp|mta|re3|rw)\b/i.test(title)) return true
  return true
}

/**
 * The games Modão indexes today. MixMods also covers III, VC, Guitar Hero
 * and more; those live under their own category roots and are deliberately out
 * of scope until the app can manage more than one game.
 */
export const SA_ARCHIVES = ['/gta-sa/', '/gta-sa-de/'] as const

/**
 * Post links from a WordPress category archive page. Enumerating the archive
 * is what keeps the catalogue to San Andreas: the sitemap lists all 3,600
 * posts on the site with no way to tell which game they belong to, while
 * /gta-sa/ and /gta-sa-de/ list exactly the ones that matter.
 */
export function parseArchivePostLinks(html: string): string[] {
  const $ = cheerio.load(html)
  const links = $('a[href*="mixmods.com.br/20"]')
    .map((_, el) => $(el).attr('href') ?? '')
    .get()
    .filter((h) => /mixmods\.com\.br\/\d{4}\/\d{2}\/[^/]+\/?$/.test(h))
    .map((h) => h.replace(/[?#].*$/, ''))
  return [...new Set(links)]
}

/** The highest /page/N/ number linked from an archive page. */
export function parseArchiveLastPage(html: string): number {
  const pages = [...html.matchAll(/\/page\/(\d+)\//g)].map((m) => Number.parseInt(m[1], 10))
  return pages.length ? Math.max(...pages) : 1
}
