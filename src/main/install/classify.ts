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
/** Always documentation, wherever it sits. */
const DOC_EXT = /\.(txt|nfo|pdf|url|html|htm|md|doc|docx)$/i
/**
 * Documentation only at the top of an archive. Nested, an image is a mod's own
 * file: VHud's blips are .png, and filtering them out as "documentation" left
 * the plugin installed without the icons it draws.
 */
const IMAGE_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|tga)$/i

function isDocumentation(rel: string): boolean {
  if (DOC_EXT.test(rel)) return true
  const top = !rel.includes('/')
  return top && IMAGE_EXT.test(rel)
}
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

/**
 * Files no mod may ever write over.
 *
 * The Essentials pack ships its own gta_sa.exe. Installed as a root file it
 * replaced the user's executable, and because it was then recorded as one of
 * the pack's files, disabling the pack deleted the game's executable outright -
 * along with modloader.asi and CLEO.asi, which the same pack also ships.
 *
 * The rule the project started with says it plainly: never modify gta_sa.exe.
 * That has to hold for "replace it with a different copy" too, however
 * well-meant the copy is. The file is kept in the store, named in a warning,
 * and left for the user to place deliberately if they really want it.
 */
const GAME_EXECUTABLES = /^(gta_sa|gta3|gta-vc|gta_vc|sanandreas|playgtasa|gta_sa_compact)\.exe$/i

function isGameExecutable(name: string): boolean {
  return GAME_EXECUTABLES.test(path.basename(name))
}

/**
 * An .asi that owns resources must ship WITH them.
 *
 * Mod Loader's std.asi loads a plugin from inside a mod folder and makes that
 * folder the plugin's working directory. A plugin resolves its own files
 * relative to where it sits, so lifting VHud.asi out to scripts\ while blips\,
 * map\, data\ and fonts\ stay in modloader\VHud\ leaves the mod inert - Mod
 * Loader logged "No handler or callme" for every one of its ~250 files and the
 * HUD never appeared.
 *
 * These are the loaders that genuinely belong in the ASI directory: they have
 * no resources of their own, and several of them must load before Mod Loader
 * itself does.
 */
const BARE_ASI_LOADERS = [
  /^modloader\.asi$/i,
  /^cleo\.asi$/i,
  /^silentpatch/i,
  /^.*limitadjuster.*$/i,
  /^iii\.vc\.sa\./i,
  /^ultimateasiloader/i,
  /^widescreenfix/i,
  /^gtasa?\.?fusionfix/i
]

/** Files that say nothing about whether an .asi owns the folder it sits in. */
function isIncidental(node: Node): boolean {
  return !node.isDir && (DOC_EXT.test(node.name) || IMAGE_EXT.test(node.name) || /^(thumbs\.db|desktop\.ini)$/i.test(node.name))
}

/**
 * The resources an .asi at this level would own: anything beside it that is not
 * documentation, another loader, or a folder that is a mod in its own right.
 */
const GAME_LAYOUT_FOLDERS = new Set(['modloader', 'cleo', 'scripts', 'game', 'gta sa', 'gta san andreas'])

function asiSiblings(parent: Node, asi: Node): Node[] {
  const stem = asi.name.replace(/\.asi$/i, '').toLowerCase()
  return parent.children.filter((c) => {
    if (c === asi || isIncidental(c)) return false
    // modloader\, cleo\ and scripts\ describe where things go in the game, not
    // what belongs to this plugin: an archive shipping both is laying out the
    // install, and swallowing them would bury a whole mod pack inside one mod.
    if (c.isDir && GAME_LAYOUT_FOLDERS.has(c.name.toLowerCase())) return false
    if (!c.isDir && /\.asi$/i.test(c.name)) return false
    // A folder named after the plugin is unambiguously its own.
    if (c.isDir && c.name.toLowerCase() === stem) return true
    if (c.isDir) return true
    return ASSET_EXT.test(c.name) || /\.(ini|json|dat|cfg|fxc|fx|txt)$/i.test(c.name)
  })
}

/** True when this .asi brings its own files and must not be separated from them. */
function asiOwnsResources(parent: Node, asi: Node): boolean {
  if (BARE_ASI_LOADERS.some((re) => re.test(asi.name))) return false
  const siblings = asiSiblings(parent, asi)
  if (siblings.length === 0) return false
  // An .asi plus a single .ini is a configured plugin, not a resource bundle,
  // but keeping the pair together still costs nothing and keeps the profile
  // owning both.
  return true
}

/** The mod folder name an .asi bundle should take. */
function asiBundleName(parent: Node, asi: Node, fallback: string): string {
  const stem = asi.name.replace(/\.asi$/i, '')
  const namedFolder = parent.children.find((c) => c.isDir && c.name.toLowerCase() === stem.toLowerCase())
  if (namedFolder) return stem
  if (parent.rel) return parent.name
  return stem || fallback
}

