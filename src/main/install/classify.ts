import path from 'node:path'
import fsp from 'node:fs/promises'
import type {
  AddOn,
  DestinationClass,
  PlanWarning,
  PlannedFile,
  ReadmeParse,
  VariantGroup
} from '@shared/types'
import { walk } from '../util/fsx'
import { findVariantHint } from './readme'
import { pluginEvidence, type PluginEvidence } from '../formats/strings'
import { gameRootPlacements, type DataPlacement } from '@shared/asiData'
import {
  addOnParentName,
  addOnRelativePath,
  detectVariantGroups,
  isAddonFolder,
  variantNameHint as sharedVariantNameHint,
  MOD_SUBFOLDERS
} from '@shared/variantGroups'

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
  /** Add-on folders offered beside the plan - enable to merge or install separately. */
  addOns: AddOn[]
  /**
   * What each .asi that was read says about itself, keyed by its path inside the
   * archive. Handed back so the caller does not read the same binaries again.
   */
  asiEvidence: Record<string, PluginEvidence>
}

/**
 * Reading a plugin's strings costs one file read plus a scan of it, and
 * classification runs on every install, so the work is bounded three ways: only
 * an .asi that owns resources is ever read (a bare loader's placement is
 * already settled), at most this many are read per archive, and only the head
 * of each one is - a PE keeps its .rdata literals far below these limits, and
 * anything bigger than the cap is not a plugin worth guessing about.
 */
const MAX_ASI_PROBES = 8
const MAX_ASI_SIZE = 32 * 1024 * 1024
const PROBE_HEAD_BYTES = 8 * 1024 * 1024

