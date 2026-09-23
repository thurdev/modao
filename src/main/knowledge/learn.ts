import type { PlanWarning, PlannedFile, ReadmeParse, VariantGroup } from '@shared/types'
import {
  crashCorrelationRule,
  layoutConflictWarning,
  postInstallRecipes,
  priorityOverrideRule,
  readmeDependencyConflicts,
  readmeLayoutConflict,
  type RedundancyFinding,
  type RedundancyRule,
  variantChoiceEvidence,
  variantGroupEvidence,
  variantGroupRule,
  variantGroupsForLearning,
  variantGroupsFromArchive,
  type CrashCorrelationRule,
  type DependencyRule,
  type LayoutRule,
  type PostInstallRule,
  type PriorityOverrideRule,
  type VariantGroupRule,
  type VerdictRule
} from '@shared/knowledgeRules'
import type { PersistedVariantGroup } from '@shared/variantGroups'
import { learn, rulesFor, type KnowledgeRule } from './store'
import { signatureForArchive, subjectsOf, type ModSignature } from './signature'

export { signatureForArchive, subjectsOf }
export type { LayoutRule, DependencyRule, VerdictRule, VariantGroupRule, PostInstallRule, PriorityOverrideRule }

/**
 * Turning what happened into what the app knows next time.
 *
 * Every call here is grounded in something that was actually read: a readme
 * line, a string inside a plugin, a line Mod Loader wrote, a folder the variant
 * detector found, a slider the user moved, or a crash the app recorded. Nothing
 * is inferred from nothing, and each rule carries the evidence it came from so
 * it can be shown - and argued with.
 */

/**
 * Records what the readme said. The author's own words are the strongest
 * evidence short of the user correcting the app by hand.
 *
 * Three kinds come out of one reading: what the mod declares it needs, where
 * the author says it goes, and what the author says to delete afterwards.
 */
export function learnFromReadme(signature: ModSignature, readmes: ReadmeParse[]): void {
  for (const r of readmes) {
    for (const d of r.declared) {
      learn<DependencyRule>({
        kind: 'dependency',
        subject: signature.exact,
        subjectKind: 'exact',
        source: 'readme',
        evidence: d.line,
        value: { kind: d.kind, name: d.name, url: d.url }
      })
    }
    for (const i of r.instructions) {
      if (!i.folder) continue
      learn<LayoutRule>({
        kind: 'install-layout',
        subject: signature.exact,
        subjectKind: 'exact',
        source: 'readme',
        evidence: i.line,
        value: { placements: [], modFolder: i.folder }
      })
    }
  }
  learnPostInstall(signature, readmes)
}

/**
 * "After installing, delete X" - kept because the author wrote it down.
 *
 * The recipe is recorded and shown; it is never carried out. This app does not
 * delete a person's files on the strength of a sentence, and a rule that did
 * would be the most dangerous thing in the store.
 */
export function learnPostInstall(signature: ModSignature, readmes: ReadmeParse[]): void {
  for (const recipe of postInstallRecipes(readmes)) {
    learn<PostInstallRule>({
      kind: 'post-install',
      subject: signature.exact,
      subjectKind: 'exact',
      source: 'readme',
      evidence: recipe.evidence,
      value: recipe.value
    })
  }
}

/** Records what the plugin binary asks for at runtime. */
export function learnFromBinary(signature: ModSignature, pluginName: string, probes: string[], rootFolder: string | null): void {
  for (const probe of probes) {
    learn<DependencyRule>({
      kind: 'dependency',
      subject: signature.exact,
      subjectKind: 'exact',
      source: 'binary',
      evidence: `${pluginName} contains the string "${probe}"`,
      value: { kind: 'requires', name: probe, url: null }
    })
  }
  if (rootFolder) {
    learn<LayoutRule>({
      kind: 'install-layout',
      subject: signature.exact,
      subjectKind: 'exact',
      source: 'binary',
      evidence: `${pluginName} opens paths under ${rootFolder}\\`,
      value: { placements: [], modFolder: rootFolder }
    })
  }
}

/**
 * Records where the files actually went, against the archive's SHAPE as well as
 * its exact identity - so an archive laid out the same way is understood before
 * it has ever been seen.
 *
 * `correctedPaths` is what separates a guess from a fact. A file the user moved
 * by hand is learned as a user correction at the highest weight there is; the
 * files the classifier placed and the user merely accepted stay an inference,
 * at the lowest. Learning both at the same weight - which is what happened
 * before - made a correction indistinguishable from a guess.
 */
