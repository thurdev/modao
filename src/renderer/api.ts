import type { IpcChannel } from '@shared/ipc'
import type { LaunchBlocker } from '@shared/launchGate'
import type {
  AppSettings,
  CacheKind,
  ExistingSavesReport,
  StorageReport,
  UnmanagedReport,
  WriteAccess,
  BisectSession,
  CatalogMod,
  CrashIncident,
  CrashReport,
  DeepAnalysisResult,
  FileConflict,
  GameInstall,
  HealthReport,
  KnowledgeReport,
  ModLoaderLogReport,
  ImgAnalysis,
  IfpAnalysis,
  InstallPlan,
  InstalledMod,
  LogEntry,
  PeInfo,
  Profile,
  SwitchJournal,
  SwitchPlan,
  SwitchVerification,
  UpdateStatus,
  Progress,
  SaveSnapshot,
  TxdAnalysis
} from '@shared/types'

/**
 * What a profile switch came back with. `ok: false` means it was refused after
 * materialising because the game folder does not hold what the profile says it
 * holds - nothing was activated, and `verification.blockingProblems` says why.
 */
export type ActivateOutcome = {
  profile: Profile | null
  elapsedMs: number
  log: string[]
  journalId: number | null
  verification: SwitchVerification | null
} & ({ ok: true } | { ok: false; verification: SwitchVerification; previousProfileName: string | null })

interface Bridge {
  invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown>
  onProgress(cb: (p: Progress) => void): () => void
  onToast(cb: (t: { kind: 'info' | 'error' | 'success'; message: string }) => void): () => void
  onUpdateEvent(cb: (event: { kind: 'progress' | 'ready' | 'error'; payload: unknown }) => void): () => void
}

/**
 * The bridge is read lazily, never at module load: the preload script and the
 * dev-server mock are both installed on `window`, and binding at import time
 * would capture whichever one happened to exist first.
 */
function bridge(): Bridge {
  const b = (window as unknown as { modao?: Bridge }).modao
  if (!b) throw new Error('The Modão IPC bridge is not available in this window.')
  return b
}

function call<T>(channel: IpcChannel, ...args: unknown[]): Promise<T> {
  return bridge().invoke(channel, ...args) as Promise<T>
}

