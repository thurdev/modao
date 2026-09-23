import type { Language } from './i18n'
import type { GameKind } from './games'
import type { OutdatedBuild } from './upstream'
import type { ActivationCode } from './activation'
import type { SwitchJournalKind } from './switchJournal'
/** Shared domain types. Imported by main, preload and renderer. */

export type DestinationClass =
  | 'modloader-folder'
  | 'asi-plugin'
  | 'cleo-plugin'
  | 'cleo-script'
  | 'root-file'
  | 'overlay'
  | 'unknown'

/**
 * The i18n key for each destination class. The English text lives in the
 * catalogue like every other string; this map only says which key to ask for.
 */
export const DESTINATION_KEYS: Record<DestinationClass, string> = {
  'modloader-folder': 'destinations.modloaderFolder',
  'asi-plugin': 'destinations.asiPlugin',
  'cleo-plugin': 'destinations.cleoPlugin',
  'cleo-script': 'destinations.cleoScript',
  'root-file': 'destinations.rootFile',
  overlay: 'destinations.overlay',
  unknown: 'destinations.unknown'
}

/** English fallbacks, for logs and for anything outside the renderer. */
export const DESTINATION_LABELS: Record<DestinationClass, string> = {
  'modloader-folder': 'Mod Loader folder',
  'asi-plugin': 'ASI plugin',
  'cleo-plugin': 'CLEO plugin',
  'cleo-script': 'CLEO script',
  'root-file': 'Game root file',
  overlay: 'Overlay (patches another mod)',
  unknown: 'Unclassified'
}

export type LinkStrategy = 'junction' | 'hardlink' | 'copy'

/** Whether Modão can actually write into the game folder, established by probe. */
export interface WriteAccess {
  writable: boolean
  probedPath: string
  code: string | null
  reason: string | null
  needsElevation: boolean
}

export interface GameInstall {
  id: number
  path: string
  label: string
  exeSize: number
  exeSha256: string
  exeTimestamp: number
  isV1UsOriginal: boolean
  largeAddressAware: boolean
  asiDirectory: string | null
  asiLoader: string | null
  hasModLoader: boolean
  modLoaderVersion: string | null
  cleoVersion: string | null
  userFilesDir: string
  sameVolumeAsStore: boolean
  linkStrategy: LinkStrategy
  access: WriteAccess
  /** Which GTA this install is. */
  kind: GameKind
  gameName: string
  supportsModLoader: boolean
  supportsCleo: boolean
  supportsAsi: boolean
  /** Definitive Edition only: where its .pak mods go. */
  pakDir: string | null
  /** CrashList.txt indexes addresses for this executable. */
  hasCrashList: boolean
}

export interface Profile {
  id: number
  name: string
  /** The game this profile's mod set belongs to. */
  gameKind: GameKind
  color: string
  notes: string
  createdAt: string
  lastPlayedAt: string | null
  isActive: boolean
  modCount: number
  enabledCount: number
  totalSize: number
  saveCount: number
}

export interface RatingInputs {
  /** 0..1 - how recently the mod was updated. */
  recency: number
  /** 0..1 - author's catalogue footprint. */
  authorReputation: number
  /** Present in the official MixMods Essentials pack. */
  inEssentials: boolean
  /** How many other catalogue mods declare this one as a requirement. */
  requiredByCount: number
  /** Local telemetry. */
  installCount: number
  earlyDisableCount: number
  notes?: string[]
}

export interface ModVersion {
  id: number
  modId: number
  versionLabel: string
  releaseDate: string | null
  downloadUrl: string | null
  fileSize: number | null
  sha256: string | null
  changelog: string | null
}

export interface InstalledSummary {
  installId: number
  versionLabel: string
  enabled: boolean
  priority: number
  destinationClass: DestinationClass
  updateAvailable: boolean
}

/** One piece of a mod page, in the order its author wrote it. */
export type ModBlock =
  | { type: 'heading'; text: string }
  | { type: 'text'; text: string }
  | { type: 'list'; items: string[] }
  | { type: 'image'; src: string; caption: string | null }
  | { type: 'video'; src: string }

export interface CatalogMod {
  /** The post itself, rendered in order. Empty for entries indexed before blocks existed. */
  blocks: ModBlock[]
  id: number
  slug: string
  title: string
  author: string
  category: string
  sourceUrl: string
  description: string
  images: string[]
  videos: string[]
  requirementsText: string[]
  incompatibleText: string[]
  readme: string | null
  paywalled: boolean
  publishedAt: string | null
  updatedAt: string | null
  firstSeenAt: string
  lastIndexedAt: string | null
  ratingInputs: RatingInputs
  rating: number
  versions: ModVersion[]
  installed?: InstalledSummary | null
  /** Which GTA this post is for. Read from its title tag and categories. */
  games: GameKind[]
}

