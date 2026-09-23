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
  },
  {
    version: 6,
    name: 'knowledge',
    up: (d) => {
      // What the app has learned, and where each piece came from. The source is
      // stored because the difference between "the author wrote this" and "the
      // app guessed from a folder name" decides which one wins.
      d.exec(`
      CREATE TABLE knowledge_rule (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        subject TEXT NOT NULL,
        subject_kind TEXT NOT NULL,
        source TEXT NOT NULL,
        evidence TEXT NOT NULL,
        value_json TEXT NOT NULL,
        weight INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        times_seen INTEGER NOT NULL DEFAULT 1,
        UNIQUE(kind, subject, subject_kind, source)
      );
      CREATE INDEX idx_knowledge_lookup ON knowledge_rule(kind, subject);
      `)
    }
  },
  {
    version: 7,
    name: 'forget-rules-learned-from-prose',
    up: (d) => {
      // The first version of the readme reader took "Extract the single folder
      // to the ModLoader folder" literally and learned a mod called "single
      // folder", then warned that every later plan disagreed with it. Those
      // rules were never true, so they go - the app relearns from the fixed
      // parser on the next install.
      d.exec(`
        DELETE FROM knowledge_rule
         WHERE kind = 'install-layout'
           AND (
             lower(value_json) LIKE '%"modfolder":"single folder"%'
             OR lower(value_json) LIKE '%"modfolder":"the mod"%'
             OR lower(value_json) LIKE '%"modfolder":"pasta"%'
             OR lower(value_json) LIKE '%"modfolder":"folder"%'
           );
        DELETE FROM knowledge_rule
         WHERE kind = 'dependency'
           AND (
             lower(value_json) LIKE '%vers_o do modloader%'
             OR lower(value_json) LIKE '%version of modloader%'
             OR lower(value_json) LIKE '%"name":"vers%'
           );
      `)
    }
  },
  {
    version: 8,
    name: 'drop-duplicate-and-re-adopted-installs',
    up: (d) => {
      // Adoption used to index a file an install had just placed, so a mod
      // whose payload is one .asi appeared twice: once as itself, once as
      // "TrilogyChaosMod.SA.asi". And installing the same mod again added a
      // second entry instead of replacing the first.
      //
      // Both are fixed at the source; these are the rows they already made.
      // Only bookkeeping is removed - every file stays exactly where it is,
      // still owned by the install that really provides it.
      d.exec(`
        DELETE FROM install WHERE id IN (
          SELECT a.id FROM install a
            JOIN mod_version amv ON amv.id = a.mod_version_id
            JOIN mod am ON am.id = amv.mod_id
           WHERE am.category = 'Adopted'
             AND a.store_key IS NULL
             AND EXISTS (
               SELECT 1 FROM install_file af
                 JOIN install_file bf ON lower(bf.relative_path) = lower(af.relative_path)
                 JOIN install b ON b.id = bf.install_id
                WHERE af.install_id = a.id AND b.id != a.id AND b.profile_id = a.profile_id
                  AND b.store_key IS NOT NULL
             )
             AND NOT EXISTS (
               SELECT 1 FROM install_file af
                WHERE af.install_id = a.id
                  AND NOT EXISTS (
                    SELECT 1 FROM install_file bf JOIN install b ON b.id = bf.install_id
                     WHERE lower(bf.relative_path) = lower(af.relative_path)
                       AND b.id != a.id AND b.profile_id = a.profile_id
                  )
             )
        );

        DELETE FROM install WHERE id IN (
          SELECT later.id FROM install later
           WHERE EXISTS (
             SELECT 1 FROM install earlier
              WHERE earlier.profile_id = later.profile_id
                AND earlier.mod_version_id = later.mod_version_id
                AND earlier.id < later.id
           )
        );
      `)
      // install_file and provides follow their install.
      d.exec('DELETE FROM install_file WHERE install_id NOT IN (SELECT id FROM install)')
      d.exec('DELETE FROM provides WHERE install_id NOT IN (SELECT id FROM install)')
    }
  },
  {
    version: 9,
    name: 'variant-groups-switchable-without-redownload',
    up: (d) => {
      // Every option of a variant group ("(0a- lowest)" … "(5 - very high)")
      // is snapshotted into the store at install time now, not just the one
      // chosen. This records which groups an install has and what its current
      // choice is, so a later switch can find and replace the right files
      // without ever needing the archive again.
      d.exec('ALTER TABLE install ADD COLUMN variant_groups_json TEXT')
    }
  },
  {
    version: 10,
    name: 'dependency-subject-addressed-by-slug',
    up: (d) => {
      // A curated edge's TARGET was always allowed to name a mod the catalogue
      // has never heard of - `requires_slug` is text, and that is why
      // "Proper Shaders conflicts ped-spec" works. Its SUBJECT was not: the
      // loader looked the subject up, found nothing, and dropped the row
      // without a word. `more-radar-icons requires cleoplus` was lost that way
      // at every startup, and every ItemFinders edge would have been too.
      //
      // Both ends are text now. `mod_id` stays for edges whose subject IS in
      // the catalogue (it carries the ON DELETE CASCADE), and becomes nullable
      // so an edge can outlive - or precede - the mod row it is about. Nothing
      // references `dependency`, so the rebuild is local to this table.
      d.exec(`
        CREATE TABLE dependency_rebuilt (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          mod_id INTEGER REFERENCES mod(id) ON DELETE CASCADE,
          mod_slug TEXT,
          requires_mod_id INTEGER REFERENCES mod(id) ON DELETE CASCADE,
          requires_slug TEXT,
          kind TEXT NOT NULL,
          version_range TEXT,
          alt_group TEXT,
          note TEXT
        );
        INSERT INTO dependency_rebuilt
          (id, mod_id, mod_slug, requires_mod_id, requires_slug, kind, version_range, alt_group, note)
          SELECT d.id, d.mod_id, (SELECT slug FROM mod WHERE id = d.mod_id),
                 d.requires_mod_id, d.requires_slug, d.kind, d.version_range, d.alt_group, d.note
            FROM dependency d;
        DROP TABLE dependency;
        ALTER TABLE dependency_rebuilt RENAME TO dependency;
        CREATE INDEX idx_dependency_mod ON dependency(mod_id);
        CREATE INDEX idx_dependency_mod_slug ON dependency(mod_slug);
      `)
    }
  },
  {
    version: 11,
    name: 'variant-swap-journalled-like-a-profile-switch',
    up: (d) => {
      // Switching a variant moves bytes in the store and rows in the database,
      // and for a junctioned mod the game folder shows the new bytes the
      // instant the store has them - before those rows commit. A thrown error
      // is rolled back in process; a kill or a power cut in that window used to
      // leave the two disagreeing with nothing to recover from, which is less
      // than a profile switch has offered since it was journalled.
      //
      // A swap now writes a switch_journal row like a switch does. This column
      // is what marks it as one and carries what the recovery needs: which
      // install and group, which option it was leaving, which it was going to,
      // and the exact paths on both sides.
      d.exec('ALTER TABLE switch_journal ADD COLUMN variant_swap_json TEXT')
    }
  },
  {
    version: 12,
    name: 'switch-journal-kind-discriminator',
    up: (d) => {
      // Sharing the table with a profile switch was right; sharing it with no
      // way to tell the two apart was not. A variant swap reaches the same
      // terminal states, leaves restored_at NULL the same way, and is simply
      // the newest row - so "Restore previous state" could pick one up,
      // dematerialise the WHOLE active profile, and put a handful of variant
      // files in the game root in its place, reporting success.
      //
      // The kind is now on the row, and every reader asks for the kind it
      // means. Rows a previous build wrote are backfilled exactly as
      // `journalKindOf` reads them: a variant swap is the row that carries a
      // variant_swap_json payload (nothing before schema 11 could have one),
      // and everything else was, and still is, a profile switch.
      d.exec("ALTER TABLE switch_journal ADD COLUMN kind TEXT NOT NULL DEFAULT 'profile-switch'")
      d.exec("UPDATE switch_journal SET kind = 'variant-swap' WHERE variant_swap_json IS NOT NULL")
      d.exec('CREATE INDEX IF NOT EXISTS idx_switch_journal_kind ON switch_journal(kind, state)')
    }
  },
  {
    version: 13,
    name: 'load-order-is-not-priority',
    up: (d) => {
      // Load order and priority are two different Mod Loader mechanisms and the
      // schema only ever had one of them. Priority (already here, 1-100) decides
      // who wins a duplicated file. LOAD ORDER decides which .asi hooks the game
      // first, it is alphabetical by mod folder name, and the only lever on it is
      // the "$" prefix - which sorts before every letter and digit.
      //
      // One flag, because one flag is the whole mechanic: a folder either carries
      // the prefix or it does not. Everything else about load order is derived
      // from the folder names themselves (`@shared/loadOrder`), so there is no
      // second ordering to keep in sync with the disk.
      d.exec('ALTER TABLE install ADD COLUMN load_first INTEGER NOT NULL DEFAULT 0')
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