/**
 * Folders that are add-ons to a mod rather than mods of their own.
 *
 * "Extra\GTA UG\VHud\data" is an optional override for VHud's own data. Mod
 * Loader has no idea what to do with it on its own and ignores it, so
 * installing it as a separate mod folder produces a mod that does nothing.
 */
const ADDON_FOLDER = /^\(?(extras?|bonus|optional|opcionais?|opcional|translations?|tradu[cç][aã]o|tradu[cç][oõ]es|alt|alternativ[eo]s?)\)?$/i

function isAddonFolder(name: string): boolean {
  return ADDON_FOLDER.test(name.trim())
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
  },
  {
    // Proper Shaders ships "(0a- lowest)" … "(5 - very high)": a quality ladder
    // where each folder holds the same ProperShaders.ini with different values.
    kind: 'style',
    test: (n) => /^\(?\s*\d+[a-z]?\s*[-–—]/i.test(n.trim()) || /(lowest|very low|low|medium|high|very high|ultra|max)/i.test(n),
    question: 'This mod ships quality presets - pick one:'
  }
]

/** The set of file names directly inside a folder, lowercased. */
function fileNameSet(node: Node): string {
  return node.children
    .filter((c) => !c.isDir)
    .map((c) => c.name.toLowerCase())
    .sort()
    .join('|')
}

/**
 * Sibling folders holding the SAME file names are alternatives, whatever they
 * are called. Proper Shaders' nine quality folders each hold one
 * ProperShaders.ini; installing all nine put nine copies of the same file into
 * the game and Mod Loader logged "No handler or callme for file
 * ProperShaders.ini" nine times over.
 */
function sameContentGroup(dirs: Node[]): Node[] | null {
  const bySet = new Map<string, Node[]>()
  for (const d of dirs) {
    const key = fileNameSet(d)
    if (!key) continue
    const list = bySet.get(key)
    if (list) list.push(d)
    else bySet.set(key, [d])
  }
  for (const [, list] of bySet) {
    if (list.length >= 2 && list.length === dirs.filter((d) => fileNameSet(d)).length) return list
  }
  return null
}

