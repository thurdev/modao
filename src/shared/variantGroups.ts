/**
 * Detecting mutually-exclusive variant groups and add-on folders, kept pure
 * and filesystem-free so it can run in the unit suite and, later, in the
 * knowledge store's rule writer without either one touching Electron.
 *
 * `src/main/install/classify.ts` is the only caller today: it adapts its own
 * `Node` tree (which does carry `abs`/`size`, used elsewhere in that file) to
 * the minimal `VariantTreeNode` shape below and supplies the readme-hint
 * lookup, since `findVariantHint` lives in `../install/readme` (a main-only
 * module) and this file must not import it.
 */
import type { VariantGroup, VariantOption } from './types'

export interface VariantTreeNode {
  name: string
  /** Path relative to the archive root; '' for the root itself. */
  rel: string
  isDir: boolean
  children: VariantTreeNode[]
  fileCount: number
  size: number
}

/**
 * Folders that are add-ons to a mod rather than mods of their own:
 * "Extra", "(bonus)", "optional", "(translations)", "(alt - blue paint)".
 *
 * The trailing `[^)]*` is what makes a qualified name match too - the original
 * anchor `^\(?...\)?$` matched "alt" and "(alt)" but not "(alt - blue paint)",
 * and that folder was installed at the top of modloader\ with zero warnings.
 */
const ADDON_FOLDER =
  /^\(?\s*(extras?|bonus|optional|opcionais?|opcional|translations?|tradu[cç][aã]o|tradu[cç][oõ]es|alt|alternativ[eo]s?)\b[^)]*\)?$/i

export function isAddonFolder(name: string): boolean {
  return ADDON_FOLDER.test(name.trim())
}

/**
 * The mod an add-on folder belongs to.
 *
 * An add-on is an override for a mod beside it, so the sibling it shares file
 * names with is its owner: "Extra/GTA UG/VHud/data/hud.dat" carries the same
 * hud.dat the "VHud" mod ships. Failing that, a lone non-add-on sibling folder
 * is the only candidate there is. Failing that too - the bare-root archive,
 * where the mod IS the root - the caller's fallback name is the mod.
 */
export function addOnParentName(addOn: VariantTreeNode, siblings: VariantTreeNode[], fallback: string): string {
  const candidates = siblings.filter(
    (s) =>
      s !== addOn &&
      s.isDir &&
      !isAddonFolder(s.name) &&
      !MOD_SUBFOLDERS.has(s.name.toLowerCase()) &&
      !/^\(.+\)$/.test(s.name.trim())
  )
  if (candidates.length === 0) return fallback
  const mine = distinctiveLeafNames(addOn)
  const shared = candidates.find((c) => [...distinctiveLeafNames(c)].some((n) => mine.has(n)))
  if (shared) return shared.name
  return candidates.length === 1 ? candidates[0].name : fallback
}

/**
 * Where one file inside an add-on lands within its parent mod's folder.
 *
 * An add-on that repeats the mod's own folder name inside itself is describing
 * a hand install - "Extra\GTA UG\VHud\data\hud.dat" means "this replaces
 * VHud's data\hud.dat" - so everything up to and including that segment is
 * dropped and the file lands at "data/hud.dat" inside VHud. An add-on that
 * does not ("(alt - blue paint)\models\a.dff") already ships the mod's own
 * layout, and is kept verbatim.
 */
export function addOnRelativePath(relInsideAddOn: string, parentName: string): string {
  const segments = relInsideAddOn.split('/')
  const needle = parentName.trim().toLowerCase()
  for (let i = segments.length - 2; i >= 0; i--) {
    if (segments[i].trim().toLowerCase() === needle) return segments.slice(i + 1).join('/')
  }
  return relInsideAddOn
}

