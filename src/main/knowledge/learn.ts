import type { DeclaredDependency, PlanWarning, PlannedFile, ReadmeParse } from '@shared/types'
import { learn, rulesFor, type KnowledgeRule } from './store'
import { signatureForArchive, type ModSignature } from './signature'

export { signatureForArchive }

/**
 * Turning what happened into what the app knows next time.
 *
 * Every call here is grounded in something that was actually read: a readme
 * line, a string inside a plugin, a line Mod Loader wrote, or a correction the
 * user made by hand. Nothing is inferred from nothing, and each rule carries
 * the evidence it came from so it can be shown - and argued with.
 */

export interface LayoutRule {
  /** Where a file inside the archive ends up, relative to the game folder. */
  placements: { source: string; target: string }[]
  /** The folder the mod owns, when it owns one. */
  modFolder: string | null
}

export interface DependencyRule {
  kind: DeclaredDependency['kind']
  name: string
  url: string | null
}

export interface VerdictRule {
  verdict: 'active' | 'inert' | 'mis-installed' | 'unknown'
  explanation: string | null
}

/** Both keys a rule can be stored against, most specific first. */
export function subjectsOf(signature: ModSignature): string[] {
  return [signature.exact, signature.shape]
}

/**
 * Records what the readme said. The author's own words are the strongest
 * evidence short of the user correcting the app by hand.
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
 */
export function learnLayout(signature: ModSignature, files: PlannedFile[], source: 'inference' | 'user'): void {
  if (files.length === 0) return
  const modFolder = /^modloader\/([^/]+)\//.exec(files[0].targetRelative)?.[1] ?? null
  const value: LayoutRule = {
    placements: files.slice(0, 200).map((f) => ({ source: f.sourcePath, target: f.targetRelative })),
    modFolder
  }
  const evidence =
    source === 'user'
      ? 'You placed these files yourself'
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

/** Records the mod set a crash happened with, so a repeat can be recognised. */
export function learnCrash(folders: string[], address: string | null): void {
  if (folders.length === 0) return
  learn<{ folders: string[]; address: string | null }>({
    kind: 'redundancy',
    subject: `crash:${address ?? 'unknown'}`,
    subjectKind: 'exact',
    source: 'crash',
    evidence: `Crash at ${address ?? 'an unknown address'} with ${folders.length} mod(s) enabled`,
    value: { folders, address }
  })
}

/** What the app already knows about an archive, strongest evidence first. */
export function knownAbout(signature: ModSignature): {
  layout: KnowledgeRule<LayoutRule> | null
  dependencies: KnowledgeRule<DependencyRule>[]
} {
  const subjects = subjectsOf(signature)
  return {
    layout: rulesFor<LayoutRule>('install-layout', subjects)[0] ?? null,
    dependencies: rulesFor<DependencyRule>('dependency', subjects)
  }
}

/**
 * Did the classifier put this file somewhere other than where the app was
 * taught? Used to warn before installing, not to override silently.
 */
export function layoutDisagreement(
  known: KnowledgeRule<LayoutRule> | null,
  files: PlannedFile[]
): PlanWarning | null {
  if (!known?.value.modFolder || files.length === 0) return null
  const planned = /^modloader\/([^/]+)\//.exec(files[0].targetRelative)?.[1] ?? null
  if (!planned || planned.toLowerCase() === known.value.modFolder.toLowerCase()) return null
  return {
    severity: 'warn',
    code: 'layout-disagreement',
    message: `This was installed into "${known.value.modFolder}" before, and the plan says "${planned}".`,
    detail: `${known.evidence} (${known.source}). Check the plan before applying it.`
  }
}