export function learnLayout(
  signature: ModSignature,
  files: PlannedFile[],
  source: 'inference' | 'user',
  correctedPaths: string[] = []
): void {
  if (files.length === 0) return
  const corrected = new Set(correctedPaths)
  const byUser = corrected.size > 0 ? files.filter((f) => corrected.has(f.sourcePath)) : []
  const rest = corrected.size > 0 ? files.filter((f) => !corrected.has(f.sourcePath)) : files

  if (byUser.length > 0) writeLayout(signature, byUser, 'user', byUser.map((f) => f.sourcePath))
  if (rest.length > 0) writeLayout(signature, rest, source, [])
}

function writeLayout(signature: ModSignature, files: PlannedFile[], source: 'inference' | 'user', corrected: string[]): void {
  const modFolder = /^modloader\/([^/]+)\//.exec(files[0].targetRelative)?.[1] ?? null
  const value: LayoutRule = {
    placements: files.slice(0, 200).map((f) => ({ source: f.sourcePath, target: f.targetRelative })),
    modFolder,
    ...(corrected.length > 0 ? { correctedPaths: corrected.slice(0, 200) } : {})
  }
  const evidence =
    source === 'user'
      ? `You placed ${files.length} file(s) yourself, starting with ${files[0].sourcePath} → ${files[0].targetRelative}`
      : `${files.length} file(s) placed by the classifier and accepted`
  learn<LayoutRule>({ kind: 'install-layout', subject: signature.exact, subjectKind: 'exact', source, evidence, value })
  // The shape rule keeps only the folder, since file names will differ.
  learn<LayoutRule>({
    kind: 'install-layout',
    subject: signature.shape,
    subjectKind: 'shape',
    source,
    evidence: `${evidence} (shape: ${signature.shapeParts.join(', ')})`,
    value: { placements: [], modFolder }
  })
}

/**
 * Closes the loop: Mod Loader's own verdict on a mod folder, learned after a
 * launch. This is the only source that says whether an install WORKED.
 */
export function learnVerdict(folder: string, verdict: VerdictRule): void {
  learn<VerdictRule>({
    kind: 'verdict',
    subject: folder.toLowerCase(),
    subjectKind: 'folder',
    source: 'modloader-log',
    evidence: verdict.explanation ?? `Mod Loader reported this folder as ${verdict.verdict}`,
    value: verdict
  })
}

/**
 * Which sibling folders were mutually exclusive, and which one the user picked.
 *
 * The groups come from `detectVariantGroups` by way of
 * `buildPersistedVariantGroups` - the same detection that drove the install, so
 * a rule and an install can never disagree about what was chosen. The CHOICE is
 * the user's, made in the dialog, which is why it is learned at user weight; a
 * group nobody resolved is never persisted and never learned.
 */
export function learnVariantChoice(
  subject: string,
  subjectKind: 'exact' | 'shape' | 'slug' | 'folder',
  group: PersistedVariantGroup,
  fallbackName: string
): void {
  learn<VariantGroupRule>({
    kind: 'variant-group',
    subject,
    subjectKind,
    source: 'user',
    evidence: variantChoiceEvidence(group, fallbackName),
    value: variantGroupRule(group, fallbackName)
  })
}

/** Every resolved group of an install, learned at once. */
export function learnVariantChoices(
  signature: ModSignature,
  groups: VariantGroup[],
  selections: Record<string, string>,
  storedFiles: { sourcePath: string; targetRelative: string }[],
  fallbackName: string
): void {
  for (const rule of variantGroupsForLearning(groups, selections, storedFiles, fallbackName)) {
    learn<VariantGroupRule>({
      kind: 'variant-group',
      subject: signature.exact,
      subjectKind: 'exact',
      source: 'user',
      evidence: rule.evidence,
      value: rule.value
    })
  }
}

/**
 * What the detector found in an archive, before anyone has chosen anything:
 * these folders are alternatives of each other. Learned at inference weight,
 * with the detector's own reason as evidence ("three folders hold the same
 * ProperShaders.ini"), so a later archive of the same shape is recognised as
 * offering a choice rather than installed nine times over.
 */
export function learnVariantGroupsFromArchive(
  signature: ModSignature,
  files: { rel: string; size?: number }[],
  readmeText: string | null,
  fallbackName: string
): VariantGroup[] {
  const groups = variantGroupsFromArchive(files, readmeText)
  for (const g of groups) {
    if (g.options.length < 2) continue
    learn<VariantGroupRule>({
      kind: 'variant-group',
      subject: signature.shape,
      subjectKind: 'shape',
      source: 'inference',
      evidence: variantGroupEvidence(files, g),
      value: {
        groupId: g.id,
        question: g.question,
        options: g.options.map((o) => ({ id: o.id, label: o.label, note: o.note })),
        chosenOptionId: '',
        chosenLabel: fallbackName,
        attachedTo: g.attachedToPath
      }
    })
  }
  return groups
}