/** Folder names that are part of a mod's own layout, never a variant candidate. */
export const MOD_SUBFOLDERS = new Set([
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
export function fileNameSet(node: VariantTreeNode): string {
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
export function sameContentGroup(dirs: VariantTreeNode[]): VariantTreeNode[] | null {
  const bySet = new Map<string, VariantTreeNode[]>()
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

/**
 * A descriptive variant folder ("Loadscreens 2K Definitive") makes a good mod
 * folder name. An uninformative one ("(original)", "PT", "4K") does not, so
 * the archive name (or the parent mod it is attached to) is used instead.
 */
export function variantNameHint(name: string, fallback: string): string {
  const n = name.trim()
  if (/^\(.*\)$/.test(n)) return fallback
  if (/^(pt|pt-?br|br|en|eng|es|esp|ru|rus|fr|de|it|pl|sa|vc|iii|samp)$/i.test(n)) return fallback
  if (/^\d?[1-8]k$/i.test(n)) return fallback
  return n
}

/** Names too generic to prove two folders are the same configuration. */
const NON_DISTINCTIVE_NAME = /\.(txt|nfo|pdf|url|html?|md|docx?|jpe?g|png|gif|webp|bmp|tga)$/i
const README_NAME = /^(readme|leiame|leia|install|como instalar)/i

/** All file basenames anywhere under a node, lowercased, minus documentation. */
function distinctiveLeafNames(node: VariantTreeNode): Set<string> {
  const out = new Set<string>()
  const visit = (n: VariantTreeNode): void => {
    for (const c of n.children) {
      if (c.isDir) visit(c)
      else if (!NON_DISTINCTIVE_NAME.test(c.name) && !README_NAME.test(c.name)) out.add(c.name.toLowerCase())
    }
  }
  visit(node)
  return out
}

/**
 * A parenthesised folder whose contents duplicate a sibling mod's own config
 * filenames is a variant group FOR THAT MOD, not a standalone mod: the
 * spec's "(configurações)" case, holding "(minimalista)/zonetext.ini" and
 * "(padrão)/zonetext.ini" beside a "Zone Text" mod that already ships its own
 * "cleo/zonetext.ini". Returns the sibling to attach to, or null.
 */
export function configVariantParent(node: VariantTreeNode, siblings: VariantTreeNode[]): VariantTreeNode | null {
  if (!node.isDir || !/^\(.+\)$/.test(node.name.trim())) return null
  const names = distinctiveLeafNames(node)
  if (names.size === 0) return null
  for (const sib of siblings) {
    if (sib === node || !sib.isDir) continue
    if (isAddonFolder(sib.name) || /^\(.+\)$/.test(sib.name.trim())) continue
    const sibNames = distinctiveLeafNames(sib)
    if (sibNames.size === 0) continue
    if ([...names].some((n) => sibNames.has(n))) return sib
  }
  return null
}

export interface DetectVariantGroupsOptions {
  /** Looks up readme guidance ("2K recomendado…") for a set of option labels. */
  findHint: (labels: string[]) => string | null
}

/**
 * Walks the tree looking for sibling folders that are mutually exclusive
 * alternatives, either by a known naming pattern or by holding the identical
 * set of file names. Descends into a level only once no group forms there, so
 * a group's own options are never re-examined as candidates themselves.
 */
export function detectVariantGroups(root: VariantTreeNode, opts: DetectVariantGroupsOptions): VariantGroup[] {
  const groups: VariantGroup[] = []

  function consider(parent: VariantTreeNode, parentSiblings: VariantTreeNode[]): void {
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
        const hint = opts.findHint(options.map((o) => o.label))
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
        // A parenthesised container whose files duplicate a sibling mod's own
        // config files is a variant group FOR that sibling, not a mod of its
        // own - attach it instead of letting it become a top-level folder.
        const owner = configVariantParent(parent, parentSiblings)
        groups.push({
          id: `variant:${parent.rel || '<root>'}`,
          parentPath: parent.rel,
          attachedToPath: owner ? owner.rel : null,
          kind: rule.kind,
          question: rule.question,
          hint,
          options
        })
        return // never descend into a group's own branches
      }
    }
    for (const c of parent.children) if (c.isDir) consider(c, dirs)
  }

  consider(root, [])
  return groups
}

// ---------------------------------------------------------------------------
// What gets recorded on an install so a variant can be switched later without
// ever needing the archive again. Every option's raw bytes are snapshotted
// into the store at install time (`contentStore.ingestVariantOptions`); this
// is the bookkeeping that says which on-disk paths belong to which group and
// which option is currently active, so a switch knows what to overwrite.
// ---------------------------------------------------------------------------

export interface PersistedVariantOption {
  id: string
  label: string
  note: string | null
}

export interface PersistedVariantGroup {
  id: string
  question: string
  chosenOptionId: string
  /** The install's current on-disk/store paths that belong to this group. */
  targetRelatives: string[]
  options: PersistedVariantOption[]
}

/**
 * Built once, right after a plan is applied, from the group definitions, the
 * choices that were made, and the files that were actually stored. A group
 * with no resolved choice is skipped - `applyPlan` never runs with one, since
 * an unresolved variant blocks the install outright.
 */
export function buildPersistedVariantGroups(
  groups: VariantGroup[],
  selections: Record<string, string>,
  storedFiles: { sourcePath: string; targetRelative: string }[]
): PersistedVariantGroup[] {
  const out: PersistedVariantGroup[] = []
  for (const g of groups) {
    const chosenOptionId = selections[g.id]
    const chosenOption = chosenOptionId ? g.options.find((o) => o.id === chosenOptionId) : undefined
    if (!chosenOptionId || !chosenOption) continue
    const targetRelatives = storedFiles
      .filter((f) => f.sourcePath === chosenOption.path || f.sourcePath.startsWith(`${chosenOption.path}/`))
      .map((f) => f.targetRelative)
    out.push({
      id: g.id,
      question: g.question,
      chosenOptionId,
      targetRelatives,
      options: g.options.map((o) => ({ id: o.id, label: o.label, note: o.note }))
    })
  }
  return out
}