export interface SubMod {
  relativePath: string
  fileCount: number
  size: number
  /** False when the user disabled this nested folder on its own; it can be switched back on. */
  enabled: boolean
}

export interface InstalledMod {
  installId: number
  modId: number
  modVersionId: number
  slug: string
  title: string
  author: string
  sourceUrl: string
  versionLabel: string
  installedAt: string
  destinationClass: DestinationClass
  variantChoice: string | null
  enabled: boolean
  priority: number
  fileCount: number
  size: number
  conflictCount: number
  updateAvailable: boolean
  latestVersionLabel: string | null
  subMods: SubMod[]
  /** Mutually exclusive options recorded at install time, switchable without re-downloading. */
  variantGroups: InstalledVariantGroup[]
}

export interface InstalledVariantGroup {
  id: string
  question: string
  chosenOptionId: string
  options: { id: string; label: string }[]
}

/** One archive entry classified into a destination. */
export interface PlannedFile {
  /** Path inside the extracted archive. */
  sourcePath: string
  /** Destination relative to the game folder. */
  targetRelative: string
  destination: DestinationClass
  size: number
  sha256: string
  overwrites: boolean
  /** Set when it overwrites a file owned by another installed mod. */
  overwritesMod: string | null
}

export interface VariantOption {
  id: string
  path: string
  label: string
  fileCount: number
  size: number
  recommended: boolean
  note: string | null
}

export interface VariantGroup {
  id: string
  /** Path of the parent folder containing the mutually exclusive siblings. */
  parentPath: string
  /**
   * Set when the parent folder is itself a parenthesised config container
   * ("(configurações)") whose options duplicate a sibling mod's own config
   * filenames. The chosen option merges into this mod's own folder instead of
   * becoming a top-level mod of its own.
   */
  attachedToPath: string | null
  kind: 'style' | 'resolution' | 'language' | 'game' | 'extra' | 'generic'
  question: string
  hint: string | null
  options: VariantOption[]
}

/**
 * An optional folder that means nothing installed on its own - "Extra",
 * "(bonus)", "translations" - but that a user may still want: merged into the
 * mod it belongs to, or installed as its own higher-priority mod.
 */
export interface AddOn {
  id: string
  /** Path inside the archive. */
  path: string
  label: string
  fileCount: number
  size: number
}

/**
 * A requirement, conflict or bundled plugin the readme states in prose.
 *
 * MixMods readmes say these in a handful of shapes and always have: a download
 * line for a companion mod, a NECESSARIO line, or a warning that the archive
 * ships an .asi you may already have. They are the mod author's own words about
 * what the mod needs, which outranks anything the app can infer.
 */
export interface DeclaredDependency {
  kind: 'requires' | 'conflicts' | 'includes'
  /** The mod as the readme names it. */
  name: string
  url: string | null
  /** The line it came from, so the UI can show the author's own words. */
  line: string
}

export interface ReadmeInstruction {
  line: string
  folder: string | null
  destination: DestinationClass
}

export interface ReadmeParse {
  file: string
  encoding: string
  raw: string
  language: 'pt-BR' | 'en' | 'unknown'
  instructions: ReadmeInstruction[]
  requirementUrls: string[]
  /** Requirements and conflicts the author stated in prose. */
  declared: DeclaredDependency[]
  /** Codes the author says to type in-game to turn the mod on. */
  activationCodes: ActivationCode[]
  confidence: number
}

export interface PlanWarning {
  severity: 'info' | 'warn' | 'error'
  code: string
  message: string
  detail?: string
}

export interface DependencyNode {
  modId: number | null
  slug: string
  title: string
  /**
   * `provides` is a mod shipping a file others may need or may also ship -
   * VehFuncs and gsx.asi. It was seeded before it was modelled, and an
   * unmodelled kind fell through to the requires branch, so the provision was
   * reported as a missing dependency named after the file.
   */
  kind: 'requires' | 'conflicts' | 'alt' | 'provides'
  versionRange: string | null
  satisfied: boolean
  /** For 'alt' groups: the alternatives that satisfy the requirement. */
  alternatives?: { slug: string; title: string; satisfied: boolean }[]
  resolution: 'already-installed' | 'will-install' | 'missing' | 'blocking' | 'ok'
  note: string | null
  /**
   * The installed mod this edge belongs to. A launch refusal has to name what
   * needs what, and "SilentPatch is missing" does not say who is missing it.
   */
  requiredBy?: string
  requiredBySlug?: string
}

