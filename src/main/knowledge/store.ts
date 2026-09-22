import { getDb } from '../db'

/**
 * What the app has learned, and where each piece came from.
 *
 * Every rule records its source and its weight, because the difference between
 * "the author wrote this in the readme" and "the app inferred it from a folder
 * name" matters when they disagree. The user always wins: if someone moves a
 * file by hand, that is the strongest evidence there is, and it is what the app
 * does next time.
 *
 * Nothing here is invented. A rule exists only because a readme said it, a
 * binary contained it, Mod Loader logged it, a crash correlated with it, or a
 * person corrected the app.
 */
export type RuleKind =
  | 'install-layout'
  | 'dependency'
  | 'variant-group'
  | 'post-install'
  | 'priority-override'
  | 'redundancy'
  | 'verdict'

export type RuleSource = 'readme' | 'binary' | 'modloader-log' | 'crash' | 'user' | 'seed' | 'inference'

/** How much a source is trusted when two rules disagree. */
export const SOURCE_WEIGHT: Record<RuleSource, number> = {
  user: 100,
  readme: 80,
  binary: 70,
  'modloader-log': 60,
  seed: 50,
  crash: 40,
  inference: 20
}

export interface KnowledgeRule<T = unknown> {
  id: number
  kind: RuleKind
  /** Exact signature, shape signature, or a mod slug - whatever the rule is keyed by. */
  subject: string
  subjectKind: 'exact' | 'shape' | 'slug' | 'folder'
  source: RuleSource
  /** The evidence, in the words that produced it: a readme line, a log line, a path. */
  evidence: string
  value: T
  weight: number
  createdAt: string
  /** Bumped every time the same rule is observed again. */
  timesSeen: number
}

interface Row {
  id: number
  kind: string
  subject: string
  subject_kind: string
  source: string
  evidence: string
  value_json: string
  weight: number
  created_at: string
  times_seen: number
}

function toRule<T>(r: Row): KnowledgeRule<T> {
  return {
    id: r.id,
    kind: r.kind as RuleKind,
    subject: r.subject,
    subjectKind: r.subject_kind as KnowledgeRule['subjectKind'],
    source: r.source as RuleSource,
    evidence: r.evidence,
    value: JSON.parse(r.value_json) as T,
    weight: r.weight,
    createdAt: r.created_at,
    timesSeen: r.times_seen
  }
}

export interface LearnInput<T = unknown> {
  kind: RuleKind
  subject: string
  subjectKind: KnowledgeRule['subjectKind']
  source: RuleSource
  evidence: string
  value: T
}

/**
 * Records a rule, or strengthens one already known.
 *
 * Seeing the same thing twice is evidence in itself, so a repeat bumps
 * timesSeen rather than writing a second row. A rule from a stronger source
 * replaces a weaker one for the same subject and kind - a user correction
 * overrules everything, and nothing overrules a user correction.
 */
export function learn<T>(input: LearnInput<T>): KnowledgeRule<T> {
  const db = getDb()
  const now = new Date().toISOString()
  const weight = SOURCE_WEIGHT[input.source]
  const valueJson = JSON.stringify(input.value)

  const existing = db
    .prepare('SELECT * FROM knowledge_rule WHERE kind = ? AND subject = ? AND subject_kind = ? AND source = ?')
    .get(input.kind, input.subject, input.subjectKind, input.source) as Row | undefined

  if (existing) {
    db.prepare('UPDATE knowledge_rule SET value_json = ?, evidence = ?, times_seen = times_seen + 1 WHERE id = ?').run(
      valueJson,
      input.evidence,
      existing.id
    )
    return toRule<T>({ ...existing, value_json: valueJson, evidence: input.evidence, times_seen: existing.times_seen + 1 })
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO knowledge_rule (kind, subject, subject_kind, source, evidence, value_json, weight, created_at, times_seen)
         VALUES (?,?,?,?,?,?,?,?,1)`
      )
      .run(input.kind, input.subject, input.subjectKind, input.source, input.evidence, valueJson, weight, now).lastInsertRowid
  )
  return {
    id,
    kind: input.kind,
    subject: input.subject,
    subjectKind: input.subjectKind,
    source: input.source,
    evidence: input.evidence,
    value: input.value,
    weight,
    createdAt: now,
    timesSeen: 1
  }
}

/** Every rule for these subjects, strongest first. */
export function rulesFor<T>(kind: RuleKind, subjects: string[]): KnowledgeRule<T>[] {
  if (subjects.length === 0) return []
  const placeholders = subjects.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT * FROM knowledge_rule WHERE kind = ? AND subject IN (${placeholders})
        ORDER BY weight DESC, times_seen DESC, id DESC`
    )
    .all(kind, ...subjects) as Row[]
  return rows.map((r) => toRule<T>(r))
}

/** The one rule that should win for a subject, or nothing. */
export function bestRule<T>(kind: RuleKind, subjects: string[]): KnowledgeRule<T> | null {
  return rulesFor<T>(kind, subjects)[0] ?? null
}

/** Forgets a rule. Used when the user says the app got it wrong. */
export function unlearn(id: number): void {
  getDb().prepare('DELETE FROM knowledge_rule WHERE id = ?').run(id)
}

export interface KnowledgeSummary {
  total: number
  byKind: Record<string, number>
  bySource: Record<string, number>
}

export function knowledgeSummary(): KnowledgeSummary {
  const db = getDb()
  const total = (db.prepare('SELECT COUNT(*) c FROM knowledge_rule').get() as { c: number }).c
  const byKind: Record<string, number> = {}
  const bySource: Record<string, number> = {}
  for (const r of db.prepare('SELECT kind, COUNT(*) c FROM knowledge_rule GROUP BY kind').all() as {
    kind: string
    c: number
  }[]) {
    byKind[r.kind] = r.c
  }
  for (const r of db.prepare('SELECT source, COUNT(*) c FROM knowledge_rule GROUP BY source').all() as {
    source: string
    c: number
  }[]) {
    bySource[r.source] = r.c
  }
  return { total, byKind, bySource }
}

/** The newest rules, for showing the user what the app thinks it knows. */
export function recentRules(limit = 40): KnowledgeRule[] {
  const rows = getDb()
    .prepare('SELECT * FROM knowledge_rule ORDER BY id DESC LIMIT ?')
    .all(limit) as Row[]
  return rows.map((r) => toRule(r))
}
