/**
 * What a learned rule IS, kept away from the database that stores it.
 *
 * The knowledge store is SQLite in the main process, which the unit suite
 * cannot load. Everything that decides something - which source outranks which,
 * when a repeat strengthens a rule instead of duplicating it, how confident the
 * app is, what a readme line actually licenses the app to remember - lives here
 * instead, so it can be read and tested without Electron. `store.ts` is then
 * only the persistence: the same decisions, executed against SQLite.
 *
 * The rule that governs this whole file: nothing is invented. Every value below
 * is built from something that was actually read - a readme line, a folder the
 * detector found, a priority a person moved, a crash the app recorded - and
 * carries that evidence with it.
 */
import type { PlanWarning, ReadmeParse, VariantGroup } from './types'
import {
  buildPersistedVariantGroups,
  detectVariantGroups,
  fileNameSet,
  isAddonFolder,
  sameContentGroup,
  variantNameHint,
  type PersistedVariantGroup,
  type VariantTreeNode
} from './variantGroups'

export type RuleKind =
  | 'install-layout'
  | 'dependency'
  | 'variant-group'
  | 'post-install'
  | 'priority-override'
  | 'redundancy'
  | 'crash-correlation'
  | 'verdict'

export const RULE_KINDS: RuleKind[] = [
  'install-layout',
  'dependency',
  'variant-group',
  'post-install',
  'priority-override',
  'redundancy',
  'crash-correlation',
  'verdict'
]

export type RuleSource = 'readme' | 'binary' | 'modloader-log' | 'crash' | 'user' | 'seed' | 'inference'

/**
 * How much a source is trusted when two rules disagree.
 *
 * A person moving a file or a slider by hand is the strongest evidence there
 * is: they looked at the result and said no. Nothing outranks it.
 */
export const SOURCE_WEIGHT: Record<RuleSource, number> = {
  user: 100,
  readme: 80,
  binary: 70,
  'modloader-log': 60,
  seed: 50,
  crash: 40,
  inference: 20
}

export type RuleSubjectKind = 'exact' | 'shape' | 'slug' | 'folder'

export interface KnowledgeRule<T = unknown> {
  id: number
  kind: RuleKind
  /** Exact signature, shape signature, a mod slug or a mod folder - whatever the rule is keyed by. */
  subject: string
  subjectKind: RuleSubjectKind
  source: RuleSource
  /** The evidence, in the words that produced it: a readme line, a log line, a path. */
  evidence: string
  value: T
  weight: number
  createdAt: string
  /** Bumped every time the same rule is observed again. */
  timesSeen: number
}

export interface LearnInput<T = unknown> {
  kind: RuleKind
  subject: string
  subjectKind: RuleSubjectKind
  source: RuleSource
  evidence: string
  value: T
}

// ---------------------------------------------------------------------------
// The shapes each kind stores. One per RuleKind, so a kind can never again be
// a name in a union with nothing behind it.
// ---------------------------------------------------------------------------

export interface LayoutRule {
  /** Where a file inside the archive ends up, relative to the game folder. */
  placements: { source: string; target: string }[]
  /** The folder the mod owns, when it owns one. */
  modFolder: string | null
  /** The files a person placed by hand, when this rule records a correction. */
  correctedPaths?: string[]
}

export interface DependencyRule {
  kind: 'requires' | 'conflicts' | 'includes'
  name: string
  url: string | null
}

export interface VerdictRule {
  verdict: 'active' | 'inert' | 'mis-installed' | 'unknown'
  explanation: string | null
}

/** Sibling folders that are mutually exclusive, and which one was installed. */
export interface VariantGroupRule {
  groupId: string
  question: string
  options: { id: string; label: string; note: string | null }[]
  chosenOptionId: string
  /** The chosen option in words, readable enough to show ("(original)" becomes the mod's name). */
  chosenLabel: string
  /** Set when the group belongs to a sibling mod rather than standing on its own. */
  attachedTo: string | null
}

/**
 * "After installing, delete X."
 *
 * Recorded and shown, NEVER executed: this app does not delete a user's files
 * on the strength of a sentence in a readme. The rule exists so the instruction
 * survives the install and can be put in front of the person who owns the game.
 */