function detectVariantGroups(root: Node, readmes: ReadmeParse[]): VariantGroup[] {
  const groups: VariantGroup[] = []

  function consider(parent: Node): void {
    const dirs = parent.children.filter(
      (c) => c.isDir && !MOD_SUBFOLDERS.has(c.name.toLowerCase()) && !isAddonFolder(c.name)
    )
    if (dirs.length >= 2) {
      const identical = sameContentGroup(dirs)
      const rule =
        VARIANT_RULES.find((r) => dirs.filter((d) => r.test(d.name)).length >= 2) ??
        (identical
          ? { kind: 'style' as const, test: () => true, question: 'These are alternatives - pick the one to install:' }
          : undefined)
      if (rule) {
        const matching = identical ?? dirs.filter((d) => rule.test(d.name))
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
        // Mod authors mark their own pick in the folder name.
        for (const o of options) {
          if (/\b(default|padr[aã]o|recomendad[oa])\b/i.test(o.label)) {
            o.recommended = true
            o.note = o.note ?? 'The mod author marked this one as the default.'
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

/**
 * Mod Loader mechanics that decide whether a correctly-copied mod actually
 * works. Each of these is a documented rule of the loader, and each one has a
 * failure that looks like a broken mod rather than a misplaced file.
 */

/** A .txd in a folder literally named "txd" is treated as a SPRITE texture. */
const SPRITE_FOLDER = /^txd$/i

/**
 * A CLEO script inside a mod keeps its sidecar files only if it sits in that
 * mod's own cleo\ folder. Dropped into the game's cleo\ instead, the script
 * loads and its data files do not.
 */
function cleoTargetInsideMod(modName: string, rel: string): string {
  const base = rel.split('/').pop() as string
  return `modloader/${modName}/cleo/${base}`
}

/** A .col needs a .txt telling Mod Loader to load it; raising the COL limit does not. */
function colHasLoader(files: { sourcePath: string }[], colPath: string): boolean {
  const stem = (colPath.split('/').pop() ?? '').replace(/\.col$/i, '').toLowerCase()
  return files.some((f) => {
    if (!/\.txt$/i.test(f.sourcePath)) return false
    const name = (f.sourcePath.split('/').pop() ?? '').toLowerCase()
    return name.includes(stem) || name === 'colfile.txt'
  })
}

/** Clothes belong in a folder named after the archive they replace. */
const CLOTHES_HINT = /(player\.img|clothes|roupas?)/i

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
      const target = `${targetPrefix}/${f.rel}`
      // An executable that would land on the game's own is refused wherever it
      // came from in the archive, not only at the top level.
      if (isGameExecutable(target) && !target.includes('modloader/')) {
        docs.push(rel)
        warnings.push({
          severity: 'warn',
          code: 'game-executable',
          message: `${path.basename(target)} is the game's own executable, so it was left out of the install.`,
          detail: 'Modão never replaces it.'
        })
        continue
      }
      files.push(makeFile(rel, target, destination, f.size))
    }
  }

  async function handleNode(node: Node, nameHint: string): Promise<void> {
    if (isExcluded(node.rel)) return
    const lower = node.name.toLowerCase()

    if (!node.isDir) {
      if (/\.asi$/i.test(lower)) {
        // Rule 1: a plugin that owns resources is handled with them, by the
        // folder walk below - reaching here means it is a bare loader.
        files.push(makeFile(node.rel, joinTarget(asiPrefix, node.name), 'asi-plugin', node.size))
      } else if (/\.cleo\d?$/i.test(lower)) {
        files.push(makeFile(node.rel, `cleo/${node.name}`, 'cleo-plugin', node.size))
      } else if (/\.(cs|cm|cs4|cs5)$/i.test(lower)) {
        files.push(makeFile(node.rel, `cleo/${node.name}`, 'cleo-script', node.size))
      } else if (isDocumentation(node.rel)) {
        docs.push(node.rel)
      } else if (isGameExecutable(node.name)) {
        // Never over the game's own executable, whatever the archive intends.
        docs.push(node.rel)
        warnings.push({
          severity: 'warn',
          code: 'game-executable',
          message: `${node.name} is the game's own executable, so it was left out of the install.`,
          detail:
            'Modão never replaces it. If you meant to swap your executable - for a downgrade, or a patched build - ' +
            'copy it in yourself, with the game closed and a copy of the original kept.'
        })
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

    // Rule 3: an extras/translations/optional folder is an add-on to the mod
    // beside it, not a mod. Installed on its own, Mod Loader ignores it.
    if (isAddonFolder(node.name)) {
      warnings.push({
        severity: 'info',
        code: 'addon-folder',
        message: `"${node.name}" holds optional extras for this mod, not a mod of its own.`,
        detail:
          'Modão leaves it out of the install. Its files replace files inside the mod they belong to, ' +
          'so installing it as a separate folder would make Mod Loader ignore it.'
      })
      for (const f of await walk(node.abs)) docs.push(node.rel ? `${node.rel}/${f.rel}` : f.rel)
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
      // An archive that ships scripts\<Plugin>.asi alongside modloader\<Plugin>\
      // is describing the game's layout, not the plugin's needs: Mod Loader
      // still wants the two together. Those are rejoined by emitAsiBundles.
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
      // The readme says this folder goes somewhere other than modloader\ - but
      // never at the cost of separating a plugin from its own files.
      const ownsResources = node.children.some((c) => !c.isDir && /\.asi$/i.test(c.name) && asiOwnsResources(node, c))
      if (!ownsResources) {
        await emitDir(node, readmeDest, destinationPrefix(readmeDest, asiPrefix))
        return
      }
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

  /**
   * Rule 1, applied to a whole directory level: if an .asi here owns resources,
   * it and they become one mod folder. Returns the paths that were consumed so
   * the ordinary walk skips them.
   */
  async function emitAsiBundles(parent: Node, fallback: string): Promise<Set<string>> {
    const consumed = new Set<string>()
    const asis = parent.children.filter((c) => !c.isDir && /\.asi$/i.test(c.name))
    for (const asi of asis) {
      if (isExcluded(asi.rel) || !asiOwnsResources(parent, asi)) continue
      const name = asiBundleName(parent, asi, fallback)
      const siblings = asiSiblings(parent, asi)
      const namedFolder = siblings.find((c) => c.isDir && c.name.toLowerCase() === name.toLowerCase())

      files.push(makeFile(asi.rel, `modloader/${name}/${asi.name}`, 'modloader-folder', asi.size))
      consumed.add(asi.rel)

      if (namedFolder) {
        // <Name>.asi beside <Name>\: the folder IS the plugin's working directory.
        await emitDir(namedFolder, 'modloader-folder', `modloader/${name}`)
        consumed.add(namedFolder.rel)
      } else {
        for (const sib of siblings) {
          if (isExcluded(sib.rel) || isAddonFolder(sib.name)) continue
          if (sib.isDir) await emitDir(sib, 'modloader-folder', `modloader/${name}/${sib.name}`)
          else files.push(makeFile(sib.rel, `modloader/${name}/${sib.name}`, 'modloader-folder', sib.size))
          consumed.add(sib.rel)
        }
      }
      warnings.push({
        severity: 'info',
        code: 'asi-bundle',
        message: `${asi.name} was kept with its own files in modloader\\${name}.`,
        detail:
          'Mod Loader runs a plugin from inside its mod folder, and the plugin looks for its files there. ' +
          'Separating them is what makes a mod install without doing anything.'
      })
    }
    return consumed
  }

  /**
   * Rule 1 across folders: an archive that ships the game's own layout -
   * scripts\<Plugin>.asi next to modloader\<Plugin>\ - is describing where
   * files go in a hand install, not what the plugin needs. Mod Loader still
   * wants the two together, so the .asi is moved into the mod folder that
   * carries its name.
   */
  function rejoinSplitAsi(): void {
    const asiFiles = files.filter((f) => f.destination === 'asi-plugin')
    for (const asi of asiFiles) {
      const stem = path.basename(asi.targetRelative).replace(/\.asi$/i, '').toLowerCase()
      const home = files.find(
        (f) =>
          f.destination === 'modloader-folder' &&
          f.targetRelative.toLowerCase().startsWith(`modloader/${stem}/`)
      )
      if (!home) continue
      const folder = home.targetRelative.split('/').slice(0, 2).join('/')
      asi.targetRelative = `${folder}/${path.basename(asi.targetRelative)}`
      asi.destination = 'modloader-folder'
      warnings.push({
        severity: 'info',
        code: 'asi-split',
        message: `${path.basename(asi.targetRelative)} was moved in beside its own files.`,
        detail:
          `The archive ships it separately from ${folder}\\, but Mod Loader runs a plugin from inside its mod ` +
          'folder and the plugin looks for its files there. Apart, the mod installs and does nothing.'
      })
    }
  }

  if (rootLooksLikeMod && !rootHasStructure) {
    await emitDir(tree, 'modloader-folder', `modloader/${ctx.fallbackName}`)
    for (const f of files) {
      if (/^(readme|leiame)/i.test(path.basename(f.sourcePath))) docs.push(f.sourcePath)
    }
  } else {
    const consumed = await emitAsiBundles(tree, ctx.fallbackName)
    for (const child of tree.children) {
      if (consumed.has(child.rel)) continue
      await handleNode(child, ctx.fallbackName)
    }
    rejoinSplitAsi()
  }

  // Mechanics Mod Loader enforces, checked once the whole plan is known.
  for (const f of files) {
    const target = f.targetRelative.toLowerCase()

    // A sprite folder is a promise about what is in it.
    if (/\.txd$/i.test(target) && target.split('/').some((seg) => SPRITE_FOLDER.test(seg))) {
      const hasModels = files.some((other) => /\.dff$/i.test(other.targetRelative))
      if (hasModels) {
        warnings.push({
          severity: 'warn',
          code: 'txd-sprite-folder',
          message: `${path.basename(f.targetRelative)} is in a folder named "txd", which Mod Loader treats as sprites.`,
          detail:
            'Vehicle, ped, weapon and map textures in a folder called "txd" are loaded as sprite textures and render ' +
            'wrongly or not at all. Only HUD and menu sprites belong there.'
        })
        break
      }
    }
  }

  for (const f of files) {
    if (!/\.col$/i.test(f.sourcePath)) continue
    if (colHasLoader(files, f.sourcePath)) continue
    warnings.push({
      severity: 'info',
      code: 'col-without-loader',
      message: `${path.basename(f.sourcePath)} has no .txt telling Mod Loader to load it.`,
      detail:
        'Ship a .txt beside it containing "COLFILE 0 path/to.col". Raising the game\'s COL limit instead is what ' +
        'produces the crash at 0x015632B0.'
    })
    break
  }

  const clothes = files.filter((f) => CLOTHES_HINT.test(f.sourcePath) && /\.(dff|txd)$/i.test(f.sourcePath))
  if (clothes.length > 0 && !files.some((f) => /player\.img/i.test(f.targetRelative))) {
    warnings.push({
      severity: 'info',
      code: 'clothes-folder',
      message: 'Clothing models have to sit in a folder named "player.img".',
      detail: 'Mod Loader routes a mod folder called player.img into the clothes archive; any other name is ignored.'
    })
  }

  // "Load first" is about .asi order, which is alphabetical from the mod folder
  // name - not about priority, which only decides file conflicts.
  const wantsFirst = ctx.readmes.some((r) => /(carregar|load)\s+(primeiro|first|antes)/i.test(r.raw))
  if (wantsFirst && files.some((f) => /\.asi$/i.test(f.targetRelative))) {
    warnings.push({
      severity: 'info',
      code: 'asi-load-order',
      message: 'The readme says this has to load before other plugins.',
      detail:
        'Mod Loader loads .asi plugins in alphabetical order of their mod folder. Prefixing the folder with "$" ' +
        'makes it load first. Priority does not affect load order - it only decides who wins a duplicated file.'
    })
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

  return {
    files: files.filter((f) => !isDocumentation(f.sourcePath) || f.destination === 'root-file'),
    variants,
    warnings,
    docs
  }
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
