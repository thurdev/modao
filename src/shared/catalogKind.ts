/**
 * Telling a mod apart from a post about mods.
 *
 * MixMods is a blog as much as a catalogue: alongside three thousand mods it
 * carries news, interviews, myth-hunting articles and the site's own notices.
 * Indexed the same way, they fill the browse screen with entries that cannot be
 * installed, and a search for a car returns an article that mentions one.
 *
 * The decision is made from what the post IS, not from a keyword blocklist: a
 * post with no file to download, in a category the site uses for writing, is an
 * article. Anything that offers a download is a mod, whatever it is filed
 * under - that rule alone keeps the false positives near zero.
 */
export type CatalogKind = 'mod' | 'article' | 'internal'

/** Categories MixMods uses for writing rather than releasing. */
const ARTICLE_CATEGORIES =
  /^(curiosidades?|novidades?|artigos?|mitos e lendas|ca[çc]a ao tesouro|not[íi]cias?|entrevistas?|tutoriais|eventos?|opini[ãa]o|desabafo)$/i

/** Titles that announce a post rather than a release. */
const ARTICLE_TITLE =
  /^\s*(\[?(not[íi]cia|novidade|curiosidade|artigo|entrevista|opini[ãa]o|especial|retrospectiva)\]?\b|top \d+|por que |porque |como (funciona|era|foi)|a hist[óo]ria d)/i

/** Our own bookkeeping entries, which are not catalogue posts at all. */
const INTERNAL_CATEGORY = /^(adopted|adotado)$/i

export interface CatalogKindInput {
  title: string
  category: string
  /** Does any recorded version have a download link? */
  hasDownload: boolean
  /** Early access on the author's Patreon: a real mod, just not fetchable. */
  paywalled?: boolean
}

export function catalogKind(row: CatalogKindInput): CatalogKind {
  if (INTERNAL_CATEGORY.test(row.category ?? '')) return 'internal'
  // A file to download settles it. Paywalled releases have none by design and
  // are still mods.
  if (row.hasDownload || row.paywalled) return 'mod'
  if (ARTICLE_CATEGORIES.test((row.category ?? '').trim())) return 'article'
  if (ARTICLE_TITLE.test(row.title ?? '')) return 'article'
  // No download, no signal either way: a mod page whose link the crawler could
  // not read is far more likely than an article, and hiding a real mod is the
  // worse mistake.
  return 'mod'
}

export function isInstallable(row: CatalogKindInput): boolean {
  return catalogKind(row) === 'mod'
}