/** Reads at most `max` bytes from the front of a file. */
async function readHead(abs: string, max: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    handle = await fsp.open(abs, 'r')
    const st = await handle.stat()
    const len = Math.min(st.size, max)
    if (len <= 0) return null
    const buf = Buffer.alloc(len)
    await handle.read(buf, 0, len, 0)
    return buf
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

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

// ---------------------------------------------------------------------------
// Variants and add-ons: the detection itself lives in `@shared/variantGroups`
// so it stays pure and unit-testable outside Electron. `isAddonFolder` is
// used here too, both for the fallback dispatch below and for a directory
// that turns out to be a config-variant container for a sibling mod.
// ---------------------------------------------------------------------------

function toVariantTree(node: Node): import('@shared/variantGroups').VariantTreeNode {
  return {
    name: node.name,
    rel: node.rel,
    isDir: node.isDir,
    fileCount: node.fileCount,
    size: node.size,
    children: node.children.map(toVariantTree)
  }
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
  selections: Record<string, string> = {},
  addOnSelections: Record<string, boolean> = {}
): Promise<ClassifyResult> {
  const tree = await buildTree(root)
  const variantTree = toVariantTree(tree)
  const variants = detectVariantGroups(variantTree, {
    findHint: (labels) => findVariantHint(ctx.readmes, labels)
  })
  const warnings: PlanWarning[] = []
  const docs: string[] = []
  const files: PlannedFile[] = []
  const addOns: AddOn[] = []
  const asiEvidence: Record<string, PluginEvidence> = {}
  let probesLeft = MAX_ASI_PROBES
  /**
   * Files a plugin's own strings have already placed. One .asi never gets to
   * move a file a different .asi claimed: a plan where plugin A's literals
   * relocate plugin B's data is worse than not acting at all.
   */
  const claimedByBinary = new Set<PlannedFile>()

  const excluded: string[] = []
  const chosenPaths = new Set<string>()
  // Every directory's sibling list, so an add-on can name the mod it overrides.
  const siblingsOf = new Map<string, Node[]>()
  ;(function indexSiblings(n: Node): void {
    for (const c of n.children) {
      siblingsOf.set(c.rel, n.children)
      if (c.isDir) indexSiblings(c)
    }
  })(tree)
  // Enabled add-ons are emitted last, once the mods they override are planned,
  // so an override really overrides instead of racing the walk order.
  const pendingAddOns: { node: Node; parentName: string }[] = []
  // A group whose container is itself a config-variant of a sibling mod
  // ("(configurações)" holding zonetext.ini beside "Zone Text") never becomes
  // a mod of its own: its chosen option is routed into the owner's folder.
  const attachedContainers = new Map<string, string>()
  for (const g of variants) {
    const chosen = selections[g.id]
    for (const o of g.options) {
      if (o.id === chosen) chosenPaths.add(o.path)
      else excluded.push(o.path)
    }
    if (g.attachedToPath) attachedContainers.set(g.parentPath, g.attachedToPath)
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

  /**
   * Records an add-on folder as something the user may switch on, and either
   * queues it for the merge below or explains why it was left out.
   *
   * Either way it never installs as a mod folder of its own: that is exactly
   * what put "Extra\GTA UG\VHud\data" and "(alt - blue paint)" at the top of
   * modloader\, where Mod Loader ignored them.
   */
  function offerAddOn(node: Node, nameHint: string): void {
    addOns.push({ id: node.rel, path: node.rel, label: node.name, fileCount: node.fileCount, size: node.size })
    // The container itself is never walked into by anything else.
    excluded.push(node.rel)
    if (addOnSelections[node.rel]) {
      const siblings = siblingsOf.get(node.rel) ?? []
      pendingAddOns.push({
        node,
        parentName: addOnParentName(toVariantTree(node), siblings.map(toVariantTree), nameHint)
      })
      return
    }
    warnings.push({
      severity: 'info',
      code: 'addon-folder',
      message: `"${node.name}" holds optional extras for this mod, not a mod of its own.`,
      detail:
        'Modão leaves it out of the install. Its files replace files inside the mod they belong to, ' +
        'so installing it as a separate folder would make Mod Loader ignore it. Enable it and Modão merges ' +
        'it into that mod instead.'
    })
  }

  /** Merges one enabled add-on into the mod folder it overrides. */
  async function emitAddOn(node: Node, parentName: string): Promise<void> {
    const replaced: string[] = []
    for (const f of await walk(node.abs)) {
      const rel = node.rel ? `${node.rel}/${f.rel}` : f.rel
      if (/^(readme|leiame)/i.test(path.basename(f.rel)) && DOC_EXT.test(f.rel)) {
        docs.push(rel)
        continue
      }
      const target = `modloader/${parentName}/${addOnRelativePath(f.rel, parentName)}`
      const i = files.findIndex((x) => x.targetRelative.toLowerCase() === target.toLowerCase())
      if (i >= 0) {
        replaced.push(files[i].targetRelative)
        files.splice(i, 1)
      }
      files.push(makeFile(rel, target, 'modloader-folder', f.size))
    }
    warnings.push({
      severity: 'info',
      code: 'addon-enabled',
      message: `"${node.name}" was merged into ${parentName}, as requested.`,
      detail: replaced.length
        ? `It replaces ${replaced.length} file(s) the mod ships itself: ${replaced.slice(0, 4).join(', ')}` +
          (replaced.length > 4 ? ', …' : '')
        : 'Its files were added to that mod folder, which is the only place Mod Loader reads them from.'
    })
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
    // beside it, not a mod. Installed on its own, Mod Loader ignores it -
    // enabled, it merges into the mod it overrides (see emitAddOn).
    if (isAddonFolder(node.name)) {
      offerAddOn(node, nameHint)
      if (!addOnSelections[node.rel]) for (const f of await walk(node.abs)) docs.push(node.rel ? `${node.rel}/${f.rel}` : f.rel)
      return
    }

    // A parenthesised config container attached to a sibling mod: its chosen
    // option merges straight into that mod's own folder, and the container
    // itself never becomes a top-level entry.
    if (attachedContainers.has(node.rel)) {
      const ownerRel = attachedContainers.get(node.rel) as string
      const ownerName = path.basename(ownerRel)
      const group = variants.find((v) => v.parentPath === node.rel)
      const chosenId = group ? selections[group.id] : undefined
      const chosenChild = chosenId ? node.children.find((c) => c.rel === chosenId) : undefined
      // Merges straight into the owner's own folder, preserving the archive's
      // relative structure verbatim - these files replace or extend config the
      // owner already ships (Zone Text's own "cleo/zonetext.ini"), so a bare
      // .ini here belongs beside it, not reclassified to the game root.
      if (chosenChild) await emitDir(chosenChild, 'modloader-folder', `modloader/${ownerName}`)
      return
    }

    // A chosen variant folder is a passthrough: its contents are the mod.
    if (chosenPaths.has(node.rel)) {
      const hint = sharedVariantNameHint(node.name, nameHint)
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
   * Rule 2: ask the plugin itself where its files go.
   *
   * The archive's folder names are a guess; the strings compiled into the .asi
   * are what the plugin actually passes to the game's file APIs. Only an .asi
   * that owns resources is read, and only once.
   */
  async function probeAsi(ref: { rel: string; abs: string; size: number }): Promise<PluginEvidence | null> {
    const cached = asiEvidence[ref.rel]
    if (cached) return cached
    if (probesLeft <= 0 || ref.size > MAX_ASI_SIZE) return null
    probesLeft -= 1
    const buf = await readHead(ref.abs, PROBE_HEAD_BYTES)
    if (!buf) return null
    const evidence = pluginEvidence(buf)
    asiEvidence[ref.rel] = evidence
    return evidence
  }

  /**
   * Moves the files the plugin names in its own strings out to the game root.
   *
   * GTA's working directory is the game folder and Mod Loader does not change
   * it, so "VHud\data\blips.dat" resolves from <game root>\ wherever the .asi
   * ends up. The .asi stays in its mod folder - it is never lifted away from
   * what it ships with - but the data it opens by relative path has to exist
   * where the plugin will look for it.
   *
   * A readme that says otherwise outranks this: it is an instruction, and this
   * is an inference. The disagreement is surfaced rather than silently taken.
   */
  function routeDataToGameRoot(evidence: PluginEvidence, asiName: string, modFolder: string): void {
    if (evidence.paths.length === 0) return
    const prefix = `modloader/${modFolder}/`
    const owned = files.filter(
      (f) =>
        f.destination === 'modloader-folder' &&
        f.targetRelative.toLowerCase().startsWith(prefix.toLowerCase()) &&
        !/\.(asi|dll)$/i.test(f.targetRelative)
    )
    if (owned.length === 0) return
    const byRel = new Map(owned.map((f) => [f.targetRelative.slice(prefix.length), f]))
    const placements = gameRootPlacements(evidence.paths, modFolder, [...byRel.keys()])

    const moved: DataPlacement[] = []
    const refused: DataPlacement[] = []
    for (const p of placements) {
      const f = byRel.get(p.bundlePath)
      if (!f || claimedByBinary.has(f)) continue
      // A readme wins only when it says something genuinely different.
      //
      // "Extract the VHud folder into modloader" is the default placement, not
      // an instruction that contradicts anything - it is the single most common
      // line in the corpus, and the only destination readme.ts ever attaches a
      // folder name to. Reading it as a conflict would veto this whole feature
      // and put VHud back where "No handler or callme" came from. The same
      // reading is already the convention above, where a readme destination of
      // 'modloader-folder' is treated as no override at all.
      const readmeSaid =
        readmeFolders.get(p.rootTarget.split('/')[0].toLowerCase()) ?? readmeFolders.get(modFolder.toLowerCase())
      if (readmeSaid && readmeSaid !== 'root-file' && readmeSaid !== 'modloader-folder') {
        refused.push(p)
        continue
      }
      f.targetRelative = p.rootTarget.replace(/\/+/g, '/')
      f.destination = 'root-file'
      claimedByBinary.add(f)
      moved.push(p)
    }

    if (moved.length > 0) {
      const quoted = [...new Set(moved.map((p) => p.reason))].slice(0, 4)
      warnings.push({
        severity: 'info',
        code: 'asi-data-root',
        message: `${asiName} reads ${moved.length} of its files from the game folder, so they were installed there.`,
        detail:
          `The plugin carries ${quoted.map((r) => `"${r}"`).join(', ')} inside itself. The game runs from the game ` +
          'folder and Mod Loader does not change that, so a path written like this resolves from the game folder - ' +
          `left inside modloader\\${modFolder}\\, the plugin would never find it. ${asiName} itself stays with its ` +
          'mod folder.'
      })
    }
    if (refused.length > 0) {
      warnings.push({
        severity: 'warn',
        code: 'asi-data-readme',
        message: `The readme and ${asiName} disagree about where ${refused[0].rootTarget.split('/')[0]}\\ belongs.`,
        detail:
          `${asiName} carries "${refused[0].reason}" inside itself, which the game resolves from the game folder. ` +
          'The readme says otherwise, and the readme was followed - check the mod works before trusting it.'
      })
    }
  }

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
      // Rule 2: the plugin's own strings get the last word on its data.
      const evidence = await probeAsi(asi)
      if (evidence) routeDataToGameRoot(evidence, asi.name, name)

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
  async function rejoinSplitAsi(): Promise<void> {
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
      // Reunited, the same question applies: the .asi stays here, but the data
      // it names by relative path belongs at the game root.
      const evidence = await probeAsi({
        rel: asi.sourcePath,
        abs: path.join(root, asi.sourcePath),
        size: asi.size
      })
      if (evidence) routeDataToGameRoot(evidence, path.basename(asi.targetRelative), folder.split('/')[1])
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
    // A bare pile of assets skips handleNode entirely, so an add-on folder
    // sitting beside them (root/models/, root/Extra/) would otherwise never
    // be filtered: it walked straight into modloader\<mod>\Extra\ instead of
    // being offered separately.
    for (const c of tree.children) {
      if (!c.isDir || !isAddonFolder(c.name)) continue
      offerAddOn(c, ctx.fallbackName)
      if (!addOnSelections[c.rel]) for (const f of await walk(c.abs)) docs.push(c.rel ? `${c.rel}/${f.rel}` : f.rel)
    }
    await emitDir(tree, 'modloader-folder', `modloader/${ctx.fallbackName}`)
    // GInput's shape: GInputSA.asi dropped in beside a models\ folder. The pile
    // installs as one mod, but the plugin opens "models\x360btns.txd" from the
    // game folder - without it there, it prints "GInput could not load pad
    // button textures... The game will now close."
    //
    // A pile is undifferentiated: every file in it is a candidate for every
    // .asi in it. So only a plugin that owns resources is read at all (a bare
    // loader's placement is already settled and it has no data here), and with
    // two such plugins sharing one pile there is no way to tell whose data is
    // whose - guessing would move one plugin's files out from under it, so
    // nothing is moved.
    const pileAsis = tree.children.filter(
      (c) => !c.isDir && /\.asi$/i.test(c.name) && !isExcluded(c.rel) && asiOwnsResources(tree, c)
    )
    if (pileAsis.length === 1) {
      const evidence = await probeAsi(pileAsis[0])
      if (evidence) routeDataToGameRoot(evidence, pileAsis[0].name, ctx.fallbackName)
    }
    for (const f of files) {
      if (/^(readme|leiame)/i.test(path.basename(f.sourcePath))) docs.push(f.sourcePath)
    }
  } else {
    const consumed = await emitAsiBundles(tree, ctx.fallbackName)
    for (const child of tree.children) {
      if (consumed.has(child.rel)) continue
      await handleNode(child, ctx.fallbackName)
    }
    await rejoinSplitAsi()
  }

  // Last, so an add-on's files land on top of the very files they override.
  for (const a of pendingAddOns) await emitAddOn(a.node, a.parentName)

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
    docs,
    addOns,
    asiEvidence
  }
}

/** True when a folder is itself a Mod Loader mod rather than a container of mods. */
function holdsModContent(node: Node): boolean {
  return node.children.some(
    (c) => (c.isDir && MOD_SUBFOLDERS.has(c.name.toLowerCase())) || (!c.isDir && ASSET_EXT.test(c.name))
  )
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
