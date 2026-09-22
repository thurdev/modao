import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { Paths } from '../util/paths'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (db) return db
  const file = Paths.db()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new Database(file)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  return db
}

interface Migration {
  version: number
  name: string
  up: (d: Database.Database) => void
}

/**
 * Migrations are append-only. Each runs exactly once, inside a transaction,
 * and the schema version is recorded so an upgrade never loses user data.
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: (d) => {
      d.exec(`
      CREATE TABLE game_install (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        exe_size INTEGER,
        exe_sha256 TEXT,
        exe_timestamp INTEGER,
        large_address_aware INTEGER DEFAULT 0,
        asi_directory TEXT,
        asi_loader TEXT,
        modloader_version TEXT,
        cleo_version TEXT,
        adopted_at TEXT,
        is_active INTEGER DEFAULT 0
      );

      CREATE TABLE profile (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        color TEXT NOT NULL DEFAULT '#6c8cff',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        last_played_at TEXT,
        is_active INTEGER NOT NULL DEFAULT 0,
        game_id INTEGER REFERENCES game_install(id) ON DELETE CASCADE
      );

      CREATE TABLE mod (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        category TEXT NOT NULL DEFAULT '',
        source_url TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        images_json TEXT NOT NULL DEFAULT '[]',
        videos_json TEXT NOT NULL DEFAULT '[]',
        requirements_json TEXT NOT NULL DEFAULT '[]',
        incompatible_json TEXT NOT NULL DEFAULT '[]',
        readme TEXT,
        paywalled INTEGER NOT NULL DEFAULT 0,
        published_at TEXT,
        updated_at TEXT,
        rating_inputs_json TEXT NOT NULL DEFAULT '{}',
        first_seen_at TEXT NOT NULL,
        last_indexed_at TEXT,
        etag TEXT,
        last_modified TEXT
      );

      CREATE TABLE mod_version (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mod_id INTEGER NOT NULL REFERENCES mod(id) ON DELETE CASCADE,
        version_label TEXT NOT NULL,
        release_date TEXT,
        download_url TEXT,
        file_size INTEGER,
        sha256 TEXT,
        changelog TEXT
      );
      CREATE INDEX idx_mod_version_mod ON mod_version(mod_id);

      CREATE TABLE install (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
        mod_version_id INTEGER NOT NULL REFERENCES mod_version(id) ON DELETE CASCADE,
        installed_at TEXT NOT NULL,
        destination_class TEXT NOT NULL,
        variant_choice TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 50,
        store_key TEXT,
        folder_name TEXT,
        readme_text TEXT,
        source_archive TEXT
      );
      CREATE INDEX idx_install_profile ON install(profile_id);

      CREATE TABLE install_file (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        install_id INTEGER NOT NULL REFERENCES install(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        sha256 TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        was_overwrite INTEGER NOT NULL DEFAULT 0,
        backup_path TEXT,
        destination_class TEXT NOT NULL DEFAULT 'modloader-folder'
      );
      CREATE INDEX idx_install_file_install ON install_file(install_id);

      CREATE TABLE provides (
        install_id INTEGER NOT NULL REFERENCES install(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        sha256 TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (install_id, relative_path)
      );
      CREATE INDEX idx_provides_path ON provides(relative_path);

      CREATE TABLE dependency (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mod_id INTEGER NOT NULL REFERENCES mod(id) ON DELETE CASCADE,
        requires_mod_id INTEGER REFERENCES mod(id) ON DELETE CASCADE,
        requires_slug TEXT,
        kind TEXT NOT NULL,
        version_range TEXT,
        alt_group TEXT,
        note TEXT
      );
      CREATE INDEX idx_dependency_mod ON dependency(mod_id);

      CREATE TABLE save_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL REFERENCES profile(id) ON DELETE CASCADE,
        taken_at TEXT NOT NULL,
        path TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        auto INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX idx_snapshot_profile ON save_snapshot(profile_id);

      CREATE TABLE crash_report (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER REFERENCES profile(id) ON DELETE SET NULL,
        occurred_at TEXT NOT NULL,
        fault_offset TEXT,
        module TEXT,
        exception_code TEXT,
        crash_address TEXT,
        matched_cause TEXT,
        matched_solution TEXT,
        kind TEXT NOT NULL DEFAULT 'exception',
        raw TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        UNIQUE(occurred_at, fault_offset, module)
      );

      CREATE TABLE telemetry (
        mod_id INTEGER PRIMARY KEY REFERENCES mod(id) ON DELETE CASCADE,
        install_count INTEGER NOT NULL DEFAULT 0,
        early_disable_count INTEGER NOT NULL DEFAULT 0,
        last_installed_at TEXT
      );

      CREATE TABLE setting (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE transaction_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        install_id INTEGER,
        profile_id INTEGER,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      `)
    }
  },
  {
    version: 2,
    name: 'submod-toggle',
    up: (d) => {
      d.exec(`
      CREATE TABLE submod_state (
        install_id INTEGER NOT NULL REFERENCES install(id) ON DELETE CASCADE,
        relative_path TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (install_id, relative_path)
      );
      `)
    }
  }
  ,
  {
    version: 3,
    name: 'mod-page-blocks',
    up: (d) => {
      // The mod page as its author laid it out: text, screenshots, headings and
      // videos in order. Kept beside the flat description so search still works
      // on plain text.
      d.exec("ALTER TABLE mod ADD COLUMN blocks_json TEXT NOT NULL DEFAULT '[]'")
    }
  },
  {
    version: 4,
    name: 'switch-journal-and-crash-modules',
    up: (d) => {
      // A profile switch removes files from the user's game folder, so it is a
      // transaction with a written record: what was snapshotted, where it went,
      // and whether the result verified. Without this row there is nothing to
      // roll back to.
      d.exec(`
      CREATE TABLE switch_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        from_profile_id INTEGER,
        to_profile_id INTEGER NOT NULL,
        state TEXT NOT NULL,
        snapshot_dir TEXT NOT NULL,
        manifest_json TEXT NOT NULL DEFAULT '[]',
        verification_json TEXT,
        error TEXT,
        restored_at TEXT
      );
      CREATE INDEX idx_switch_journal_state ON switch_journal(state, started_at);
      `)
      // A fault offset only means an exe address when the faulting module IS the
      // exe; for a DLL it is relative to that DLL, and the pid is what groups the
      // several records one dying process writes.
      d.exec("ALTER TABLE crash_report ADD COLUMN process_id TEXT")
      d.exec("ALTER TABLE crash_report ADD COLUMN module_unloaded INTEGER NOT NULL DEFAULT 0")
      d.exec("ALTER TABLE crash_report ADD COLUMN address_kind TEXT")
      d.exec("ALTER TABLE crash_report ADD COLUMN address_note TEXT")
    }
  },
  {
    version: 5,
    name: 'multi-game',
    up: (d) => {
      // Everything indexed so far is San Andreas, which is what the app managed
      // until now, so that is the default for existing rows.
      d.exec("ALTER TABLE game_install ADD COLUMN kind TEXT NOT NULL DEFAULT 'sa'")
      // Which games a catalogue post is for. Derived from the post title and its
      // categories, stored so Browse can filter without re-parsing every row.
      d.exec("ALTER TABLE mod ADD COLUMN games_json TEXT NOT NULL DEFAULT '[]'")
      d.exec("ALTER TABLE profile ADD COLUMN game_kind TEXT")
      d.exec('CREATE INDEX IF NOT EXISTS idx_profile_game ON profile(game_id)')
    }
  }
]

function migrate(d: Database.Database): void {
  d.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
  const rows = d.prepare('SELECT version FROM schema_migration').all() as { version: number }[]
  const applied = new Set(rows.map((r) => r.version))
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue
    const run = d.transaction(() => {
      m.up(d)
      d.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?,?,?)').run(
        m.version,
        m.name,
        new Date().toISOString()
      )
    })
    run()
  }
}

export function getSetting(key: string, fallback: string | null = null): string | null {
  const row = getDb().prepare('SELECT value FROM setting WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value : fallback
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO setting (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value)
}

export function closeDb(): void {
  db?.close()
  db = null
}
