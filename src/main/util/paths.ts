import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { gameDefinition, type GameKind } from '@shared/games'

/** All Modão-owned locations live under userData; the game folder is never used as storage. */
export const Paths = {
  userData: () => app.getPath('userData'),
  db: () => path.join(app.getPath('userData'), 'modao.db'),
  /** Content-addressed mod payload store: store/mods/<key>/... */
  store: () => ensure(path.join(app.getPath('userData'), 'store')),
  storeMods: () => ensure(path.join(app.getPath('userData'), 'store', 'mods')),
  /** Downloaded archives, keyed by sha256. */
  archives: () => ensure(path.join(app.getPath('userData'), 'store', 'archives')),
  /** Scratch space for extraction while planning. */
  staging: () => ensure(path.join(app.getPath('userData'), 'staging')),
  /** Nothing is ever deleted; it is moved here. */
  quarantine: () => ensure(path.join(app.getPath('userData'), 'quarantine')),
  /** HTTP response cache for the catalog crawler. */
  httpCache: () => ensure(path.join(app.getPath('userData'), 'cache', 'http')),
  profile: (id: number) => ensure(path.join(app.getPath('userData'), 'profiles', String(id))),
  profileSaves: (id: number) => ensure(path.join(app.getPath('userData'), 'profiles', String(id), 'saves')),
  profileSnapshots: (id: number) =>
    ensure(path.join(app.getPath('userData'), 'profiles', String(id), 'snapshots')),
  profileBackups: (id: number) => ensure(path.join(app.getPath('userData'), 'profiles', String(id), 'backups')),
  logs: () => ensure(path.join(app.getPath('userData'), 'logs')),
  /** Bundled read-only data (seed catalog, CrashList.txt). */
  resources: () => {
    const packaged = path.join(process.resourcesPath ?? '', 'seed')
    if (fs.existsSync(packaged)) return packaged
    return path.join(app.getAppPath(), 'resources', 'seed')
  },
  /**
   * The save folder in Documents, which differs per game - "GTA San Andreas
   * User Files", "GTA3 User Files", and so on. Overridable so portable installs
   * and the end-to-end self-check never touch the real one.
   */
  userFiles: (kind: GameKind = 'sa') =>
    process.env['MODAO_USER_FILES'] ?? path.join(app.getPath('documents'), gameDefinition(kind).userFilesDir)
}

function ensure(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}

export function ensureDir(p: string): string {
  fs.mkdirSync(p, { recursive: true })
  return p
}
