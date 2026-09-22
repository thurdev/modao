import path from 'node:path'
import fsp from 'node:fs/promises'
import type {
  DestinationClass,
  PlanWarning,
  PlannedFile,
  ReadmeParse,
  VariantGroup,
  VariantOption
} from '@shared/types'
import { walk } from '../util/fsx'
import { findVariantHint } from './readme'

export interface OverlayMatch {
  installId: number
  title: string
  /** The full game-relative path this file would replace inside another mod. */
  targetRelative: string
}

export interface ClassifyContext {
  /** '' when .asi loads from the game root, 'scripts' when it loads from scripts\. */
  asiRelative: string
  readmes: ReadmeParse[]
  /** Name used when the archive is a bare pile of assets with no folder of its own. */
  fallbackName: string
  /** Looks a file up in the provides index so overlays can be detected. */
  findOverlayTarget?: (relPathInsideArchive: string, basename: string) => OverlayMatch | null
}

export interface ClassifyResult {
  files: PlannedFile[]
  variants: VariantGroup[]
  warnings: PlanWarning[]
  /** Documentation kept with the install record but never copied into the game. */
  docs: string[]
}

const MOD_SUBFOLDERS = new Set([
  'models',
  'data',
  'cleo',
  'anim',
  'text',
  'audio',
  'movies',
  'effects',
  'sfx',
  'streams',
  'fonts'
])

const ASSET_EXT = /\.(dff|txd|ifp|col|ide|ipl|dat|img|fxp|cfg|wav|mp3|bik|rrr|ifs)$/i
const DOC_EXT = /\.(txt|nfo|pdf|url|html|htm|jpg|jpeg|png|gif|webp|bmp|md|doc|docx)$/i
const ROOT_FILE_NAMES = new Set([
  'modloader.asi',
  'cleo.asi',
  'vorbisfile.dll',
  'vorbishooked.dll',
  'dinput8.dll',
  'dsound.dll',
  'd3d9.dll',
  'bass.dll',
  'modloader.ini'
])

interface Node {
  name: string
  rel: string
  abs: string
  isDir: boolean
  children: Node[]
  size: number
  fileCount: number
}

async function buildTree(root: string): Promise<Node> {
  async function rec(abs: string, rel: string, name: string): Promise<Node> {
    const st = await fsp.stat(abs)
    if (!st.isDirectory()) {
      return { name, rel, abs, isDir: false, children: [], size: st.size, fileCount: 1 }
    }
    const entries = await fsp.readdir(abs, { withFileTypes: true })
    const children: Node[] = []
    for (const e of entries) {
      if (e.name.toLowerCase() === '__macosx' || e.name.startsWith('.')) continue
      children.push(await rec(path.join(abs, e.name), rel ? `${rel}/${e.name}` : e.name, e.name))
    }
    return {
      name,
      rel,
      abs,
      isDir: true,
      children,
      size: children.reduce((a, c) => a + c.size, 0),
      fileCount: children.reduce((a, c) => a + c.fileCount, 0)
    }
  }
  return rec(root, '', path.basename(root))
}

// ---------------------------------------------------------------------------
// Variants: mutually exclusive sibling folders the user must choose between
// ---------------------------------------------------------------------------

interface VariantRule {
  kind: VariantGroup['kind']
  test: (name: string) => boolean
  question: string
}