export interface PostInstallRule {
  action: 'delete'
  /** What the readme says to remove, exactly as it named it. */
  target: string
  /** The line it came from, in the author's own words. */
  line: string
}

/** A priority the user set by hand, which installs never do on their own. */
export interface PriorityOverrideRule {
  folder: string
  priority: number
  /** What a fresh install uses, so the rule can say what was overridden. */
  defaultPriority: number
}

/** The mod set a crash happened with, so a repeat can be recognised. */
export interface CrashCorrelationRule {
  address: string | null
  folders: string[]
  /** Profile the crash belongs to, when the record named one. */
  profileId: number | null
}

/** "Mod A obsoletes mods B, C, D" - the kind `learnCrash` used to borrow. */
export interface RedundancyRule {
  obsoletes: string[]
  reason: string
}

export interface RedundancyFinding {
  /** The mod that wins everything: the rule's subject. */
  winnerInstallId: number
  winnerFolder: string
  winnerTitle: string
  /** Mods that put nothing at all into the game while it is installed. */
  obsoletes: string[]
  reason: string
}

/**
 * "Mod A obsoletes mods B, C, D", grounded in the profile's own files and
 * nothing else.
 *
 * A mod is obsolete when EVERY single file it ships loses to another mod - not
 * most of them, all of them - and when one single mod wins all of them. Then
 * that mod contributes literally nothing to the running game, which is a fact
 * about the profile, not a guess about the mods.
 *
 * Everything short of that is deliberately not a finding: a mod that wins even
 * one file is doing something, a mod shadowed by three different mods is a
 * priority argument rather than a redundancy, and a file that no conflict
 * covers is a file that mod alone provides.
 */
