import { getDb } from '../db'
import {
  decideLearn,
  isLegacyCrashRule,
  migrateLegacyCrashValue,
  rankRules,
  SOURCE_WEIGHT,
  type KnowledgeRule,
  type LearnInput,
  type RuleKind,
  type RuleSource
} from '@shared/knowledgeRules'

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
 *
 * This file is the persistence only. What a rule IS, which source outranks
 * which, when a repeat strengthens a rule instead of duplicating it and how
 * confident the app is all live in `@shared/knowledgeRules`, where the unit
 * suite can reach them without Electron.
 */
export { SOURCE_WEIGHT }
export type { KnowledgeRule, LearnInput, RuleKind, RuleSource }

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

/**
 * Rows written before crash correlation had a kind of its own.
 *
 * `learnCrash` used to file a crash-to-mod-set correlation under `redundancy`,
 * which means something else entirely. The rows are real evidence and are kept
 * - they are moved to the kind they always were, once, in place. Anything else
 * filed as `redundancy` is left exactly as it is, and a store that never held
 * one of these (the writer was never called) simply updates nothing.
 *
 * This runs from the store rather than from a schema migration on purpose: the
 * rows' SHAPE did not change, only which kind they belong to, and a user who
 * upgrades must not lose them either way. The payload IS brought up to date -
 * the old writer had no `profileId` - by `migrateLegacyCrashValue`, which fills
 * it with `null` rather than inventing a profile for a crash recorded before
 * the app tracked one.
 */
let upgraded = false
function ensureUpgraded(): void {
  if (upgraded) return
  upgraded = true
  const db = getDb()
  const legacy = (
    db
      .prepare("SELECT id, kind, source, subject, value_json FROM knowledge_rule WHERE kind = 'redundancy' AND source = 'crash'")
      .all() as {
      id: number
      kind: string
      source: string
      subject: string
      value_json: string
    }[]
  ).filter(isLegacyCrashRule)
  if (legacy.length === 0) return
  // OR IGNORE: a correlation already relearned under the new kind keeps the
  // newer row, and the stale one is dropped rather than colliding on the
  // (kind, subject, subject_kind, source) uniqueness.
  const move = db.prepare("UPDATE OR IGNORE knowledge_rule SET kind = 'crash-correlation', value_json = ? WHERE id = ?")
  const drop = db.prepare("DELETE FROM knowledge_rule WHERE id = ? AND kind = 'redundancy'")
  db.transaction(() => {
    for (const row of legacy) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(row.value_json)
      } catch {
        // A payload that will not parse is still a real crash row; the subject
        // alone carries enough to rebuild it.
      }
      move.run(JSON.stringify(migrateLegacyCrashValue(parsed, row.subject)), row.id)
      drop.run(row.id)
    }
  })()
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
  ensureUpgraded()
  const db = getDb()
  const existing = db
    .prepare('SELECT * FROM knowledge_rule WHERE kind = ? AND subject = ? AND subject_kind = ? AND source = ?')
    .get(input.kind, input.subject, input.subjectKind, input.source) as Row | undefined

  const decision = decideLearn<T>(existing ? toRule<T>(existing) : null, input, new Date().toISOString())
  const valueJson = JSON.stringify(decision.rule.value)

  if (decision.action === 'bump') {
    db.prepare('UPDATE knowledge_rule SET value_json = ?, evidence = ?, times_seen = times_seen + 1 WHERE id = ?').run(
      valueJson,
      decision.rule.evidence,
      decision.rule.id
    )
    return decision.rule
  }

  const id = Number(
    db
      .prepare(
        `INSERT INTO knowledge_rule (kind, subject, subject_kind, source, evidence, value_json, weight, created_at, times_seen)
         VALUES (?,?,?,?,?,?,?,?,1)`
      )
      .run(
        decision.rule.kind,
        decision.rule.subject,
        decision.rule.subjectKind,
        decision.rule.source,
        decision.rule.evidence,
        valueJson,
        decision.rule.weight,
        decision.rule.createdAt
      ).lastInsertRowid
  )
  return { ...decision.rule, id }
}

/** Every rule for these subjects, strongest first. */
export function rulesFor<T>(kind: RuleKind, subjects: string[]): KnowledgeRule<T>[] {
  if (subjects.length === 0) return []
  ensureUpgraded()
  const placeholders = subjects.map(() => '?').join(',')
  const rows = getDb()
    .prepare(
      `SELECT * FROM knowledge_rule WHERE kind = ? AND subject IN (${placeholders})
        ORDER BY weight DESC, times_seen DESC, id DESC`
    )
    .all(kind, ...subjects) as Row[]
  // Ordered again in the shared ranking, so SQL and the unit suite can never
  // drift apart about which rule wins.
  return rankRules(rows.map((r) => toRule<T>(r)))
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
  ensureUpgraded()
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
  ensureUpgraded()
  const rows = getDb()
    .prepare('SELECT * FROM knowledge_rule ORDER BY id DESC LIMIT ?')
    .all(limit) as Row[]
  return rows.map((r) => toRule(r))
}
