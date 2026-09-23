/**
 * Two different operations write rows into the one `switch_journal` table.
 *
 * A PROFILE SWITCH journals the whole game folder: its manifest is every live
 * file of the profile being left, game-relative, and "Restore previous state"
 * is allowed to vacate the active profile and put that manifest back.
 *
 * A VARIANT SWAP journals a handful of files inside one mod's store folder:
 * its manifest is store-relative and it describes one option of one group.
 * Restoring it over the active profile would tear the profile down and leave
 * those few files in the game root in its place - reported as a success,
 * because nothing in the restore path can tell the two apart by looking at a
 * row's states or timestamps. They share every terminal state.
 *
 * So the kind is recorded, and every consumer picks the kind it means. These
 * helpers are pure and live in `shared/` on purpose: the decision they encode
 * is the one that matters, and it is testable without a database.
 */

export type SwitchJournalKind = 'profile-switch' | 'variant-swap'

/** The states a journal can be restored or recovered from. */
const OPEN_OR_TERMINAL = new Set(['applied', 'verified', 'failed'])

/**
 * The kind of a raw `switch_journal` row.
 *
 * `kind` has only existed since schema 12. A row written by an earlier build
 * is read here too, and correctly: before schema 11 there were no variant
 * swaps at all, and from 11 onwards a variant swap is exactly the row with a
 * `variant_swap_json` payload - which is how the 12 migration backfills the
 * column in the first place. A persisted row therefore reads the same whether
 * the column is there or not.
 */
export function journalKindOf(row: { kind?: string | null; variant_swap_json?: string | null }): SwitchJournalKind {
  if (row.kind === 'variant-swap') return 'variant-swap'
  if (row.kind === 'profile-switch') return 'profile-switch'
  return row.variant_swap_json ? 'variant-swap' : 'profile-switch'
}

/**
 * Whether "Restore previous state" may act on this journal. A variant swap
 * never qualifies, whatever state it reached - it is not a previous state of
 * the game folder and was never a switch away from anything.
 */
export function isRestorableProfileSwitch(journal: {
  kind: SwitchJournalKind
  state: string
  restoredAt: string | null
}): boolean {
  return journal.kind === 'profile-switch' && journal.restoredAt === null && OPEN_OR_TERMINAL.has(journal.state)
}

/**
 * What a stale variant-swap journal found at boot should do about the install
 * it belongs to.
 *
 * The install row is the ground truth - SQLite's atomicity means it is never
 * caught mid-write - so the only safe question is "which option does the row
 * name NOW?", answered against both ends of the swap rather than against one:
 *
 * - it names the option the swap was going to: the swap committed, only the
 *   materialisation may be unfinished, so link it again;
 * - it still names the option the swap was leaving: the swap never committed,
 *   so put the outgoing bytes back;
 * - it names NEITHER (a later swap of the same group already succeeded, or the
 *   group was reshaped by a reinstall so its id no longer resolves): this
 *   journal describes a state that is no longer anybody's. Restoring its
 *   manifest would overwrite a newer, legitimate choice with bytes from before
 *   it. Stand down and close the journal instead.
 */
export type VariantRecovery = 'materialise-again' | 'restore-outgoing' | 'stand-down'

export function decideVariantRecovery(
  record: { fromOptionId: string; toOptionId: string },
  chosenOptionId: string | null | undefined
): VariantRecovery {
  if (chosenOptionId === record.toOptionId) return 'materialise-again'
  if (chosenOptionId === record.fromOptionId) return 'restore-outgoing'
  return 'stand-down'
}