export function redundancyFindings(
  installs: { installId: number; title: string; folder: string | null; provides: string[]; enabled: boolean }[],
  /** Winner install id per conflicted path; a path absent from it has no rival. */
  winnerByPath: Map<string, number>
): RedundancyFinding[] {
  const byId = new Map(installs.map((i) => [i.installId, i]))
  const grouped = new Map<number, { titles: string[]; files: number }>()
  for (const shadowed of installs) {
    if (!shadowed.enabled || shadowed.provides.length === 0) continue
    const winners = new Set<number>()
    let covered = true
    for (const p of shadowed.provides) {
      const winner = winnerByPath.get(p)
      if (winner === undefined || winner === shadowed.installId) {
        covered = false
        break
      }
      winners.add(winner)
    }
    if (!covered || winners.size !== 1) continue
    const winnerId = [...winners][0]
    const winner = byId.get(winnerId)
    if (!winner || !winner.folder) continue
    const entry = grouped.get(winnerId) ?? { titles: [], files: 0 }
    entry.titles.push(shadowed.title)
    entry.files += shadowed.provides.length
    grouped.set(winnerId, entry)
  }
  const out: RedundancyFinding[] = []
  for (const [winnerId, entry] of grouped) {
    const winner = byId.get(winnerId)
    if (!winner?.folder) continue
    const titles = [...new Set(entry.titles)].sort((a, b) => a.localeCompare(b))
    out.push({
      winnerInstallId: winnerId,
      winnerFolder: winner.folder,
      winnerTitle: winner.title,
      obsoletes: titles,
      reason:
        `Every one of the ${entry.files} file(s) ${titles.map((t) => `"${t}"`).join(', ')} ship is loaded from ` +
        `"${winner.title}" instead, so ${titles.length > 1 ? 'they add' : 'it adds'} nothing to the game as installed.`
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// The decisions the store executes.
// ---------------------------------------------------------------------------

export interface LearnDecision<T> {
  action: 'insert' | 'bump'
  rule: KnowledgeRule<T>
}

/**
 * Records a rule, or strengthens one already known.
 *
 * Seeing the same thing twice is evidence in itself, so a repeat of the same
 * (kind, subject, subjectKind, source) bumps timesSeen and refreshes the value
 * rather than writing a second row. The weight always comes from the source and
 * is never passed in, so no caller can promote its own guess.
 */
export function decideLearn<T>(
  existing: KnowledgeRule<T> | null | undefined,
  input: LearnInput<T>,
  now: string
): LearnDecision<T> {
  if (existing) {
    return {
      action: 'bump',
      rule: { ...existing, evidence: input.evidence, value: input.value, timesSeen: existing.timesSeen + 1 }
    }
  }
  return {
    action: 'insert',
    rule: {
      id: 0,
      kind: input.kind,
      subject: input.subject,
      subjectKind: input.subjectKind,
      source: input.source,
      evidence: input.evidence,
      value: input.value,
      weight: SOURCE_WEIGHT[input.source],
      createdAt: now,
      timesSeen: 1
    }
  }
}

/** Strongest first: the source decides, then how often it has been seen. */
export function rankRules<T>(rules: KnowledgeRule<T>[]): KnowledgeRule<T>[] {
  return [...rules].sort((a, b) => b.weight - a.weight || b.timesSeen - a.timesSeen || b.id - a.id)
}

export interface Confidence {
  /** 0..1, shown as a percentage. */
  score: number
  level: 'low' | 'medium' | 'high'
}

/**
 * How sure the app is, from the two things it actually knows: where the rule
 * came from, and how many times the same thing has been observed. Repetition
 * helps, but it can never turn a guess into the author's own words - the bonus
 * is capped well below the gap between two sources.
 */
export function confidenceOf(rule: { weight: number; timesSeen: number }): Confidence {
  const repeats = Math.max(0, Math.min(rule.timesSeen - 1, 5))
  const score = Math.max(0, Math.min(1, (rule.weight + repeats * 2) / 100))
  return { score, level: score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low' }
}

// ---------------------------------------------------------------------------
// A learned rule must never silently override a readme instruction.
// ---------------------------------------------------------------------------

export interface ReadmeConflict {
  /** The folder the author's readme names. */
  readmeFolder: string
  /** The folder the winning learned rule names. */
  learnedFolder: string
  learnedSource: RuleSource
  readmeEvidence: string
  learnedEvidence: string
  /** The two rows that disagree, so a list of rules can point at them. */
  readmeRuleId: number
  learnedRuleId: number
}

/**
 * The readme said one folder and something the app learned says another.
 *
 * Both rules are in the store, keyed by the same subject; this finds the pair
 * that contradict each other so the caller can put the disagreement in front of
 * the user. It never picks a winner: a rule the app inferred outranking the
 * author's own instructions, silently, is the failure this exists to prevent.
 */
export function readmeLayoutConflict(rules: KnowledgeRule<LayoutRule>[]): ReadmeConflict | null {
  const ranked = rankRules(rules)
  const readme = ranked.find((r) => r.source === 'readme' && r.value.modFolder)
  if (!readme?.value.modFolder) return null
  const rival = ranked.find(
    (r) => r.source !== 'readme' && r.value.modFolder && !sameFolder(r.value.modFolder, readme.value.modFolder)
  )
  if (!rival?.value.modFolder) return null
  return {
    readmeFolder: readme.value.modFolder,
    learnedFolder: rival.value.modFolder,
    learnedSource: rival.source,
    readmeEvidence: readme.evidence,
    learnedEvidence: rival.evidence,
    readmeRuleId: readme.id,
    learnedRuleId: rival.id
  }
}

/**
 * The same check over a mixed list of rules - the Settings screen holds the
 * most recent rules of every kind and every subject at once. Rules are grouped
 * by the subject they are keyed on, because only two rules about the SAME
 * archive can contradict each other, and the answer is per rule id so a list
 * can mark the rows involved.
 */
export function layoutConflictsByRule(rules: KnowledgeRule<LayoutRule>[]): Map<number, ReadmeConflict> {
  const bySubject = new Map<string, KnowledgeRule<LayoutRule>[]>()
  for (const r of rules) {
    if (r.kind !== 'install-layout') continue
    const list = bySubject.get(r.subject)
    if (list) list.push(r)
    else bySubject.set(r.subject, [r])
  }
  const out = new Map<number, ReadmeConflict>()
  for (const group of bySubject.values()) {
    const conflict = readmeLayoutConflict(group)
    if (!conflict) continue
    out.set(conflict.readmeRuleId, conflict)
    out.set(conflict.learnedRuleId, conflict)
  }
  return out
}

/**
 * A dependency the binary (or a guess) claims, against a readme that says the
 * opposite about the same mod. "Requires X" and "must not be used with X"
 * cannot both be acted on, so neither is - the pair is reported.
 */
export function readmeDependencyConflicts(rules: KnowledgeRule<DependencyRule>[]): {
  name: string
  readme: KnowledgeRule<DependencyRule>
  other: KnowledgeRule<DependencyRule>
}[] {
  const out: { name: string; readme: KnowledgeRule<DependencyRule>; other: KnowledgeRule<DependencyRule> }[] = []
  const fromReadme = rules.filter((r) => r.source === 'readme')
  for (const readme of fromReadme) {
    for (const other of rules) {
      if (other.source === 'readme') continue
      if (other.value.name.trim().toLowerCase() !== readme.value.name.trim().toLowerCase()) continue
      if (other.value.kind === readme.value.kind) continue
      if (readme.value.kind === 'includes' || other.value.kind === 'includes') continue
      out.push({ name: readme.value.name, readme, other })
    }
  }
  return out
}

/**
 * The plan warning a layout conflict becomes. Reported, never applied.
 *
 * A correction the user made by hand is allowed to outrank the readme - that is
 * the whole point of the highest weight - but it is still said out loud, so the
 * person can see that the author asked for something else.
 */
export function layoutConflictWarning(conflict: ReadmeConflict): PlanWarning {
  const fromUser = conflict.learnedSource === 'user'
  return {
    severity: 'warn',
    code: 'readme-vs-learned',
    message: fromUser
      ? `The readme says this mod goes in "${conflict.readmeFolder}"; you moved it to "${conflict.learnedFolder}".`
      : `The readme says this mod goes in "${conflict.readmeFolder}", but what the app learned says "${conflict.learnedFolder}".`,
    detail:
      `Readme: ${conflict.readmeEvidence} — learned (${conflict.learnedSource}): ${conflict.learnedEvidence}. ` +
      (fromUser
        ? 'Your own correction takes precedence; nothing was changed for you.'
        : 'The readme wins unless you say otherwise; nothing was changed for you.')
  }
}

function sameFolder(a: string | null, b: string | null): boolean {
  return (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase()
}

// ---------------------------------------------------------------------------
// post-install: recipes the author wrote down.
// ---------------------------------------------------------------------------

/** Files a readme can meaningfully tell you to remove from a GTA install. */
// No space in the name: a class that allowed one swallowed the words in front
// of it, and "apague o antigo.asi" was learned as a file called
// "apague o antigo.asi". A recipe naming the wrong file is worse than none.
const REMOVABLE = /([\w][\w.+()\-]{0,60}\.(?:asi|cs|cm|dll|txd|dff|col|ifp|img|ini|dat|cfg|ide|ipl|fxp|cleo|exe|bat))\b/i
const DELETE_VERB =
  /\b(apag(?:ue|ar|a)|delet(?:e|ar|a)|exclu(?:a|ir)|remov(?:a|er|e)|retir(?:e|ar)|erase|uninstall|desinstal(?:e|ar))\b/i
/** "não apague", "do not delete", "don't remove" - the opposite instruction. */
const NEGATED = /\b(n[ãa]o|nao|never|don'?t|do not|nunca)\b[^.]{0,20}$/i

/**
 * "After installing, delete X" - the one post-install recipe a readme states
 * often enough to be worth remembering, and the only one that is unambiguous.
 *
 * A line has to carry an imperative removal verb AND name a file with an
 * extension the game actually uses. A line that says NOT to delete something is
 * the opposite instruction and is skipped rather than inverted.
 */
export function postInstallRecipes(readmes: ReadmeParse[]): { value: PostInstallRule; evidence: string }[] {
  const out: { value: PostInstallRule; evidence: string }[] = []
  const seen = new Set<string>()
  for (const r of readmes) {
    for (const raw of (r.raw ?? '').split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.length > 300) continue
      const verb = DELETE_VERB.exec(line)
      if (!verb) continue
      const before = line.slice(0, verb.index)
      if (NEGATED.test(before)) continue
      const target = REMOVABLE.exec(line.slice(verb.index))?.[1]
      if (!target) continue
      const key = target.trim().toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ value: { action: 'delete', target: target.trim(), line }, evidence: line })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// variant-group: the detector's own findings, turned into rules.
// ---------------------------------------------------------------------------

/**
 * The archive as a tree, from the flat list of paths an extraction produced.
 *
 * `detectVariantGroups` walks a tree; a caller that holds only paths (the
 * knowledge layer, the unit suite) builds one here rather than growing a second
 * detector beside the real one.
 */
export function variantTreeFromPaths(files: { rel: string; size?: number }[]): VariantTreeNode {
  const root: VariantTreeNode = { name: '', rel: '', isDir: true, children: [], fileCount: 0, size: 0 }
  for (const f of files) {
    const parts = f.rel.replace(/\\/g, '/').split('/').filter(Boolean)
    let node = root
    for (let i = 0; i < parts.length; i++) {
      const isLeaf = i === parts.length - 1
      const rel = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => c.name === parts[i] && c.isDir === !isLeaf)
      if (!child) {
        child = { name: parts[i], rel, isDir: !isLeaf, children: [], fileCount: 0, size: isLeaf ? f.size ?? 0 : 0 }
        node.children.push(child)
      }
      node = child
    }
  }
  const tally = (n: VariantTreeNode): { files: number; size: number } => {
    if (!n.isDir) return { files: 1, size: n.size }
    let files = 0
    let size = 0
    for (const c of n.children) {
      const sub = tally(c)
      files += sub.files
      size += sub.size
    }
    n.fileCount = files
    n.size = size
    return { files, size }
  }
  tally(root)
  return root
}

/** Readme guidance for a set of option labels, or nothing. */
export function readmeVariantHint(readmeText: string | null): (labels: string[]) => string | null {
  const lines = (readmeText ?? '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0 && l.length < 300)
  return (labels: string[]) => {
    const wanted = labels.map((l) => l.trim().toLowerCase()).filter((l) => l.length >= 2)
    if (wanted.length === 0) return null
    return lines.find((l) => wanted.some((w) => l.toLowerCase().includes(w))) ?? null
  }
}

/**
 * Runs the real detector over an archive listing and returns the groups a
 * choice can be recorded against. No second detector: `detectVariantGroups` is
 * the one that decides what a variant group is, here as everywhere else.
 */
export function variantGroupsFromArchive(
  files: { rel: string; size?: number }[],
  readmeText: string | null
): VariantGroup[] {
  return detectVariantGroups(variantTreeFromPaths(files), { findHint: readmeVariantHint(readmeText) })
}

/**
 * Why the detector called these folders alternatives, in a sentence a person
 * can check: either they hold the identical set of file names, or their names
 * say so.
 */
export function variantGroupEvidence(
  files: { rel: string; size?: number }[],
  group: { parentPath: string; options: { id: string; label: string }[] }
): string {
  const parent = nodeAt(variantTreeFromPaths(files), group.parentPath)
  const dirs = parent ? parent.children.filter((c) => c.isDir && !isAddonFolder(c.name)) : []
  const identical = dirs.length >= 2 ? sameContentGroup(dirs) : null
  const labels = group.options.map((o) => o.label).join(', ')
  if (identical && identical.length >= 2) {
    const shared = fileNameSet(identical[0]).split('|').slice(0, 4).join(', ')
    return `${identical.length} sibling folders (${labels}) each hold the same file(s): ${shared}`
  }
  return `Sibling folders (${labels}) are alternatives of each other`
}

function nodeAt(root: VariantTreeNode, rel: string): VariantTreeNode | null {
  if (!rel) return root
  let node: VariantTreeNode | null = root
  for (const part of rel.split('/').filter(Boolean)) {
    node = node?.children.find((c) => c.isDir && c.name === part) ?? null
    if (!node) return null
  }
  return node
}

/**
 * The rule a resolved variant group becomes: which siblings were exclusive,
 * which one was installed, and what the others were.
 *
 * `fallbackName` names the mod, for options whose own label says nothing on its
 * own ("(original)", "PT", "4K") - `variantNameHint` decides which those are.
 */
export function variantGroupRule(group: PersistedVariantGroup, fallbackName: string): VariantGroupRule {
  const chosen = group.options.find((o) => o.id === group.chosenOptionId)
  return {
    groupId: group.id,
    question: group.question,
    options: group.options.map((o) => ({ id: o.id, label: o.label, note: o.note })),
    chosenOptionId: group.chosenOptionId,
    chosenLabel: variantNameHint(chosen?.label ?? group.chosenOptionId, fallbackName),
    attachedTo: null
  }
}

/** The user's own words back to them: what they picked, and what they did not. */
export function variantChoiceEvidence(group: PersistedVariantGroup, fallbackName: string): string {
  const chosen = group.options.find((o) => o.id === group.chosenOptionId)
  const others = group.options.filter((o) => o.id !== group.chosenOptionId).map((o) => o.label)
  const label = variantNameHint(chosen?.label ?? group.chosenOptionId, fallbackName)
  const rest = others.length > 0 ? ` and not ${others.join(', ')}` : ''
  return `You chose "${label}"${rest} when asked: ${group.question}`
}

/**
 * The install-time path: the detector's groups plus the choices a person made,
 * through the same `buildPersistedVariantGroups` the install record uses, so a
 * rule and an install can never disagree about what was chosen.
 */
export function variantGroupsForLearning(
  groups: VariantGroup[],
  selections: Record<string, string>,
  storedFiles: { sourcePath: string; targetRelative: string }[],
  fallbackName: string
): { value: VariantGroupRule; evidence: string }[] {
  return buildPersistedVariantGroups(groups, selections, storedFiles).map((g) => ({
    value: variantGroupRule(g, fallbackName),
    evidence: variantChoiceEvidence(g, fallbackName)
  }))
}

// ---------------------------------------------------------------------------
// priority-override and crash-correlation.
// ---------------------------------------------------------------------------

/** Every install starts here; anything else on a row is a person's doing. */
export const DEFAULT_INSTALL_PRIORITY = 50

export function priorityOverrideRule(folder: string, priority: number): { value: PriorityOverrideRule; evidence: string } {
  return {
    value: { folder, priority, defaultPriority: DEFAULT_INSTALL_PRIORITY },
    evidence:
      `You set "${folder}" to priority ${priority}; installs start at ${DEFAULT_INSTALL_PRIORITY}. ` +
      (priority > DEFAULT_INSTALL_PRIORITY
        ? 'It is meant to win over mods that ship the same files.'
        : 'It is meant to lose to mods that ship the same files.')
  }
}

export function crashCorrelationRule(
  folders: string[],
  address: string | null,
  profileId: number | null
): { value: CrashCorrelationRule; evidence: string } | null {
  const clean = [...new Set(folders.map((f) => f.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b))
  if (clean.length === 0) return null
  return {
    value: { address, folders: clean, profileId },
    evidence:
      `Crash at ${address ?? 'an unknown address'}: ${clean.length} mod(s) were installed before it and enabled — ` +
      `${clean.slice(0, 8).join(', ')}${clean.length > 8 ? '…' : ''}`
  }
}

/**
 * Crash correlations written before crashes had a kind of their own were stored
 * as `redundancy`, which means something else entirely ("mod A obsoletes B").
 * A row is one of those - and only one of those - when all three of its kind,
 * source and subject say so.
 */
export function isLegacyCrashRule(row: { kind: string; source: string; subject: string }): boolean {
  return row.kind === 'redundancy' && row.source === 'crash' && row.subject.startsWith('crash:')
}

/**
 * The stored payload of such a row, brought up to the current shape.
 *
 * The old writer had no `profileId`, so a migrated row would otherwise carry a
 * field that is simply absent where every other crash rule has one. It becomes
 * `null` - "this row predates the field" - and is never invented: guessing a
 * profile for a crash recorded before the app tracked one would be exactly the
 * fabricated evidence this layer exists to avoid. The address falls back to the
 * one already in the subject (`crash:<address>`), which is where it came from.
 */
export function migrateLegacyCrashValue(raw: unknown, subject: string): CrashCorrelationRule {
  const value = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const list = Array.isArray(value.folders) ? value.folders : Array.isArray(value.mods) ? value.mods : []
  const folders = [
    ...new Set(list.filter((f): f is string => typeof f === 'string').map((f) => f.trim()).filter(Boolean))
  ].sort((a, b) => a.localeCompare(b))
  const fromSubject = subject.startsWith('crash:') ? subject.slice('crash:'.length) : ''
  const stored = typeof value.address === 'string' ? value.address.trim() : ''
  const address = stored || (fromSubject && fromSubject !== 'unknown' ? fromSubject : '')
  return {
    address: address || null,
    folders,
    profileId: typeof value.profileId === 'number' ? value.profileId : null
  }
}