export interface InstallPlan {
  planId: string
  modId: number | null
  modVersionId: number | null
  title: string
  author: string
  sourceUrl: string | null
  archivePath: string
  extractRoot: string
  readmes: ReadmeParse[]
  variants: VariantGroup[]
  /** Optional folders offered beside the plan - enable to merge or install separately. */
  addOns: AddOn[]
  files: PlannedFile[]
  dependencies: DependencyNode[]
  /**
   * Requirements the mod itself states that this profile does not have.
   * Reported, never blocking: each one carries the author's own words and,
   * where there is one, a way to get it.
   */
  missingRequirements: {
    name: string
    url: string | null
    evidence: string
    catalogSlug: string | null
  }[]
  warnings: PlanWarning[]
  totalSize: number
  requiresVariantChoice: boolean
}

export interface ConflictClaimant {
  installId: number
  modId: number
  title: string
  priority: number
  enabled: boolean
  size: number
  sha256: string
}

export interface FileConflict {
  relativePath: string
  /**
   * 'physical' - both mods wrote the same file on disk, one over the other.
   * 'modloader' - both files exist and Mod Loader picks one at load time.
   * 'split-model' - not a duplicated path at all: `<name>.dff` and
   * `<name>.txd` resolve to DIFFERENT mods, which is what a white or
   * invisible car or ped is. Same fix, same priority control (see
   * `@shared/splitModels`).
   */
  kind: 'modloader' | 'physical' | 'split-model'
  claimants: ConflictClaimant[]
  winner: ConflictClaimant | null
  binaryNotes: string[]
}

export interface TextureInfo {
  name: string
  width: number
  height: number
  depth: number
  mipmaps: number
  powerOfTwo: boolean
  compression: string
}

export interface TxdAnalysis {
  file: string
  rwVersion: string
  textureCount: number
  textures: TextureInfo[]
  nonPowerOfTwo: TextureInfo[]
  oversized: TextureInfo[]
  errors: string[]
}

export interface IfpAnalysis {
  file: string
  version: string
  animationCount: number
  animations: string[]
  missingVsVanilla: string[]
  vanillaReference: string | null
  errors: string[]
}

export interface ImgEntry {
  name: string
  offsetSectors: number
  streamingSize: number
  sizeInArchive: number
  byteOffset: number
  byteSize: number
}

export interface ImgAnalysis {
  file: string
  version: string
  entryCount: number
  entries: ImgEntry[]
  errors: string[]
}

export interface PeInfo {
  file: string
  machine: string
  timestamp: number
  timestampIso: string
  characteristics: number
  largeAddressAware: boolean
  isDll: boolean
  sizeBytes: number
  sha256: string
}

export interface HealthCheck {
  id: string
  title: string
  /**
   * `skip` means the check does not apply here; `unknown` means it applies and
   * could not be answered this run - a probe deliberately not taken because the
   * game is up, say. The two must not be one status: presenting a never-taken
   * probe as a clean `pass` is what made write access read as fine while the
   * game held the folder.
   */
  status: 'pass' | 'warn' | 'fail' | 'skip' | 'unknown'
  summary: string
  detail?: string
  items?: string[]
}

export interface HealthReport {
  generatedAt: string
  /** null when no profile is active - the game-level checks still ran. */
  profileId: number | null
  gamePath: string
  checks: HealthCheck[]
  ok: boolean
  blocking: number
  warnings: number
}

export interface CrashReport {
  id: number
  profileId: number | null
  occurredAt: string
  faultOffset: string
  /** Faulting module with any "_unloaded" marker removed. */
  module: string
  /** Exactly what the Event Log said, "std.data.dll_unloaded" included. */
  moduleRaw: string
  /** The module was already unloaded when the fault hit: usually shutdown fallout. */
  moduleUnloaded: boolean
  /** Faulting process id, as reported. Records sharing one belong to one crash. */
  processId: string
  exceptionCode: string
  /** "0x004C0C63" for the exe, "std.data.dll+0x0001A2B0" for anything else. */
  crashAddress: string
  addressKind: 'exe' | 'module' | 'none'
  /** Why no CrashList lookup was made, when none was. */
  addressNote: string | null
  matchedCause: string | null
  matchedSolution: string | null
  resolved: boolean
  kind: 'exception' | 'hang'
  raw: string
}

export interface CrashIncident {
  key: string
  processId: string
  occurredAt: string
  primary: CrashReport
  related: CrashReport[]
  onlyUnloaded: boolean
}