export const api = {
  onProgress: (cb: (p: Progress) => void): (() => void) => bridge().onProgress(cb),
  onUpdateEvent: (cb: (event: { kind: 'progress' | 'ready' | 'error'; payload: unknown }) => void) =>
    bridge().onUpdateEvent(cb),
  onToast: (cb: (t: { kind: 'info' | 'error' | 'success'; message: string }) => void): (() => void) =>
    bridge().onToast(cb),

  checkUpdate: (force?: boolean) => call<UpdateStatus>('app:checkUpdate', force),
  dismissUpdate: (version: string) => call<void>('app:dismissUpdate', version),
  downloadUpdate: (andInstall = true) =>
    call<{ started: boolean; message: string }>('app:downloadUpdate', andInstall),
  installUpdate: () => call<void>('app:installUpdate'),
  knowledge: () => call<KnowledgeReport>('app:knowledge'),
  forgetRule: (id: number) => call<void>('app:forgetRule', id),
  settings: () => call<AppSettings>('app:settings'),
  setSetting: (key: keyof AppSettings, value: unknown) => call<AppSettings>('app:setSetting', key, value),
  openExternal: (url: string) => call<void>('app:openExternal', url),
  revealPath: (p: string) => call<void>('app:revealPath', p),
  versions: () => call<{ app: string; electron: string; node: string }>('app:version'),
  storage: () => call<StorageReport>('app:storage'),
  clearCache: (kind: CacheKind) => call<{ freed: number }>('app:clearCache', kind),
  elevation: () =>
    call<{ running: boolean; needed: boolean; remembered: boolean; reason: string | null; protectedPath: boolean }>(
      'app:elevation'
    ),
  relaunchElevated: (remember: boolean) => call<void>('app:relaunchElevated', remember),
  recheckAccess: () => call<WriteAccess>('app:recheckAccess'),

  games: () => call<GameInstall[]>('game:list'),
  detectGames: () => call<string[]>('game:detect'),
  addGame: (p: string) => call<GameInstall>('game:add', p),
  pickGameFolder: () => call<string | null>('game:pickFolder'),
  setActiveGame: (id: number) => call<GameInstall>('game:setActive', id),
  activeGame: () => call<GameInstall | null>('game:active'),
  adopt: (gameId: number, profileName: string) =>
    call<{ profileId: number; adopted: number; report: string[] }>('game:adopt', gameId, profileName),
  adoptInto: (profileId: number) =>
    call<{ profileId: number; adopted: number; report: string[] }>('game:adoptInto', profileId),
  unmanaged: (profileId: number) => call<UnmanagedReport>('game:unmanaged', profileId),
  removeGame: (id: number) => call<void>('game:remove', id),
  launch: (force?: boolean) =>
    call<{ launched: boolean; message: string; blockers?: LaunchBlocker[] }>('game:launch', force),

  profiles: () => call<Profile[]>('profiles:list'),
  activeProfile: () => call<Profile | null>('profiles:active'),
  createProfile: (input: { name: string; color?: string; notes?: string; copyFrom?: number }) =>
    call<Profile>('profiles:create', input),
  updateProfile: (id: number, patch: { name?: string; color?: string; notes?: string }) =>
    call<Profile>('profiles:update', id, patch),
  removeProfile: (id: number) => call<void>('profiles:remove', id),
  /**
   * `ok: false` is a switch that materialised and then failed reconciliation:
   * the profile was NOT activated, the previous one still is, and `verification`
   * names every mod that did not reach the game folder. It comes back as a
   * value rather than a thrown message so the caller can show the report and
   * offer the rollback.
   */
  activateProfile: (id: number) =>
    call<ActivateOutcome>('profiles:activate', id),
  /** What a switch would do, file by file. Changes nothing. */
  switchPlan: (id: number) => call<SwitchPlan>('profiles:switchPlan', id),
  verifyProfile: (id: number) => call<SwitchVerification>('profiles:verify', id),
  restorePreviousSwitch: (journalId?: number) =>
    call<{ log: string[]; restored: number }>('profiles:restorePrevious', journalId),
  switchHistory: () => call<SwitchJournal[]>('profiles:switchHistory'),
  forgetMissing: (profileId: number) =>
    call<{ installId: number; label: string; files: string[] }[]>('profiles:forgetMissing', profileId),
  duplicateProfile: (id: number, name: string) => call<Profile>('profiles:duplicate', id, name),
  exportProfile: (id: number) => call<string | null>('profiles:exportArchive', id),
  importProfile: () =>
    call<{ profileId: number; resolved: number; unresolved: string[]; needsDownload: string[] } | null>(
      'profiles:importArchive'
    ),

  library: (profileId: number) => call<InstalledMod[]>('library:list', profileId),
  setEnabled: (installId: number, enabled: boolean) => call<void>('library:setEnabled', installId, enabled),
  setPriority: (installId: number, priority: number) => call<void>('library:setPriority', installId, priority),
  setLoadFirst: (installId: number, loadFirst: boolean) => call<void>('library:setLoadFirst', installId, loadFirst),
  uninstall: (installId: number) =>
    call<{ restored: number; quarantined: string[]; quarantineDir: string; kept: string[] }>('library:uninstall', installId),
  rollbackPreview: (installId: number) => call<{ relativePath: string; action: string }[]>('library:rollbackPreview', installId),
  readme: (installId: number) => call<string | null>('library:readme', installId),
  setSubModEnabled: (installId: number, rel: string, enabled: boolean) =>
    call<void>('library:subModSetEnabled', installId, rel, enabled),
  setVariant: (installId: number, groupId: string, optionId: string) =>
    call<void>('library:setVariant', installId, groupId, optionId),

  catalog: (query: {
    search?: string
    category?: string
    sort?: string
    installedOnly?: boolean
    limit?: number
    offset?: number
    includeArticles?: boolean
  }) =>
    call<{ mods: CatalogMod[]; categories: string[]; total: number }>('catalog:list', query),
  catalogMod: (modId: number) => call<CatalogMod | null>('catalog:get', modId),
  refreshMod: (modId: number) => call<CatalogMod | null>('catalog:refresh', modId),
  crawl: () => call<{ started: boolean; taskId: string; message: string }>('catalog:crawl'),
  seedInfo: () => call<{ count: number; lastCrawl: string | null; crawlEnabled: boolean }>('catalog:seedInfo'),
  reseed: () => call<{ count: number }>('catalog:reseed'),

  planFromCatalog: (modVersionId: number, profileId: number) => call<InstallPlan>('install:planFromCatalog', modVersionId, profileId),
  planFromSlug: (slug: string, profileId: number) => call<InstallPlan>('install:planFromSlug', slug, profileId),
  planFromFile: (profileId: number) => call<InstallPlan | null>('install:planFromFile', profileId),
  choose: (planId: string, groupId: string, optionId: string) => call<InstallPlan>('install:choose', planId, groupId, optionId),
  chooseAddOn: (planId: string, addOnId: string, enabled: boolean) =>
    call<InstallPlan>('install:chooseAddOn', planId, addOnId, enabled),
  setDestination: (planId: string, sourcePath: string, destination: string) =>
    call<InstallPlan>('install:setDestination', planId, sourcePath, destination),
  /** `acknowledgedUnparsedReadme` answers the readme-unparsed warning; without it the main process refuses. */
  applyPlan: (planId: string, profileId: number, acknowledgedUnparsedReadme: boolean) =>
    call<{ installId: number; written: number; backedUp: number }>(
      'install:apply',
      planId,
      profileId,
      acknowledgedUnparsedReadme
    ),
  discardPlan: (planId: string) => call<void>('install:discard', planId),

  conflicts: (profileId: number) => call<FileConflict[]>('conflicts:list', profileId),
  previewConflicts: (profileId: number, changes: { installId: number; priority: number }[]) =>
    call<FileConflict[]>('conflicts:preview', profileId, changes),
  applyPriorities: (profileId: number, changes: { installId: number; priority: number }[]) =>
    call<void>('conflicts:applyPriorities', profileId, changes),

  analyzeTxd: (p: string) => call<TxdAnalysis>('analyze:txd', p),
  analyzeIfp: (p: string) => call<IfpAnalysis>('analyze:ifp', p),
  analyzeImg: (p: string) => call<ImgAnalysis>('analyze:img', p),
  analyzePe: (p: string) => call<PeInfo>('analyze:pe', p),
  profileTextures: (profileId: number) => call<TxdAnalysis[]>('analyze:profileTextures', profileId),

  saves: (profileId: number) => call<SaveSnapshot[]>('saves:list', profileId),
  snapshot: (profileId: number, label: string) => call<SaveSnapshot>('saves:snapshot', profileId, label),
  restoreSnapshot: (id: number) => call<void>('saves:restore', id),
  currentSlots: (profileId: number) => call<SaveSnapshot | null>('saves:currentSlots', profileId),
  detectExistingSaves: () => call<ExistingSavesReport>('saves:detectExisting'),
  importExistingSaves: (profileId: number, label: string) =>
    call<{ snapshotId: number; slots: number }>('saves:importExisting', profileId, label),

  health: (profileId: number) => call<HealthReport>('health:run', profileId),
  crashes: (profileId: number) => call<CrashReport[]>('health:crashes', profileId),
  /** The same records grouped into one entry per dead process. */
  crashIncidents: (profileId: number) => call<CrashIncident[]>('health:incidents', profileId),
  scanCrashes: (profileId: number) =>
    call<{ found: number; added: number; hangSuspected: boolean; message: string }>('health:scanCrashes', profileId),
  resolveCrash: (id: number, resolved: boolean) => call<void>('health:resolveCrash', id, resolved),
  lookupAddress: (address: string) =>
    call<{ address: string; cause: string | null; solution: string | null }>('health:lookupAddress', address),
  deepAnalyze: (address: string) => call<DeepAnalysisResult>('health:deepAnalyze', address),
  fixStreamingMemory: (memoryMb?: number) =>
    call<{ file: string; backup: string; from: number | null; to: number }>('health:fixStreamingMemory', memoryMb),
  reuniteOrphans: (profileId: number | null) =>
    call<{ moved: string[]; quarantined: string[]; refused: string[] }>('health:reuniteOrphans', profileId),
  modLoaderReport: (profileId: number) => call<ModLoaderLogReport | null>('health:modLoaderReport', profileId),
  logs: (profileId: number) => call<LogEntry[]>('health:logs', profileId),
  bisectStart: (profileId: number) => call<BisectSession>('health:bisectStart', profileId),
  bisectResult: (sessionId: string, result: 'good' | 'bad') => call<BisectSession>('health:bisectResult', sessionId, result),
  bisectAbort: (sessionId: string) => call<void>('health:bisectAbort', sessionId),
  bisectCurrent: (profileId: number) => call<BisectSession | null>('health:bisectCurrent', profileId),

  cancelTask: (taskId: string) => call<void>('tasks:cancel', taskId)
}

export function formatBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function formatDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * "3 d atrás". Takes the translator so the renderer can say it in the user's
 * language; without one it falls back to English, which is what logs want.
 */
export function relativeTime(iso: string | null, t?: (key: string, vars?: Record<string, string | number>) => string): string {
  const say = (key: string, vars?: Record<string, string | number>): string =>
    t ? t(key, vars) : EN_RELATIVE[key](vars ?? {})
  if (!iso) return say('time.never')
  const diff = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(diff)) return iso
  const mins = Math.round(diff / 60000)
  if (mins < 1) return say('time.justNow')
  if (mins < 60) return say('time.minutes', { count: mins })
  const hours = Math.round(mins / 60)
  if (hours < 24) return say('time.hours', { count: hours })
  const days = Math.round(hours / 24)
  if (days < 30) return say('time.days', { count: days })
  return formatDate(iso)
}

const EN_RELATIVE: Record<string, (v: Record<string, string | number>) => string> = {
  'time.never': () => 'never',
  'time.justNow': () => 'just now',
  'time.minutes': (v) => `${v['count']} min ago`,
  'time.hours': (v) => `${v['count']} h ago`,
  'time.days': (v) => `${v['count']} d ago`
}

