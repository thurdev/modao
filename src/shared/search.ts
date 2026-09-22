/**
 * Ranking a catalogue search.
 *
 * Filtering alone is not searching: typing "vehfuncs" against three thousand
 * mods and getting them in rating order means hunting for the one you named.
 * What matters is how well a row answers the words typed, and the title
 * answering them beats a description mentioning them in passing.
 *
 * Two things this has to get right for a Brazilian catalogue: accents are
 * optional when typing ("animacoes" must find "Animações"), and MixMods titles
 * carry a game tag - "[SA] VehFuncs v2.5.5" - which is noise when matching.
 */

/** Accent-free, case-free, punctuation-free. */
export function foldText(value: string): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9+ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The title without its "[SA]" / "[III|VC|SA]" prefix. */
export function strippedTitle(title: string): string {
  return (title ?? '').replace(/^\s*\[[^\]]{1,30}\]\s*/, '')
}

export interface Searchable {
  title: string
  slug: string
  author: string
  category: string
  description: string
}

/**
 * How well a row answers the query, higher first. 0 means it does not.
 *
 * Every term has to appear somewhere, otherwise typing two words would widen
 * the result instead of narrowing it.
 */
export function relevance(row: Searchable, query: string): number {
  const q = foldText(query)
  if (!q) return 1
  const terms = q.split(' ').filter(Boolean)
  if (terms.length === 0) return 1

  const title = foldText(strippedTitle(row.title))
  const slug = foldText(row.slug)
  const author = foldText(row.author)
  const category = foldText(row.category)
  const description = foldText(row.description)
  const haystack = `${title} ${slug} ${author} ${category} ${description}`

  if (!terms.every((t) => haystack.includes(t))) return 0

  let score = 0
  if (title === q) score += 1000
  if (title.startsWith(q)) score += 500
  // A whole word in the title is what someone typing a mod name means.
  if (new RegExp(`(^| )${escapeRegExp(q)}( |$)`).test(title)) score += 300
  if (title.includes(q)) score += 200
  if (slug.includes(q.replace(/ /g, '-')) || slug.includes(q.replace(/ /g, ''))) score += 150
  if (author === q || author.startsWith(q)) score += 120
  if (author.includes(q)) score += 60
  if (category.includes(q)) score += 40
  if (description.includes(q)) score += 15

  for (const term of terms) {
    if (title.includes(term)) score += 40
    if (slug.includes(term)) score += 20
    if (author.includes(term)) score += 15
    if (description.includes(term)) score += 3
  }
  // A short title that matches is a closer answer than a long one that also does.
  score += Math.max(0, 30 - Math.floor(title.length / 4))
  return score
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