/**
 * A priority the user moved by hand.
 *
 * Every install starts at 50 and nothing in the app changes that on its own, so
 * a different number is a person's decision about which mod should win when two
 * ship the same file - the spec's "Loadscreens must outrank a translation that
 * ships LOADSCS.txd". It is keyed by the mod folder, which is what Mod Loader
 * itself orders, so it survives reinstalling the mod.
 */
export function learnPriorityOverride(folder: string, priority: number): void {
  const rule = priorityOverrideRule(folder, priority)
  learn<PriorityOverrideRule>({
    kind: 'priority-override',
    subject: folder.toLowerCase(),
    subjectKind: 'folder',
    source: 'user',
    evidence: rule.evidence,
    value: rule.value
  })
}

/**
 * Mods that put nothing into the game because another mod wins every file they
 * ship. Written against the winner's folder, at inference weight: it is a true
 * statement about this profile as it stands now, not an instruction, and a
 * priority change can make it false again the next time the list is read.
 */
export function learnRedundancies(findings: RedundancyFinding[]): void {
  for (const f of findings) {
    learn<RedundancyRule>({
      kind: 'redundancy',
      subject: f.winnerFolder.toLowerCase(),
      subjectKind: 'folder',
      source: 'inference',
      evidence: f.reason,
      value: { obsoletes: f.obsoletes, reason: f.reason }
    })
  }
}

/**
 * The mod set a crash happened with, so a repeat can be recognised.
 *
 * Its own kind: a crash correlation is not a redundancy ("mod A obsoletes B"),
 * which is the kind it used to be filed under while the writer itself was never
 * called at all.
 */
export function learnCrashCorrelation(folders: string[], address: string | null, profileId: number | null = null): void {
  const rule = crashCorrelationRule(folders, address, profileId)
  if (!rule) return
  learn<CrashCorrelationRule>({
    kind: 'crash-correlation',
    subject: `crash:${address ?? 'unknown'}`,
    subjectKind: 'exact',
    source: 'crash',
    evidence: rule.evidence,
    value: rule.value
  })
}

/** What the app already knows about an archive, strongest evidence first. */
export function knownAbout(signature: ModSignature): {
  layout: KnowledgeRule<LayoutRule> | null
  dependencies: KnowledgeRule<DependencyRule>[]
  variantGroups: KnowledgeRule<VariantGroupRule>[]
  postInstall: KnowledgeRule<PostInstallRule>[]
  /** Contradictions between the author's readme and something the app worked out. */
  conflicts: PlanWarning[]
} {
  const subjects = subjectsOf(signature)
  const layouts = rulesFor<LayoutRule>('install-layout', subjects)
  const dependencies = rulesFor<DependencyRule>('dependency', subjects)
  const conflicts: PlanWarning[] = []
  const layoutConflict = readmeLayoutConflict(layouts)
  if (layoutConflict) conflicts.push(layoutConflictWarning(layoutConflict))
  for (const c of readmeDependencyConflicts(dependencies)) {
    conflicts.push({
      severity: 'warn',
      code: 'readme-vs-learned-dependency',
      message: `The readme and what the app learned disagree about "${c.name}".`,
      detail: `Readme (${c.readme.value.kind}): ${c.readme.evidence} — learned ${c.other.value.kind} (${c.other.source}): ${c.other.evidence}. Neither was acted on.`
    })
  }
  return {
    layout: layouts[0] ?? null,
    dependencies,
    variantGroups: rulesFor<VariantGroupRule>('variant-group', subjects),
    postInstall: rulesFor<PostInstallRule>('post-install', subjects),
    conflicts
  }
}

/**
 * Did the classifier put this file somewhere other than where the app was
 * taught? Used to warn before installing, not to override silently.
 *
 * A rule that contradicts the author's own readme is reported as exactly that,
 * naming which side the readme is on, because that is the disagreement the user
 * can actually settle.
 */
export function layoutDisagreement(
  known: KnowledgeRule<LayoutRule> | null,
  files: PlannedFile[]
): PlanWarning | null {
  if (!known?.value.modFolder || files.length === 0) return null
  const conflict = readmeLayoutConflict(rulesFor<LayoutRule>('install-layout', [known.subject]))
  if (conflict) return layoutConflictWarning(conflict)
  const planned = /^modloader\/([^/]+)\//.exec(files[0].targetRelative)?.[1] ?? null
  if (!planned || planned.toLowerCase() === known.value.modFolder.toLowerCase()) return null
  return {
    severity: 'warn',
    code: 'layout-disagreement',
    message: `This was installed into "${known.value.modFolder}" before, and the plan says "${planned}".`,
    detail: `${known.evidence} (${known.source}). Check the plan before applying it.`
  }
}
