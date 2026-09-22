/**
 * Builds the public mod index that ships in the repository.
 *
 *   npm run index:export -- --db "%APPDATA%\Modao\modao.db" --out index
 *
 * What this publishes, and what it deliberately does not:
 *
 * The index is a way to FIND someone else's work - title, author, which game,
 * category, version, the link to the original post, the link to the file, and a
 * short excerpt so a search result is readable. It is not a copy of that work.
 * The author's full post text stays on mixmods.com.br, where their images load
 * from, where their ads are, and where their name is. Modão fetches the full
 * post on demand when a user opens a mod, and caches it locally for that user.
 *
 * Nothing here mirrors a mod file. Paywalled early-access builds carry no
 * download link at all, only the author's page.
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { gamesOfMod, GAME_ORDER, gameDefinition, type GameKind } from '../src/shared/games'

interface Args {
  db: string
  out: string
  excerpt: number
}

function parseArgs(argv: string[]): Args {
  // Electron eats some command-line arguments before the app sees them, so the
  // environment is the reliable channel and flags are the convenience.
  const get = (name: string, fallback: string): string => {
    const fromEnv = process.env[`MODAO_INDEX_${name.toUpperCase()}`]
    if (fromEnv) return fromEnv
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
  }
  return {
    db: get('db', path.join(process.env['APPDATA'] ?? '', 'Modao', 'modao.db')),
    out: get('out', 'index'),
    excerpt: Number.parseInt(get('excerpt', '400'), 10)
  }
}

interface ModRow {
  id: number
  slug: string
  title: string
  author: string
  category: string
  source_url: string
  description: string
  images_json: string
  paywalled: number
  published_at: string | null
  updated_at: string | null
  games_json: string | null
}

interface VersionRow {
  mod_id: number
  version_label: string
  release_date: string | null
  download_url: string | null
  file_size: number | null
}

/** The first paragraph or so, with the markup and the boilerplate taken off. */
function excerptOf(description: string, max: number): string {
  const text = (description ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^(baixar|download)\b[:\s]*/i, '')
    .trim()
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  return (lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : `${cut.trimEnd()}…`).trim()
}

function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return null
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(args.db)) {
    console.error(`No database at ${args.db}. Pass --db with the path to modao.db.`)
    process.exit(1)
  }

  const db = new Database(args.db, { readonly: true })
  const mods = db.prepare('SELECT * FROM mod ORDER BY slug').all() as ModRow[]
  const versions = db.prepare('SELECT * FROM mod_version ORDER BY id').all() as VersionRow[]
  const versionsByMod = new Map<number, VersionRow[]>()
  for (const v of versions) {
    const list = versionsByMod.get(v.mod_id)
    if (list) list.push(v)
    else versionsByMod.set(v.mod_id, [v])
  }

  const perGame = new Map<GameKind, unknown[]>(GAME_ORDER.map((k) => [k, []]))
  let paywalled = 0
  const hosts = new Map<string, number>()

  for (const row of mods) {
    let games: GameKind[] = []
    try {
      games = JSON.parse(row.games_json || '[]') as GameKind[]
    } catch {
      games = []
    }
    if (games.length === 0) games = gamesOfMod(row.title, row.category ? [row.category] : []).games

    const own = versionsByMod.get(row.id) ?? []
    const latest = own[own.length - 1]
    const downloadUrl = row.paywalled ? null : (latest?.download_url ?? null)
    const host = hostOf(downloadUrl)
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1)
    if (row.paywalled) paywalled++

    let images: string[] = []
    try {
      images = (JSON.parse(row.images_json || '[]') as string[]).slice(0, 3)
    } catch {
      images = []
    }

    const entry = {
      slug: row.slug,
      title: row.title,
      author: row.author,
      games,
      category: row.category,
      // The link to the author's post. Everything about this entry belongs to them.
      sourceUrl: row.source_url,
      excerpt: excerptOf(row.description, args.excerpt),
      images,
      version: latest?.version_label ?? null,
      releaseDate: latest?.release_date ?? null,
      downloadUrl,
      downloadHost: host,
      fileSize: latest?.file_size ?? null,
      /** Early access on the author's Patreon: never fetched, never mirrored. */
      paywalled: !!row.paywalled,
      publishedAt: row.published_at,
      updatedAt: row.updated_at
    }

    for (const game of games) perGame.get(game)?.push(entry)
  }

  fs.mkdirSync(args.out, { recursive: true })
  const generatedAt = new Date().toISOString()
  const summary: Record<string, number> = {}

  for (const [kind, entries] of perGame) {
    if (entries.length === 0) continue
    const def = gameDefinition(kind)
    const file = path.join(args.out, `${kind}.json`)
    fs.writeFileSync(
      file,
      `${JSON.stringify(
        {
          format: 'modao-index',
          version: 1,
          game: { kind, name: def.name },
          generatedAt,
          source: 'https://www.mixmods.com.br/',
          note:
            'Discovery index: metadata, an excerpt and a link to the original post. The full post, the images and ' +
            'the files belong to their authors and stay on mixmods.com.br. Nothing here mirrors a mod file.',
          count: entries.length,
          mods: entries
        },
        null,
        1
      )}\n`
    )
    summary[kind] = entries.length
    console.log(`${file}  ${entries.length} mod(s)`)
  }

  fs.writeFileSync(
    path.join(args.out, 'index.json'),
    `${JSON.stringify({ format: 'modao-index-manifest', version: 1, generatedAt, games: summary, paywalled }, null, 1)}\n`
  )

  console.log(`\n${mods.length} mod(s) read from ${args.db}`)
  console.log(`paywalled (no download link published): ${paywalled}`)
  console.log(
    'download hosts: ' +
      [...hosts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([h, n]) => `${h}(${n})`)
        .join(' ')
  )
}

main()