const VARIANT_RULES: VariantRule[] = [
  {
    kind: 'resolution',
    test: (n) => /(^|\W)(1k|2k|4k|8k|512|1024|2048|4096)(\W|$)/i.test(n),
    question: 'Which resolution do you want to install?'
  },
  {
    kind: 'language',
    test: (n) => /^(pt|pt-?br|br|en|eng|es|esp|ru|rus|fr|de|it|pl)(\W|$)/i.test(n.trim()) || /\((pt|en|es|ru)\)/i.test(n),
    question: 'Which language do you want to install?'
  },
  {
    kind: 'game',
    test: (n) => /^(iii|gta3|vc|vice ?city|sa|sa-?mp|samp|mta)(\W|$)/i.test(n.replace(/[()]/g, '').trim()),
    question: 'Which game or multiplayer variant is this for?'
  },
  {
    kind: 'extra',
    test: (n) => /\((alt|alternative|translations?|bonus|extra|opcional|optional)/i.test(n),
    question: 'This mod ships optional extras - pick the one you want:'
  },
  {
    kind: 'style',
    test: (n) => /^\(.+\)$/.test(n.trim()),
    question: 'This mod ships mutually exclusive versions - pick one:'
  },
  {
    kind: 'generic',
    test: (n) => /(definitive|version|vers[aã]o|escolha|choose|option)/i.test(n),
    question: 'Pick the version to install:'
  }
]

function detectVariantGroups(root: Node, readmes: ReadmeParse[]): VariantGroup[] {
  const groups: VariantGroup[] = []

  function consider(parent: Node): void {
    const dirs = parent.children.filter((c) => c.isDir && !MOD_SUBFOLDERS.has(c.name.toLowerCase()))
    if (dirs.length >= 2) {
      const rule = VARIANT_RULES.find((r) => dirs.filter((d) => r.test(d.name)).length >= 2)
      if (rule) {
        const matching = dirs.filter((d) => rule.test(d.name))
        const chosen = matching.length === dirs.length ? dirs : matching.length >= 2 ? matching : dirs
        const options: VariantOption[] = chosen.map((d) => ({
          id: d.rel,
          path: d.rel,
          label: d.name,
          fileCount: d.fileCount,
          size: d.size,
          recommended: false,
          note: null
        }))
        const hint = findVariantHint(
          readmes,
          options.map((o) => o.label)
        )
        if (hint) {
          for (const o of options) {
            if (hint.toLowerCase().includes(o.label.toLowerCase())) {
              o.recommended = /recomend|recommend|ideal|melhor|best/i.test(hint)
              o.note = hint
            }
          }
        }
        groups.push({
          id: `variant:${parent.rel || '<root>'}`,
          parentPath: parent.rel,
          kind: rule.kind,
          question: rule.question,
          hint,
          options
        })
        return // never descend into a group's own branches
      }
    }
    for (const c of parent.children) if (c.isDir) consider(c)
  }

  consider(root)
  return groups
}

// ---------------------------------------------------------------------------
// Classification into destination classes
// ---------------------------------------------------------------------------

export async function classifyTree(
  root: string,
  ctx: ClassifyContext,
  selections: Record<string, string> = {}
): Promise<ClassifyResult> {
  const tree = await buildTree(root)
  const variants = detectVariantGroups(tree, ctx.readmes)
  const warnings: PlanWarning[] = []
  const docs: string[] = []
  const files: PlannedFile[] = []

  const excluded: string[] = []
  const chosenPaths = new Set<string>()
  for (const g of variants) {
    const chosen = selections[g.id]
    for (const o of g.options) {
      if (o.id === chosen) chosenPaths.add(o.path)
      else excluded.push(o.path)
    }
    if (!chosen) {
      warnings.push({
        severity: 'warn',
        code: 'variant-unresolved',
        message: g.question,
        detail: g.options.map((o) => o.label).join('  |  ')
      })
    }
  }
  const isExcluded = (rel: string): boolean => excluded.some((e) => e && (rel === e || rel.startsWith(`${e}/`)))

  const readmeFolders = new Map<string, DestinationClass>()
  for (const r of ctx.readmes) {
    for (const i of r.instructions) if (i.folder) readmeFolders.set(i.folder.toLowerCase(), i.destination)
  }
  const readmeSaysAsi = ctx.readmes.some((r) => r.instructions.some((i) => i.destination === 'asi-plugin'))
  const asiPrefix = ctx.asiRelative

  function makeFile(sourceRel: string, targetRelative: string, destination: DestinationClass, size: number): PlannedFile {
    const overlay = destination === 'modloader-folder' ? null : ctx.findOverlayTarget?.(sourceRel, path.basename(sourceRel)) ?? null
    if (overlay) {
      return {
        sourcePath: sourceRel,
        targetRelative: overlay.targetRelative,
        destination: 'overlay',
        size,
        sha256: '',
        overwrites: true,
        overwritesMod: overlay.title
      }
    }
    return {
      sourcePath: sourceRel,
      targetRelative: targetRelative.replace(/\/+/g, '/').replace(/^\//, ''),
      destination,
      size,
      sha256: '',
      overwrites: false,
      overwritesMod: null
    }
  }

  /** Emits every file under a directory into one destination prefix. */
  async function emitDir(node: Node, destination: DestinationClass, targetPrefix: string): Promise<void> {
    for (const f of await walk(node.abs)) {
      const rel = node.rel ? `${node.rel}/${f.rel}` : f.rel
      if (isExcluded(rel)) continue
      if (/^(readme|leiame)/i.test(path.basename(f.rel)) && DOC_EXT.test(f.rel)) docs.push(rel)
      files.push(makeFile(rel, `${targetPrefix}/${f.rel}`, destination, f.size))
    }
  }

  async function handleNode(node: Node, nameHint: string): Promise<void> {
    if (isExcluded(node.rel)) return
    const lower = node.name.toLowerCase()

    if (!node.isDir) {
      if (/\.asi$/i.test(lower)) {
        files.push(makeFile(node.rel, joinTarget(asiPrefix, node.name), 'asi-plugin', node.size))
      } else if (/\.cleo\d?$/i.test(lower)) {
        files.push(makeFile(node.rel, `cleo/${node.name}`, 'cleo-plugin', node.size))
      } else if (/\.(cs|cm|cs4|cs5)$/i.test(lower)) {
        files.push(makeFile(node.rel, `cleo/${node.name}`, 'cleo-script', node.size))
      } else if (DOC_EXT.test(lower)) {
        docs.push(node.rel)
      } else if (ROOT_FILE_NAMES.has(lower) || /\.(dll|exe|ini)$/i.test(lower)) {
        files.push(makeFile(node.rel, node.name, 'root-file', node.size))
      } else if (ASSET_EXT.test(lower)) {
        files.push(makeFile(node.rel, `modloader/${nameHint}/${node.name}`, 'modloader-folder', node.size))
      } else {
        files.push(makeFile(node.rel, `modloader/${nameHint}/${node.name}`, 'unknown', node.size))
        warnings.push({
          severity: 'warn',
          code: 'unclassified',
          message: `Could not classify ${node.name}`,
          detail: 'Pick its destination manually before installing.'
        })
      }
      return
    }

    // A chosen variant folder is a passthrough: its contents are the mod.
    if (chosenPaths.has(node.rel)) {
      const hint = variantNameHint(node, nameHint)
      if (holdsModContent(node)) {
        await emitDir(node, 'modloader-folder', `modloader/${hint}`)
        return
      }
      for (const c of node.children) await handleNode(c, hint)
      return
    }

    // A vanilla folder name (models/, data/, anim/, …) is part of a mod, not a
    // mod of its own: wrap it under the mod name rather than creating
    // modloader\models.
    if (MOD_SUBFOLDERS.has(lower) && node.rel !== 'cleo' && node.rel !== 'scripts') {
      await emitDir(node, 'modloader-folder', `modloader/${nameHint}/${node.name}`)
      return
    }

    if (lower === 'modloader') {
      for (const mod of node.children) {
        if (isExcluded(mod.rel)) continue
        if (mod.isDir) await emitDir(mod, 'modloader-folder', `modloader/${mod.name}`)
        else files.push(makeFile(mod.rel, `modloader/${mod.name}`, 'modloader-folder', mod.size))
      }
      return
    }

    if (lower === 'cleo' && node.rel === lower) {
      for (const f of await walk(node.abs)) {
        const rel = `${node.rel}/${f.rel}`
        if (isExcluded(rel)) continue
        const dest: DestinationClass = /\.cleo\d?$/i.test(f.rel) ? 'cleo-plugin' : 'cleo-script'
        files.push(makeFile(rel, `cleo/${f.rel}`, dest, f.size))
      }
      return
    }

    if (lower === 'scripts' && node.rel === lower) {
      for (const f of await walk(node.abs)) {
        const rel = `${node.rel}/${f.rel}`
        if (isExcluded(rel)) continue
        const isAsi = /\.asi$/i.test(f.rel)
        files.push(
          makeFile(rel, isAsi ? joinTarget(asiPrefix, f.rel) : `scripts/${f.rel}`, isAsi ? 'asi-plugin' : 'root-file', f.size)
        )
      }
      return
    }

    const readmeDest = readmeFolders.get(lower)
    if (readmeDest && readmeDest !== 'modloader-folder') {
      await emitDir(node, readmeDest, destinationPrefix(readmeDest, asiPrefix))
      return
    }
    await emitDir(node, 'modloader-folder', `modloader/${node.name}`)
  }

  // A root that is itself a Mod Loader folder (models/, data/, loose assets)
  // installs as a single mod named after the archive.
  const rootLooksLikeMod = tree.children.some(
    (c) => (c.isDir && MOD_SUBFOLDERS.has(c.name.toLowerCase())) || (!c.isDir && ASSET_EXT.test(c.name))
  )
  const rootHasStructure = tree.children.some(
    (c) => c.isDir && ['modloader', 'cleo', 'scripts'].includes(c.name.toLowerCase())
  )

  if (rootLooksLikeMod && !rootHasStructure) {
    await emitDir(tree, 'modloader-folder', `modloader/${ctx.fallbackName}`)
    for (const f of files) {
      if (/^(readme|leiame)/i.test(path.basename(f.sourcePath))) docs.push(f.sourcePath)
    }
  } else {
    for (const child of tree.children) await handleNode(child, ctx.fallbackName)
  }

  if (readmeSaysAsi && !files.some((f) => f.destination === 'asi-plugin')) {
    warnings.push({
      severity: 'info',
      code: 'readme-asi-mismatch',
      message: 'The readme mentions an .asi but no .asi file was found in the archive.'
    })
  }
  if (files.length === 0) {
    warnings.push({
      severity: 'error',
      code: 'empty',
      message: 'Nothing installable was found in this archive.',
      detail: 'It may be documentation only, or everything belongs to a variant you have not chosen yet.'
    })
  }

  return { files: files.filter((f) => !DOC_EXT.test(f.sourcePath) || f.destination === 'root-file'), variants, warnings, docs }
}

/** True when a folder is itself a Mod Loader mod rather than a container of mods. */
function holdsModContent(node: Node): boolean {
  return node.children.some(
    (c) => (c.isDir && MOD_SUBFOLDERS.has(c.name.toLowerCase())) || (!c.isDir && ASSET_EXT.test(c.name))
  )
}

/**
 * A descriptive variant folder ("Loadscreens 2K Definitive") makes a good mod
 * folder name. An uninformative one ("(original)", "PT", "4K") does not, so
 * the archive name is used instead.
 */
function variantNameHint(node: Node, fallback: string): string {
  const name = node.name.trim()
  if (/^\(.*\)$/.test(name)) return fallback
  if (/^(pt|pt-?br|br|en|eng|es|esp|ru|rus|fr|de|it|pl|sa|vc|iii|samp)$/i.test(name)) return fallback
  if (/^\d?[1-8]k$/i.test(name)) return fallback
  return name
}

function destinationPrefix(dest: DestinationClass, asiPrefix: string): string {
  switch (dest) {
    case 'asi-plugin':
      return asiPrefix
    case 'cleo-plugin':
    case 'cleo-script':
      return 'cleo'
    case 'root-file':
      return ''
    default:
      return 'modloader'
  }
}

function joinTarget(prefix: string, rel: string): string {
  return prefix ? `${prefix}/${rel}` : rel
}
