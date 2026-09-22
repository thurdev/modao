import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/** What the app called itself before, in the order to look for leftovers. */
const PREVIOUS_NAMES = ['modvault', 'ModVault']

/** The data directory, always ASCII: %APPDATA%\Modao, accent or no accent in the product name. */
export const DATA_DIR_NAME = 'Modao'

export interface DataMigration {
  moved: boolean
  from: string | null
  to: string
  note: string
}

/**
 * The app was called ModVault before it was called Modão, and Electron derives
 * the data directory from the app name. Renaming without bringing the directory
 * across would hand the user an empty library and a catalogue they spent an
 * evening indexing sitting in a folder nothing reads any more.
 *
 * Three rules keep this from doing harm:
 *
 *   - An explicit --user-data-dir wins. Tests and portable runs pass one, and a
 *     migration that ignored it once copied a running install's live database
 *     into a second directory, which is how you end up with two half-databases
 *     and no way to tell which is real.
 *   - The move is a rename or it does not happen. A rename cannot half-finish
 *     and Windows refuses it outright while another process holds a handle
 *     inside - which is exactly the case where copying would capture a database
 *     mid-write.
 *   - If the rename is refused, the app keeps using the OLD directory. Running
 *     on the user's real data beats running on a fresh empty one beside it.
 */
export function adoptUserDataDirectory(argv: string[] = process.argv): DataMigration {
  const explicit = argv.find((a) => a === '--user-data-dir' || a.startsWith('--user-data-dir='))
  if (explicit) {
    const dir = app.getPath('userData')
    return { moved: false, from: null, to: dir, note: `Using the data directory given on the command line: ${dir}` }
  }

  const appData = app.getPath('appData')
  const target = path.join(appData, DATA_DIR_NAME)

  const previous = PREVIOUS_NAMES.map((name) => path.join(appData, name)).find(
    (dir) => dir !== target && hasContent(dir)
  )

  if (hasContent(target) || !previous) {
    app.setPath('userData', target)
    return {
      moved: false,
      from: null,
      to: target,
      note: hasContent(target) ? 'Modão data directory already in use.' : 'Starting with a fresh data directory.'
    }
  }

  try {
    fs.renameSync(previous, target)
  } catch (e) {
    // Almost always: the old copy of the app is still running and holding the
    // database open. Use its directory rather than starting a second one.
    app.setPath('userData', previous)
    return {
      moved: false,
      from: previous,
      to: previous,
      note:
        `Could not move ${previous} to ${target} (${(e as Error).message}). ` +
        'Modão is running from the old directory instead, so nothing is duplicated. ' +
        'Close any other copy of the app and start it again to complete the move.'
    }
  }

  app.setPath('userData', target)
  renameDatabaseFile(target)
  return { moved: true, from: previous, to: target, note: `Moved your data from ${previous} to ${target}.` }
}

function hasContent(dir: string): boolean {
  try {
    return fs.readdirSync(dir).length > 0
  } catch {
    return false
  }
}

/** The database file carried the old name too; rename it beside its WAL and shm. */
function renameDatabaseFile(dir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const from = path.join(dir, `modvault.db${suffix}`)
    const to = path.join(dir, `modao.db${suffix}`)
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      try {
        fs.renameSync(from, to)
      } catch {
        // Leaving the old file in place is safe: a fresh database is created and
        // the user is told, which beats failing to start.
      }
    }
  }
}
