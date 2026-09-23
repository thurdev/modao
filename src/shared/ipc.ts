import type { GameKind } from './games'
import type { LaunchBlocker } from './launchGate'
import type {
  AppSettings,
  BisectSession,
  CacheKind,
  CatalogMod,
  CrashIncident,
  CrashReport,
  DeepAnalysisResult,
  ExistingSavesReport,
  FileConflict,
  GameInstall,
  HealthReport,
  KnowledgeReport,
  ModLoaderLogReport,
  SwitchJournal,
  SwitchPlan,
  SwitchVerification,
  UpdateStatus,
  IfpAnalysis,
  ImgAnalysis,
  InstallPlan,
  InstalledMod,
  LogEntry,
  PeInfo,
  Profile,
  Progress,
  SaveSnapshot,
  StorageReport,
  UnmanagedReport,
  WriteAccess,
  TxdAnalysis
} from './types'

/** Every IPC channel the renderer may call. Keep this list narrow and typed. */
export interface ModãoApi {
  app: {
    /** Is there a newer release? Never installs anything by itself. */
    checkUpdate(force?: boolean): Promise<UpdateStatus>
    /** Stop offering this exact version. */
    dismissUpdate(version: string): Promise<void>
    /** Download the update the user asked for. Progress arrives as events. */
    downloadUpdate(andInstall?: boolean): Promise<{ started: boolean; message: string }>
    /** Replace the app with the downloaded version and start it again. */
    installUpdate(): Promise<void>
    /** Everything the app has learned, with its evidence. */
    knowledge(): Promise<KnowledgeReport>
    /** Forget one learned rule. */
    forgetRule(id: number): Promise<void>
    settings(): Promise<AppSettings>
    setSetting(key: keyof AppSettings, value: unknown): Promise<AppSettings>
    openExternal(url: string): Promise<void>
    revealPath(path: string): Promise<void>
    version(): Promise<{ app: string; electron: string; node: string }>
    storage(): Promise<StorageReport>
    clearCache(kind: CacheKind): Promise<{ freed: number }>
    /** Whether the app is elevated, and whether this game folder needs it. */
    elevation(): Promise<{ running: boolean; needed: boolean; remembered: boolean; reason: string | null; protectedPath: boolean }>
    /** Relaunch through the Windows UAC prompt; optionally remember the choice. */
    relaunchElevated(remember: boolean): Promise<void>
    /** Re-run the write probe after the user changed permissions or moved the game. */
    recheckAccess(): Promise<WriteAccess>
  }
  game: {
    list(): Promise<GameInstall[]>
    detect(): Promise<{ path: string; kind: GameKind; name: string }[]>
    add(path: string, kind?: GameKind): Promise<GameInstall>
    pickFolder(): Promise<string | null>
    setActive(id: number): Promise<GameInstall>
    active(): Promise<GameInstall | null>
    adopt(gameId: number, profileName: string): Promise<{ profileId: number; adopted: number; report: string[] }>
    /** Index whatever is in the game folder into an existing profile. */
    adoptInto(profileId: number): Promise<{ profileId: number; adopted: number; report: string[] }>
    /** What the game folder holds that this profile does not track yet. */
    unmanaged(profileId: number): Promise<UnmanagedReport>
    remove(id: number): Promise<void>
    /**
     * Starts the game - unless the pre-launch check has a blocking finding, in
     * which case nothing is started and the finding comes back named in
     * `blockers`. `force` is the user saying "launch anyway" after reading it.
     */
    launch(force?: boolean): Promise<{ launched: boolean; message: string; blockers?: LaunchBlocker[] }>
  }
  profiles: {
    list(): Promise<Profile[]>
    active(): Promise<Profile | null>
    create(input: { name: string; color: string; notes: string; copyFrom?: number }): Promise<Profile>
    update(id: number, patch: { name?: string; color?: string; notes?: string }): Promise<Profile>
    remove(id: number): Promise<void>
    activate(id: number): Promise<{
      profile: Profile
      elapsedMs: number
      log: string[]
      journalId: number | null
      verification: SwitchVerification | null
    }>
    /** What a switch would do, file by file. Changes nothing. */
    switchPlan(id: number): Promise<SwitchPlan>
    /** Re-runs the post-switch checks for the active profile. */
    verify(id: number): Promise<SwitchVerification>
    /** Rolls the last switch back using its verified backup. */
    restorePrevious(journalId?: number): Promise<{ log: string[]; restored: number }>
    /** Recorded switches, newest first. */
    switchHistory(): Promise<SwitchJournal[]>
    /** Drop installs whose files are gone from both the game folder and the store. */
    forgetMissing(profileId: number): Promise<{ installId: number; label: string; files: string[] }[]>
    duplicate(id: number, name: string): Promise<Profile>
    exportArchive(id: number): Promise<string | null>
    importArchive(): Promise<{
      profileId: number
      resolved: number
      needsDownload: string[]
      unresolved: string[]
    } | null>
  }
  library: {
    list(profileId: number): Promise<InstalledMod[]>
    setEnabled(installId: number, enabled: boolean): Promise<void>
    setPriority(installId: number, priority: number): Promise<void>
    /**
     * Spells the mod folder with, or without, the "$" that makes its .asi load
     * first. LOAD ORDER, not priority - the two are separate calls because they
     * are separate Mod Loader mechanisms.
     */
    setLoadFirst(installId: number, loadFirst: boolean): Promise<void>
    uninstall(installId: number): Promise<{ restored: number; quarantined: string[] }>
    rollbackPreview(installId: number): Promise<{ relativePath: string; action: string }[]>
    readme(installId: number): Promise<string | null>
    subModSetEnabled(installId: number, relativePath: string, enabled: boolean): Promise<void>
    /** Switches to another option of a variant group already installed, without re-downloading. */
    setVariant(installId: number, groupId: string, optionId: string): Promise<void>
  }
  catalog: {
    list(query: {
      search?: string
      category?: string
      sort?: 'rating' | 'updated' | 'title' | 'author'
      installedOnly?: boolean
      limit?: number
    }): Promise<{ mods: CatalogMod[]; categories: string[]; total: number }>
    get(modId: number): Promise<CatalogMod | null>
    refresh(modId: number): Promise<CatalogMod | null>
    crawl(): Promise<{ started: boolean; taskId: string; message: string }>
    seedInfo(): Promise<{ count: number; lastCrawl: string | null; crawlEnabled: boolean }>
    reseed(): Promise<{ count: number }>
  }
  install: {
    planFromCatalog(modVersionId: number, profileId: number): Promise<InstallPlan>
    /** Start the same install from a slug, for a requirement named in a readme. */
    planFromSlug(slug: string, profileId: number): Promise<InstallPlan>
    planFromFile(profileId: number): Promise<InstallPlan | null>
    choose(planId: string, groupId: string, optionId: string): Promise<InstallPlan>
    /** Enables or drops an add-on folder offered beside the plan. */
    chooseAddOn(planId: string, addOnId: string, enabled: boolean): Promise<InstallPlan>
    setDestination(planId: string, sourcePath: string, destination: string): Promise<InstallPlan>
    apply(planId: string, profileId: number): Promise<{ installId: number; written: number; backedUp: number }>
    discard(planId: string): Promise<void>
  }
  conflicts: {
    list(profileId: number): Promise<FileConflict[]>
    preview(profileId: number, changes: { installId: number; priority: number }[]): Promise<FileConflict[]>
    applyPriorities(profileId: number, changes: { installId: number; priority: number }[]): Promise<void>
  }
  analyze: {
    txd(path: string): Promise<TxdAnalysis>
    ifp(path: string): Promise<IfpAnalysis>
    img(path: string): Promise<ImgAnalysis>
    pe(path: string): Promise<PeInfo>
    profileTextures(profileId: number): Promise<TxdAnalysis[]>
  }
  saves: {
    list(profileId: number): Promise<SaveSnapshot[]>
    snapshot(profileId: number, label: string): Promise<SaveSnapshot>
    restore(snapshotId: number): Promise<void>
    currentSlots(profileId: number): Promise<SaveSnapshot | null>
    detectExisting(): Promise<ExistingSavesReport>
    importExisting(profileId: number, label: string): Promise<{ snapshotId: number; slots: number }>
  }
  health: {
    run(profileId: number): Promise<HealthReport>
    crashes(profileId: number): Promise<CrashReport[]>
    /** The same records grouped into one entry per dead process. */
    incidents(profileId: number): Promise<CrashIncident[]>
    scanCrashes(profileId: number): Promise<{ found: number; added: number; hangSuspected: boolean; message: string }>
    resolveCrash(id: number, resolved: boolean): Promise<void>
    lookupAddress(address: string): Promise<{ address: string; cause: string | null; solution: string | null }>
    /** Not a disassembler: a VA-to-file-offset conversion plus a hex window, for an address CrashList had no entry for. */
    deepAnalyze(address: string): Promise<DeepAnalysisResult>
    logs(): Promise<LogEntry[]>
    /** What Mod Loader itself says it did with this profile's mods. */
    modLoaderReport(profileId: number): Promise<ModLoaderLogReport | null>
    /** Writes a streaming-memory value the game can survive, keeping a backup. */
    fixStreamingMemory(memoryMb?: number): Promise<{ file: string; backup: string; from: number | null; to: number }>
    /**
     * Moves an orphaned config's plugin back to the ASI directory, or puts the
     * stray config in quarantine when no plugin exists. Never deletes.
     */
    reuniteOrphans(profileId: number | null): Promise<{ moved: string[]; quarantined: string[]; refused: string[] }>
    bisectStart(profileId: number): Promise<BisectSession>
    bisectResult(sessionId: string, result: 'good' | 'bad'): Promise<BisectSession>
    bisectAbort(sessionId: string): Promise<void>
    bisectCurrent(profileId: number): Promise<BisectSession | null>
  }
  tasks: {
    cancel(taskId: string): Promise<void>
    onProgress(cb: (p: Progress) => void): () => void
    onToast(cb: (t: { kind: 'info' | 'error' | 'success'; message: string }) => void): () => void
  }
}