export interface CrashListEntry {
  address: string
  cause: string
  solution?: string
}

export interface SaveSlot {
  file: string
  index: number
  size: number
  modifiedAt: string
}

export interface SaveSnapshot {
  id: number
  profileId: number
  takenAt: string
  path: string
  label: string
  size: number
  auto: boolean
  slots: SaveSlot[]
}

export interface BisectSession {
  id: string
  profileId: number
  status: 'running' | 'converged' | 'aborted'
  step: number
  candidates: number[]
  testing: number[]
  knownGood: number[]
  knownBad: number[]
  culprit: number | null
  history: { step: number; tested: number[]; result: 'good' | 'bad' }[]
  /**
   * Mods whose installed binary is older than the newest upstream release, as
   * the outdated-build check found them before the first halving. Optional: a
   * session started before this check existed simply carries nothing.
   */
  outdated?: OutdatedBuild[]
}

export interface LogEntry {
  timestamp: string | null
  source: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export interface Progress {
  taskId: string
  label: string
  phase: string
  current: number
  total: number
  cancellable: boolean
  done: boolean
  error?: string
}

export interface AppSettings {
  theme: 'system' | 'light' | 'dark'
  /** Interface language. pt-BR is the source language; English is the translation. */
  language: Language
  activeGameId: number | null
  catalogLastCrawl: string | null
  telemetryEnabled: boolean
  crawlEnabled: boolean
  /** Upper bound on mod pages visited in one crawl. One request per second, so this is also a time budget. */
  crawlMaxPages: number
  /** Read the Windows Event Log for gta_sa.exe faults when the app starts. */
  scanCrashesOnLaunch: boolean
  /** Snapshot the live save folder automatically on a profile switch. */
  autoSnapshotSaves: boolean
  /** Ask GitHub for a newer release when the app starts. */
  checkUpdatesOnStart: boolean
}

/** Byte totals for everything Modão owns under userData. */
export interface StorageReport {
  userData: string
  dbBytes: number
  storeBytes: number
  archivesBytes: number
  cacheBytes: number
  quarantineBytes: number
  snapshotBytes: number
}

export type CacheKind = 'http' | 'archives' | 'quarantine'

/**
 * The save games already sitting in Documents\GTA San Andreas User Files,
 * and whether Modão has copied them into a profile yet.
 */
/** Content sitting in the game folder that the active profile does not track. */
export interface UnmanagedReport {
  folders: string[]
  asi: string[]
  cleo: string[]
  total: number
}

export interface ExistingSavesReport {
  found: boolean
  path: string
  slots: SaveSlot[]
  sizeBytes: number
  /** gta_sa.set sits next to the slots and is imported with them. */
  hasSettings: boolean
  importedIntoProfileId: number | null
}

// --- profile switching -------------------------------------------------------

/** One file copied out before a switch was allowed to touch the game folder. */
export interface SnapshotEntry {
  relativePath: string
  backupPath: string
  sha256: string
  size: number
}

export type SwitchAction = 'snapshot-and-remove' | 'drop-link' | 'leave-unmanaged' | 'leave-unverifiable' | 'materialise'

export interface SwitchFilePlan {
  relativePath: string
  action: SwitchAction
  installId: number | null
  label: string
  reason: string
  sizeBytes: number
}

export interface SwitchPlan {
  fromProfileId: number | null
  fromProfileName: string | null
  toProfileId: number
  toProfileName: string
  outgoing: SwitchFilePlan[]
  incoming: SwitchFilePlan[]
  toIngest: { installId: number; label: string; files: number }[]
  unresolved: { installId: number; label: string; reason: string }[]
  /** Files in the game folder no managed mod claims. A switch leaves these alone. */
  unmanaged: string[]
  /**
   * The subset of `unmanaged` whose path the incoming profile writes, so it
   * cannot be left in place. Each one is snapshotted with the rest of the
   * switch and copied to quarantine before the mod takes the path.
   */
  willBeOverwritten: string[]
  iniPath: string
  iniPriorities: Record<string, number>
  totalBytes: number
}

export interface SwitchVerification {
  ok: boolean
  profileId: number
  profileName: string
  modsExpected: number
  modsMaterialised: number
  missingMods: { installId: number; label: string; reason: string }[]
  asiCount: number
  cleoPluginCount: number
  cleoScriptCount: number
  iniParsed: boolean
  iniPath: string
  iniMissingKeys: string[]
  iniStaleKeys: string[]
  unresolvedDependencies: string[]
  problems: string[]
  /**
   * The subset of `problems` that means the game folder does not hold what the
   * profile says it holds. A switch with any of these is not a switch: it is
   * refused, the profile is never recorded active, and the user is offered the
   * rollback. The rest of `problems` - an unresolved dependency, say - is
   * advice about mods that ARE in place, and never blocks.
   */
  blockingProblems: string[]
  checkedAt: string
}

export type SwitchState = 'snapshotted' | 'applied' | 'verified' | 'failed' | 'restored'

/**
 * What a variant swap's `switch_journal` row carries on top of the snapshot
 * every switch keeps: which install and group it was switching, which option
 * it was leaving and which it was going to, and the exact paths on both
 * sides. This is what a stale journal's boot-time recovery reads before it
 * touches anything - the install row (never caught mid-write, by SQLite's own
 * atomicity) says which option won, and this record says what to do about it.
 */
export interface VariantSwapRecord {
  installId: number
  groupId: string
  fromOptionId: string
  toOptionId: string
  outgoingTargets: string[]
  incomingTargets: string[]
}

export interface SwitchJournal {
  id: number
  /**
   * Which operation wrote this row. Only a 'profile-switch' is a previous
   * state of the game folder; a 'variant-swap' is a few files inside one
   * mod's store folder and must never be offered as one.
   */
  kind: SwitchJournalKind
  startedAt: string
  completedAt: string | null
  fromProfileId: number | null
  toProfileId: number
  state: SwitchState
  snapshotDir: string
  manifest: SnapshotEntry[]
  verification: SwitchVerification | null
  error: string | null
  restoredAt: string | null
}

// --- what Mod Loader says it did ---------------------------------------------

export type ModVerdict = 'active' | 'inert' | 'mis-installed' | 'unknown'

export interface ModLoaderModReport {
  folder: string
  verdict: ModVerdict
  installedFiles: number
  unhandledFiles: string[]
  explanation: string | null
}

export interface ModLoaderCrash {
  occurredAt: string | null
  reason: string
  address: string | null
  /**
   * Mod Loader's handler records the address the process faulted at, which is
   * already absolute - the image base is in it. Marked so no caller can mistake
   * it for a fault offset and base it a second time.
   */
  addressIsAbsolute: true
  module: string | null
  backtrace: string[]
  lastStreamedFile: string | null
  /**
   * Name -> value, exactly as Mod Loader's own crash handler printed them
   * ("ECX" -> "0xFFFFFFFF"). Empty when the dump carried no register block.
   */
  registers: Record<string, string>
  /** The raw stack-dump lines, in the order the handler wrote them. */
  stack: string[]
}

/** One row of a PE section table: what a VA-to-file-offset conversion needs. */
export interface PeSection {
  name: string
  virtualAddress: number
  virtualSize: number
  rawSize: number
  rawPointer: number
}

/** The result of the app's "deep analysis" action on a crash address that CrashList could not answer for. */
export interface DeepAnalysisResult {
  address: string
  /** Null when the address falls in no section of the exe as read from disk. */
  fileOffset: number | null
  section: string | null
  /** Formatted hex-dump lines around the address. Empty when fileOffset is null. */
  hex: string[]
  /**
   * Always present: explains what this is (a hex window, not a disassembly)
   * or why there is nothing to show.
   */
  note: string
}

export interface ModLoaderLogReport {
  path: string
  readAt: string
  version: string | null
  mods: ModLoaderModReport[]
  looseUnhandled: string[]
  crash: ModLoaderCrash | null
}

/** What the app knows about a newer release. It never installs one on its own. */
export interface UpdateStatus {
  current: string
  latest: string | null
  available: boolean
  dismissed: boolean
  releaseUrl: string | null
  publishedAt: string | null
  notes: string | null
  checkedAt: string | null
  error: string | null
  /** A download the user asked for is running. */
  downloading?: boolean
  /** A version already on disk, waiting for the restart. */
  downloadedVersion?: string | null
  canInstall?: boolean
}

/** Progress of an update download, as the app reports it. */
export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

/**
 * One thing the app has learned, and where it learned it. The source and the
 * evidence are part of the record so a rule can be read, argued with and
 * deleted rather than taken on faith.
 */
export interface KnowledgeEntry {
  id: number
  kind: string
  subject: string
  subjectKind: string
  source: string
  evidence: string
  weight: number
  timesSeen: number
  createdAt: string
  value: unknown
}

export interface KnowledgeReport {
  total: number
  byKind: Record<string, number>
  bySource: Record<string, number>
  recent: KnowledgeEntry[]
}