/** Flat channel list, derived at runtime from the shape above. */
export const IPC_CHANNELS = [
  'app:settings',
  'app:checkUpdate',
  'app:dismissUpdate',
  'app:downloadUpdate',
  'app:installUpdate',
  'app:knowledge',
  'app:forgetRule',
  'app:setSetting',
  'app:openExternal',
  'app:revealPath',
  'app:version',
  'app:storage',
  'app:clearCache',
  'app:elevation',
  'app:relaunchElevated',
  'app:recheckAccess',
  'game:list',
  'game:detect',
  'game:add',
  'game:pickFolder',
  'game:setActive',
  'game:active',
  'game:adopt',
  'game:adoptInto',
  'game:unmanaged',
  'game:remove',
  'game:launch',
  'profiles:list',
  'profiles:active',
  'profiles:create',
  'profiles:update',
  'profiles:remove',
  'profiles:activate',
  'profiles:switchPlan',
  'profiles:verify',
  'profiles:restorePrevious',
  'profiles:switchHistory',
  'profiles:forgetMissing',
  'profiles:duplicate',
  'profiles:exportArchive',
  'profiles:importArchive',
  'library:list',
  'library:setEnabled',
  'library:setPriority',
  'library:setLoadFirst',
  'library:uninstall',
  'library:rollbackPreview',
  'library:readme',
  'library:subModSetEnabled',
  'library:setVariant',
  'catalog:list',
  'catalog:get',
  'catalog:refresh',
  'catalog:crawl',
  'catalog:seedInfo',
  'catalog:reseed',
  'install:planFromCatalog',
  'install:planFromSlug',
  'install:planFromFile',
  'install:choose',
  'install:chooseAddOn',
  'install:setDestination',
  'install:apply',
  'install:discard',
  'conflicts:list',
  'conflicts:preview',
  'conflicts:applyPriorities',
  'analyze:txd',
  'analyze:ifp',
  'analyze:img',
  'analyze:pe',
  'analyze:profileTextures',
  'saves:list',
  'saves:snapshot',
  'saves:restore',
  'saves:currentSlots',
  'saves:detectExisting',
  'saves:importExisting',
  'health:run',
  'health:crashes',
  'health:incidents',
  'health:scanCrashes',
  'health:resolveCrash',
  'health:lookupAddress',
  'health:deepAnalyze',
  'health:logs',
  'health:modLoaderReport',
  'health:fixStreamingMemory',
  'health:reuniteOrphans',
  'health:bisectStart',
  'health:bisectResult',
  'health:bisectAbort',
  'health:bisectCurrent',
  'tasks:cancel'
] as const

export type IpcChannel = (typeof IPC_CHANNELS)[number]
export const EVENT_PROGRESS = 'event:progress'
export const EVENT_TOAST = 'event:toast'
