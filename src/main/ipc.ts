import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { BrowserWindow, app, dialog, ipcMain, shell } from 'electron'
import type { AppSettings, CacheKind, DestinationClass, InstallPlan, Progress, StorageReport } from '@shared/types'
import { EVENT_PROGRESS, EVENT_TOAST, type IpcChannel } from '@shared/ipc'
import { classifyDownload, githubRepo, looksLikeArchive } from '@shared/download'
import { fetchThroughBrowser } from './install/fetcher'
import { ELEVATED_FLAG } from './util/flags'
import { log, logError } from './util/log'
import { getDb, getSetting, setSetting } from './db'
import { Paths } from './util/paths'
import { dirSize, exists, walk } from './util/fsx'
import { activeGame, addGame, detectCandidates, gameTarget, listGames, requireActiveGame, setActiveGame } from './game/detect'
import {
  describeFsError,
  forgetWriteAccess,
  isProtectedLocation,
  probeWriteAccess,
  writeAccessUnlessGameRunning
} from './game/access'
import { assertGameNotRunning, checkGameRunning, forgetRunningProcesses, whenGameClosed } from './game/running'
import { readPe } from './game/pe'
import {
  activateProfile,
  restorePreviousState,
  activeProfile,
  adoptInstall,
  adoptIntoProfile,
  buildManifest,
  createProfile,
  deleteProfile,
  importManifest,
  listProfiles,
  SwitchVerificationError,
  unmanagedContent,
  updateProfile,
  type ImportResult,
  type ProfileManifest
} from './profiles/manager'
import {
  currentSlots,
  detectExistingSaves,
  importExistingSaves,
  listSnapshots,
  restoreSnapshot,
  snapshot
} from './profiles/saves'
import { listInstalled, applyPriorities, readInstallReadme, setEnabled, setPriority, setSubModEnabled, switchVariant } from './library'
import { annotateConflicts, listConflicts } from './conflicts'
import { applyPlan, createPlan, choose, chooseAddOn, discardPlan, rollbackPreview, setDestination, uninstall } from './install/engine'
import { getCatalogMod, listCatalog, loadSeedCatalog, seedInfo } from './catalog/service'
import { crawl, refreshMod } from './catalog/mixmods'
import { analyzeTxd } from './formats/txd'
import { analyzeImg } from './formats/img'
import { compareWithVanilla } from './formats/ifp'
import { runHealthCheck, scanTextures } from './diagnostics/health'
import { listCrashes, listIncidents, scanCrashes, setCrashResolved } from './diagnostics/eventlog'
import { listJournals, planSwitch, verifySwitch } from './profiles/switchTx'
import { gameDefinition, type GameKind } from '@shared/games'
import { DEFAULT_LANGUAGE, isLanguage } from '@shared/i18n'
import { setMainLanguage, t } from './util/i18n'
import { lookup } from './diagnostics/crashlist'
import { collectLogs } from './diagnostics/logs'
import { abortBisect, currentBisect, recordResult, startBisect } from './diagnostics/bisect'

const tasks = new Map<string, AbortController>()

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function progress(taskId: string, label: string, phase: string, current: number, total: number, done = false, error?: string): void {
  const p: Progress = { taskId, label, phase, current, total, cancellable: tasks.has(taskId), done, error }
  broadcast(EVENT_PROGRESS, p)
}

export function toast(kind: 'info' | 'error' | 'success', message: string): void {
  broadcast(EVENT_TOAST, { kind, message })
}

function newTask(label: string): { id: string; signal: AbortSignal; end: (error?: string) => void } {
  const id = crypto.randomUUID()
  const controller = new AbortController()
  tasks.set(id, controller)
  progress(id, label, 'starting', 0, 100)
  return {
    id,
    signal: controller.signal,
    end: (error?: string) => {
      tasks.delete(id)
      progress(id, label, error ? 'failed' : 'done', 100, 100, true, error)
    }
  }
}

function settings(): AppSettings {
  return {
    theme: (getSetting('ui.theme', 'system') as AppSettings['theme']) ?? 'system',
    language: (() => {
      const stored = getSetting('ui.language', DEFAULT_LANGUAGE)
      return isLanguage(stored) ? stored : DEFAULT_LANGUAGE
    })(),
    activeGameId: activeGame()?.id ?? null,
    catalogLastCrawl: getSetting('catalog.lastCrawl'),
    telemetryEnabled: getSetting('telemetry.enabled', '1') === '1',
    crawlEnabled: getSetting('catalog.crawlEnabled', '0') === '1',
    crawlMaxPages: readNumber('catalog.crawlMaxPages', 0, 0, 5000),
    scanCrashesOnLaunch: getSetting('diagnostics.scanCrashesOnLaunch', '1') === '1',
    autoSnapshotSaves: getSetting('saves.autoSnapshot', '1') === '1',
    checkUpdatesOnStart: getSetting('updates.checkOnStart', '1') === '1'
  }
}

/** A stored setting that must stay a sane number even if the row is edited by hand. */
function readNumber(key: string, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(getSetting(key, String(fallback)) ?? '', 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

/**
 * A profile id arriving from the renderer is a claim, not a fact: screens hold
 * one across a delete, a failed import or a restart of the main process. Every
 * handler that takes one checks it here first, so the user gets one sentence
 * about the profile instead of a SQL-shaped error from three layers down.
 */
function requireProfile(id: number): number {
  const row = getDb().prepare('SELECT id FROM profile WHERE id = ?').get(id) as { id: number } | undefined
  if (!row) throw new Error(t('messages.profile.gone', { id }))
  return row.id
}

/**
 * The game is launched detached, so there is no exit event to hook. The launch
 * is remembered instead and the Windows Event Log is read the next time
 * Modão itself is focused - which is exactly what the user does once the
 * game has closed or died. It runs at most once per launch, and only when the
 * user has left the setting on.
 */
let pendingCrashScan: { profileId: number | null } | null = null

function armCrashScan(profileId: number | null): void {
  if (getSetting('diagnostics.scanCrashesOnLaunch', '1') !== '1') return
  pendingCrashScan = { profileId }
}

export async function runPendingCrashScan(): Promise<void> {
  const pending = pendingCrashScan
  if (!pending) return
  pendingCrashScan = null
  try {
    const result = await scanCrashes(pending.profileId)
    if (result.added > 0) {
      toast('error', t('messages.crashes.newRecords', { count: result.added }))
    } else if (result.found === 0) {
      toast('info', t('messages.crashes.noneFound'))
    }
  } catch {
    // Reading the Event Log can fail on a locked-down machine. That is not an app error.
  }
}

/**
 * Every handler goes through here so a raw errno never reaches the UI. Node
 * reports "EPERM: operation not permitted, unlink <some file>" for a game
 * folder inside Program Files; the user needs to be told what to do about it,
 * not which syscall failed.
 */
function handle(channel: IpcChannel, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_e, ...args: unknown[]) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (error) {
      const game = activeGame()
      const message = describeFsError(error, game?.path)
      throw new Error(message)
    }
  })
}

/**
 * Elevation is offered, never taken by default. An elevated process would run
 * every mod archive it extracts with full privileges, and most installs do not
 * need it at all - only the ones sitting in a Windows-protected folder do. So
 * Modão asks once, remembers the answer for that game, and keeps pointing at
 * the better fix: move the game out of Program Files.
 *
 * This is read-shaped but the access probe underneath it is a write - it
 * creates and deletes a file inside modloader\. So it never probes while the
 * game is up: the last answer stands, and with no last answer there is simply
 * nothing to report. The banner this feeds is about a permission problem the
 * user hits when they install something, and they cannot install right now
 * anyway.
 */
export async function elevationState(): Promise<{
  running: boolean
  needed: boolean
  remembered: boolean
  reason: string | null
  protectedPath: boolean
}> {
  const game = gameTarget()
  const access = game ? await writeAccessUnlessGameRunning(game) : null
  return {
    running: isElevated(),
    needed: !!access && !access.writable && access.needsElevation,
    remembered: getSetting('elevation.always', '0') === '1',
    reason: access?.reason ?? null,
    protectedPath: !!game && isProtectedLocation(game.path)
  }
}

let elevatedFlag: boolean | null = null

function isElevated(): boolean {
  if (elevatedFlag !== null) return elevatedFlag
  try {
    // Writing into a machine-wide protected path is the cheapest reliable probe.
    const probe = path.join(process.env['SystemRoot'] ?? 'C:\Windows', `modao-elev-${Date.now()}.tmp`)
    fs.writeFileSync(probe, '')
    fs.unlinkSync(probe)
    elevatedFlag = true
  } catch {
    elevatedFlag = false
  }
  return elevatedFlag
}

/** Relaunches this exact install through the UAC prompt, then exits. */
export async function relaunchElevated(remember: boolean): Promise<void> {
  if (remember) setSetting('elevation.always', '1')
  const exe = app.getPath('exe')

  // Hand the lock over before the elevated copy starts. It runs as the same
  // user, so it competes for the same single-instance lock: holding it here
  // meant the elevated instance acquired nothing, quit on the spot, and the
  // user watched the app close after accepting a UAC prompt for nothing.
  app.releaseSingleInstanceLock()
  log('released the single-instance lock for an elevated restart')

  // Only forward arguments this app understands. argv in a packaged build can
  // carry Chromium switches that mean nothing on a fresh start.
  const args = process.argv
    .slice(1)
    .filter((a) => a.startsWith('--user-data-dir=') === false && a.startsWith('--') === false)
  const forwarded = [ELEVATED_FLAG, ...args]
  const quoted = forwarded.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')
  const command = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${quoted} -Verb RunAs`

  try {
    await new Promise<void>((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true }, (err) =>
        err ? reject(new Error('The elevation prompt was dismissed or blocked by Windows.')) : resolve()
      )
    })
  } catch (e) {
    // The handoff failed, so this instance keeps the app: take the lock back.
    app.requestSingleInstanceLock()
    logError('elevated restart refused', e)
    throw e
  }

  log('elevated instance started; this one is standing down')
  toast('info', t('messages.elevation.restarting'))
  // exit() rather than quit(): nothing here may veto the handoff, and the
  // elevated copy is already waiting for the lock.
  setTimeout(() => app.exit(0), 400)
}

/**
 * Fail before touching anything rather than half-way through. Every operation
 * that writes into the game folder asks this first, so the user gets the
 * permission problem as one sentence with a fix, not as a partial install.
 */
function requireWritableGame(): void {
  const game = requireActiveGame()
  const access = probeWriteAccess(game.path)
  if (access.writable) return
  throw new Error(access.reason ?? t('messages.access.cannotWrite', { path: game.path }))
}

/**
 * The other half of "fail before touching anything": is the game open?
 *
 * Write access says nothing about it - a running gta_sa.exe does not lock
 * modloader\, so the probe above succeeds and the write lands in a folder Mod
 * Loader is watching. It hot-reloads it and the game dies mid-session. This is
 * a refusal, not a warning: there is no safe way to continue.
 *
 * The install is read through `gameTarget`, which does no write-access probe:
 * `requireActiveGame()` would have run one, and that probe writes a file into
 * modloader\ - the check would have triggered the write it exists to prevent.
 * A game id names the install to check when it is not the active one yet.
 */
async function requireGameClosed(gameId?: number): Promise<void> {
  await assertGameNotRunning(gameTarget(gameId) ?? requireActiveGame())
}

/**
 * Reads the process table and records the answer, refusing nothing.
 *
 * This is the read-shaped half of the guard. The synchronous access probes
 * further down - `requireActiveGame()`, and the forced one inside
 * `runHealthCheck` - create a file inside modloader\ unless the running state
 * is already known, and asking here costs nothing but a process listing. So a
 * handler the user is entitled to run with the game open calls this instead of
 * `requireGameClosed`, and keeps working; only the checks that genuinely need
 * a write fall back to the last answer on record.
 */
async function noteWhetherGameIsRunning(): Promise<void> {
  const target = gameTarget()
  if (target) await checkGameRunning(target)
}

/**
 * What every handler that writes into the game folder runs first, in this
 * order: the running check comes before the access probe because the probe
 * itself writes a file into modloader\, which is exactly what must not happen
 * while the watcher is live.
 */
async function requireIdleGame(): Promise<void> {
  await requireGameClosed()
  requireWritableGame()
}

export function registerIpc(): void {
  // --- app ------------------------------------------------------------------
  ipcMain.handle('app:settings', () => settings())
  ipcMain.handle('app:checkUpdate', async (_e, force?: boolean) => {
    void force
    // The packaged app asks the release feed through electron-updater, which is
    // the same source it downloads from; a dev build falls back to the HTTP
    // check so the screen can still be worked on.
    const { checkForUpdate } = await import('./util/autoUpdate')
    return checkForUpdate()
  })
  ipcMain.handle('app:downloadUpdate', async (_e, andInstall?: boolean) => {
    const { downloadUpdate } = await import('./util/autoUpdate')
    return downloadUpdate(andInstall !== false)
  })
  ipcMain.handle('app:installUpdate', async () => {
    const { installUpdateAndRestart } = await import('./util/autoUpdate')
    await installUpdateAndRestart()
  })
  ipcMain.handle('app:knowledge', async () => {
    const { knowledgeSummary, recentRules } = await import('./knowledge/store')
    const summary = knowledgeSummary()
    return { ...summary, recent: recentRules() }
  })
  ipcMain.handle('app:forgetRule', async (_e, id: number) => {
    const { unlearn } = await import('./knowledge/store')
    unlearn(id)
  })
  ipcMain.handle('app:dismissUpdate', async (_e, version: string) => {
    const { dismissUpdate } = await import('./util/autoUpdate')
    dismissUpdate(version)
  })
  ipcMain.handle('app:setSetting', (_e, key: keyof AppSettings, value: unknown) => {
    const map: Partial<Record<keyof AppSettings, string>> = {
      theme: 'ui.theme',
      language: 'ui.language',
      telemetryEnabled: 'telemetry.enabled',
      crawlEnabled: 'catalog.crawlEnabled',
      crawlMaxPages: 'catalog.crawlMaxPages',
      scanCrashesOnLaunch: 'diagnostics.scanCrashesOnLaunch',
      autoSnapshotSaves: 'saves.autoSnapshot',
      checkUpdatesOnStart: 'updates.checkOnStart'
    }
    const dbKey = map[key]
    if (dbKey) setSetting(dbKey, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    // The main process writes messages too, so it follows the same setting.
    if (key === 'language') setMainLanguage(String(value))
    return settings()
  })
  ipcMain.handle('app:openExternal', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error(t('messages.app.nonHttpUrl'))
    await shell.openExternal(url)
  })
  ipcMain.handle('app:revealPath', async (_e, p: string) => {
    if (exists(p)) shell.showItemInFolder(p)
  })
  ipcMain.handle('app:version', () => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node }))
  ipcMain.handle('app:storage', () => storageReport())
  ipcMain.handle('app:elevation', () => elevationState())
  ipcMain.handle('app:relaunchElevated', (_e, remember: boolean) => relaunchElevated(!!remember))
  // The forced probe writes a file into modloader\, which is itself a write the
  // watcher would pick up - so the running check comes first here too.
  ipcMain.handle('app:recheckAccess', async () => {
    await requireGameClosed()
    const game = requireActiveGame()
    forgetWriteAccess(game.path)
    return probeWriteAccess(game.path, true)
  })
  ipcMain.handle('app:clearCache', async (_e, kind: CacheKind) => {
    const result = await clearCache(kind)
    toast('success', t('messages.cache.freed', { size: (result.freed / 1024 / 1024).toFixed(1) }))
    return result
  })

  // --- game -----------------------------------------------------------------
  ipcMain.handle('game:list', () => listGames())
  ipcMain.handle('game:detect', () => detectCandidates())
  ipcMain.handle('game:add', (_e, p: string, kind?: GameKind) => addGame(p, undefined, kind))
  ipcMain.handle('game:pickFolder', async () => {
    const res = await dialog.showOpenDialog({
      title: t('messages.game.pickFolderTitle'),
      properties: ['openDirectory'],
      buttonLabel: t('messages.game.pickFolderButton')
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.handle('game:setActive', (_e, id: number) => {
    setActiveGame(id)
    return activeGame()
  })
  ipcMain.handle('game:active', () => activeGame())
  ipcMain.handle('game:adopt', async (_e, gameId: number, profileName: string) => {
    // Checked before anything at all, the active-game pointer included: a
    // refusal has to leave the app exactly as it was, which is what its message
    // promises. The install is named by id because it is not the active one
    // yet. Adoption rewrites modloader.ini with the priorities it found, so it
    // is a write like any other; the access probe is deliberately not run,
    // since adopting is how a read-only install gets indexed in the first place.
    const target = gameTarget(gameId) ?? requireActiveGame()
    await whenGameClosed(target, () => setActiveGame(gameId))
    const task = newTask('Adopting existing install')
    try {
      const result = await adoptInstall(profileName, (d, t) => progress(task.id, 'Adopting existing install', 'indexing', d, t))
      task.end()
      toast('success', t('messages.game.adoptedNoMove', { count: result.adopted }))
      return result
    } catch (e) {
      task.end((e as Error).message)
      throw e
    }
  })
  ipcMain.handle('game:adoptInto', async (_e, profileId: number) => {
    await requireIdleGame()

    const id = requireProfile(profileId)
    const task = newTask('Scanning the game folder')
    try {
      const result = await adoptIntoProfile(id, (d, t) => progress(task.id, 'Scanning the game folder', 'indexing', d, t))
      task.end()
      toast(
        result.adopted > 0 ? 'success' : 'info',
        result.adopted > 0
          ? t('messages.game.adoptedIntoProfile', { count: result.adopted })
          : t('messages.game.nothingNewInFolder')
      )
      return result
    } catch (e) {
      task.end((e as Error).message)
      throw e
    }
  })
  ipcMain.handle('game:unmanaged', (_e, profileId: number) => unmanagedContent(requireProfile(profileId)))
  ipcMain.handle('game:remove', (_e, id: number) => removeGame(id))
  ipcMain.handle('game:launch', async () => {
    const game = requireActiveGame()
    const exe = gameDefinition(game.kind)
      .exeNames.map((name) => path.join(game.path, name))
      .find((candidate) => exists(candidate))
    if (!exe) throw new Error(t('messages.game.exeNotFound', { game: game.gameName, path: game.path }))
    const profile = await activeProfile()
    if (profile) getDb().prepare('UPDATE profile SET last_played_at = ? WHERE id = ?').run(new Date().toISOString(), profile.id)
    const ok = await shell.openPath(exe)
    // The process table just changed. The running check caches it for two
    // seconds, which is exactly long enough for a user to alt-tab back and
    // click something while the guard still believes the game is closed.
    forgetRunningProcesses()
    if (ok === '') armCrashScan(profile?.id ?? null)
    return { launched: ok === '', message: ok || `Launched ${exe}` }
  })

  // --- profiles -------------------------------------------------------------
  ipcMain.handle('profiles:list', () => listProfiles())
  ipcMain.handle('profiles:active', () => activeProfile())
  ipcMain.handle('profiles:create', (_e, input: { name: string; color: string; notes: string; copyFrom?: number }) =>
    createProfile(input)
  )
  // Renaming the active profile rewrites its section header in modloader.ini.
  ipcMain.handle('profiles:update', async (_e, id: number, patch: { name?: string; color?: string; notes?: string }) => {
    await requireGameClosed()
    return updateProfile(id, patch)
  })
  ipcMain.handle('profiles:remove', (_e, id: number) => deleteProfile(id))
  ipcMain.handle('profiles:activate', async (_e, id: number) => {
    await requireIdleGame()

    const task = newTask('Switching profile')
    try {
      const result = await activateProfile(id, (phase, d, t) => progress(task.id, 'Switching profile', phase, d, t))
      task.end()
      const profile = (await listProfiles()).find((p) => p.id === id)!
      // Notes that do not block: the profile IS active and its mods ARE in
      // place, but something adjacent (an unresolved dependency) wants saying.
      if (result.verification && !result.verification.ok) {
        toast(
          'error',
          t('messages.profile.switchNotVerified', {
            profile: profile.name,
            problem: result.verification.problems[0] ?? t('messages.profile.seeSwitchReport')
          })
        )
      } else {
        toast('success', t('messages.profile.switchedActive', { profile: profile.name, seconds: (result.elapsedMs / 1000).toFixed(1) }))
      }
      return {
        ok: true as const,
        profile,
        elapsedMs: result.elapsedMs,
        log: result.log,
        journalId: result.journalId,
        verification: result.verification
      }
    } catch (e) {
      task.end((e as Error).message)
      // Reconciliation failed: the switch is off. The profile was never
      // recorded active, so the renderer gets the whole report back rather than
      // a bare message - it has to open the failure dialog, not a toast that
      // scrolls away while the user believes the switch worked.
      if (e instanceof SwitchVerificationError) {
        const profile = (await listProfiles()).find((p) => p.id === id) ?? null
        toast(
          'error',
          t('messages.profile.switchBlocked', {
            profile: e.profileName,
            problem: e.verification.blockingProblems[0] ?? t('messages.profile.seeSwitchReport')
          })
        )
        return {
          ok: false as const,
          profile,
          elapsedMs: 0,
          log: e.log,
          journalId: e.journalId,
          verification: e.verification,
          previousProfileName: e.previousProfileName
        }
      }
      throw e
    }
  })
  ipcMain.handle('profiles:switchPlan', (_e, id: number) => planSwitch(requireProfile(id)))
  ipcMain.handle('profiles:verify', (_e, id: number) => verifySwitch(requireProfile(id)))
  ipcMain.handle('profiles:restorePrevious', async (_e, journalId?: number) => {
    await requireIdleGame()
    const task = newTask('Restoring the previous state')
    try {
      const result = await restorePreviousState(journalId)
      task.end()
      toast('success', t('messages.profile.restoredFiles', { count: result.restored }))
      return result
    } catch (e) {
      task.end((e as Error).message)
      throw e
    }
  })
  ipcMain.handle('profiles:switchHistory', () => listJournals())
  ipcMain.handle('profiles:forgetMissing', async (_e, profileId: number) => {
    const { forgetMissingInstalls } = await import('./profiles/switchTx')
    const forgotten = forgetMissingInstalls(requireProfile(profileId))
    if (forgotten.length) toast('info', t('messages.profile.forgotMissing', { count: forgotten.length }))
    return forgotten
  })
  ipcMain.handle('profiles:duplicate', (_e, id: number, name: string) => createProfile({ name, copyFrom: id }))
  ipcMain.handle('profiles:exportArchive', async (_e, id: number) => {
    const manifest = buildManifest(id)
    const res = await dialog.showSaveDialog({
      title: t('messages.profile.exportTitle'),
      defaultPath: `${manifest.profile.name.replace(/[^\w -]/g, '')}.modao.json`,
      filters: [{ name: t('messages.profile.fileFilterName'), extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    await fsp.writeFile(res.filePath, JSON.stringify(manifest, null, 2), 'utf8')
    return res.filePath
  })
  ipcMain.handle('profiles:importArchive', async (): Promise<ImportResult | null> => {
    // An import that lands on the active profile writes modloader.ini.
    await requireGameClosed()
    const res = await dialog.showOpenDialog({
      title: t('messages.profile.importTitle'),
      filters: [{ name: t('messages.profile.fileFilterName'), extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled) return null
    const manifest = JSON.parse(await fsp.readFile(res.filePaths[0], 'utf8')) as ProfileManifest
    const result = await importManifest(manifest)
    if (result.needsDownload.length) {
      toast(
        'info',
        t('messages.profile.importSummary', { resolved: result.resolved, needsDownload: result.needsDownload.length })
      )
    }
    return result
  })

  // --- library --------------------------------------------------------------
  ipcMain.handle('library:list', (_e, profileId: number) => listInstalled(requireProfile(profileId)))
  ipcMain.handle('library:setEnabled', async (_e, installId: number, enabled: boolean) => {
    await requireIdleGame()
    return setEnabled(installId, enabled)
  })
  ipcMain.handle('library:setPriority', async (_e, installId: number, priority: number) => {
    await requireIdleGame()
    return setPriority(installId, priority)
  })
  ipcMain.handle('library:uninstall', async (_e, installId: number) => {
    await requireIdleGame()
    const result = await uninstall(installId)
    toast('success', t('messages.library.uninstalled', { count: result.restored }))
    return result
  })
  ipcMain.handle('library:rollbackPreview', (_e, installId: number) => rollbackPreview(installId))
  ipcMain.handle('library:readme', (_e, installId: number) => readInstallReadme(installId))
  ipcMain.handle('library:subModSetEnabled', async (_e, installId: number, rel: string, enabled: boolean) => {
    await requireIdleGame()
    return setSubModEnabled(installId, rel, enabled)
  })
  ipcMain.handle('library:setVariant', async (_e, installId: number, groupId: string, optionId: string) => {
    await requireIdleGame()
    return switchVariant(installId, groupId, optionId)
  })

  // --- catalog --------------------------------------------------------------
  ipcMain.handle('catalog:list', async (_e, query: Parameters<typeof listCatalog>[0]) => {
    const profile = await activeProfile()
    return listCatalog({ ...query, profileId: profile?.id ?? null })
  })
  ipcMain.handle('catalog:get', async (_e, modId: number) => {
    const profile = await activeProfile()
    return getCatalogMod(modId, profile?.id ?? null)
  })
  ipcMain.handle('catalog:refresh', async (_e, modId: number) => {
    const ok = await refreshMod(modId)
    if (!ok) toast('info', t('messages.catalog.refreshFailed'))
    const profile = await activeProfile()
    return getCatalogMod(modId, profile?.id ?? null)
  })
  ipcMain.handle('catalog:crawl', async () => {
    if (getSetting('catalog.crawlEnabled', '0') !== '1') {
      return {
        started: false,
        taskId: '',
        message: t('messages.catalog.crawlDisabled')
      }
    }
    const task = newTask('Indexing MixMods')
    void crawl({
      maxPages: settings().crawlMaxPages,
      signal: task.signal,
      onProgress: (d, t, label) => progress(task.id, 'Indexing MixMods', label, d, t)
    })
      .then((report) => {
        setSetting('catalog.lastCrawl', new Date().toISOString())
        task.end()
        const parts = [t('messages.catalog.crawlNew', { count: report.indexed }), t('messages.catalog.crawlUpdated', { count: report.updated })]
        if (report.skipped) parts.push(t('messages.catalog.crawlSkipped', { count: report.skipped }))
        if (report.errors.length) parts.push(t('messages.catalog.crawlErrors', { count: report.errors.length }))
        toast(
          report.indexed + report.updated > 0 ? 'success' : 'info',
          t('messages.catalog.crawlResult', { visited: report.visited, parts: parts.join(', ') })
        )
      })
      .catch((e: Error) => {
        task.end(e.message)
        toast('error', e.message)
      })
    return { started: true, taskId: task.id, message: t('messages.catalog.crawlStarted') }
  })
  ipcMain.handle('catalog:seedInfo', () => seedInfo())
  ipcMain.handle('catalog:reseed', async () => {
    const count = await loadSeedCatalog(true)
    toast('success', t('messages.catalog.reseeded', { count }))
    return { count }
  })

  // --- install --------------------------------------------------------------
  ipcMain.handle('install:planFromSlug', async (_e, slug: string, profileId: number) => {
    // A requirement named in a readme is a name, not an id.
    const row = getDb()
      .prepare(
        `SELECT mv.id FROM mod_version mv JOIN mod m ON m.id = mv.mod_id
          WHERE m.slug = ? ORDER BY mv.id DESC LIMIT 1`
      )
      .get(slug) as { id: number } | undefined
    if (!row) throw new Error(t('messages.installDeps.notInCatalog', { slug }))
    return planFromCatalogVersion(row.id, requireProfile(profileId))
  })
  ipcMain.handle('install:planFromCatalog', (_e, modVersionId: number, profileId: number) =>
    planFromCatalogVersion(modVersionId, requireProfile(profileId))
  )

  ipcMain.handle('install:planFromFile', async (_e, profileId: number) => {
    const res = await dialog.showOpenDialog({
      title: t('messages.install.pickArchiveTitle'),
      filters: [{ name: t('messages.install.archiveFilterName'), extensions: ['7z', 'zip', 'rar'] }],
      properties: ['openFile']
    })
    if (res.canceled) return null
    const archivePath = res.filePaths[0]
    const task = newTask(`Reading ${path.basename(archivePath)}`)
    try {
      const plan = await createPlan({
        archivePath,
        profileId,
        modId: null,
        modVersionId: null,
        title: path.basename(archivePath).replace(/\.(7z|zip|rar)$/i, ''),
        author: 'Unknown',
        sourceUrl: null,
        signal: task.signal,
        onProgress: (phase, c, t) => progress(task.id, `Reading ${path.basename(archivePath)}`, phase, c, t)
      })
      task.end()
      return plan
    } catch (e) {
      task.end((e as Error).message)
      throw e
    }
  })

  ipcMain.handle('install:choose', (_e, planId: string, groupId: string, optionId: string) => choose(planId, groupId, optionId))
  ipcMain.handle('install:chooseAddOn', (_e, planId: string, addOnId: string, enabled: boolean) => chooseAddOn(planId, addOnId, enabled))
  ipcMain.handle('install:setDestination', (_e, planId: string, sourcePath: string, destination: string) =>
    setDestination(planId, sourcePath, destination as DestinationClass)
  )
  ipcMain.handle('install:apply', async (_e, planId: string, profileId: number) => {
    await requireIdleGame()
    const task = newTask('Applying install plan')
    try {
      const result = await applyPlan(planId, profileId, (phase, c, tot) => progress(task.id, 'Applying install plan', phase, c, tot))
      task.end()
      const modeLabel = t(`messages.install.mode.${result.mode}`)
      toast(
        'success',
        t('messages.install.installedSummary', { written: result.written, mode: modeLabel, backedUp: result.backedUp })
      )
      return result
    } catch (e) {
      task.end((e as Error).message)
      throw e
    }
  })
  ipcMain.handle('install:discard', (_e, planId: string) => discardPlan(planId))

  // --- conflicts ------------------------------------------------------------
  ipcMain.handle('conflicts:list', async (_e, profileId: number) => annotateConflicts(listConflicts(requireProfile(profileId))))
  ipcMain.handle('conflicts:preview', (_e, profileId: number, changes: { installId: number; priority: number }[]) => {
    requireProfile(profileId)
    // A preview may only move the priorities of installs inside the profile it
    // previews: an id from another profile would otherwise silently reorder a
    // conflict the user is not looking at.
    const owned = new Set(
      (getDb().prepare('SELECT id FROM install WHERE profile_id = ?').all(profileId) as { id: number }[]).map((r) => r.id)
    )
    const overrides: Record<number, number> = {}
    for (const c of changes) {
      if (owned.has(c.installId)) overrides[c.installId] = c.priority
    }
    return listConflicts(profileId, overrides)
  })
  ipcMain.handle('conflicts:applyPriorities', async (_e, profileId: number, changes: { installId: number; priority: number }[]) => {
    await requireIdleGame()
    await applyPriorities(requireProfile(profileId), changes)
    toast('success', t('messages.conflicts.prioritiesWritten'))
  })

  // --- analysis -------------------------------------------------------------
  ipcMain.handle('analyze:txd', (_e, p: string) => analyzeTxd(p))
  ipcMain.handle('analyze:ifp', (_e, p: string) => compareWithVanilla(p, requireActiveGame().path))
  ipcMain.handle('analyze:img', (_e, p: string) => analyzeImg(p))
  ipcMain.handle('analyze:pe', (_e, p: string) => readPe(p))
  ipcMain.handle('analyze:profileTextures', async (_e, profileId: number) => (await scanTextures(requireProfile(profileId))).analyses)

  // --- saves ----------------------------------------------------------------
  ipcMain.handle('saves:list', (_e, profileId: number) => listSnapshots(requireProfile(profileId)))
  ipcMain.handle('saves:snapshot', (_e, profileId: number, label: string) => snapshot(requireProfile(profileId), label || 'manual', false))
  ipcMain.handle('saves:restore', async (_e, snapshotId: number) => {
    // The live save folder belongs to the running game: it holds the slots open
    // and writes them back on exit, so a restore now is silently undone.
    await requireGameClosed()
    await restoreSnapshot(snapshotId)
    toast('success', t('messages.saves.restored'))
  })
  ipcMain.handle('saves:currentSlots', (_e, profileId: number) => currentSlots(requireProfile(profileId)))
  ipcMain.handle('saves:detectExisting', () => detectExistingSaves())
  ipcMain.handle('saves:importExisting', async (_e, profileId: number, label: string) => {
    // An import is remembered forever by a content marker: taking it from a
    // folder the running game is halfway through writing records a torn copy as
    // the one the user arrived with, and it is never offered again.
    await requireGameClosed()
    const result = await importExistingSaves(requireProfile(profileId), label || 'Imported from your existing install')
    toast('success', t('messages.saves.imported', { slots: result.slots }))
    return result
  })

  // --- health ---------------------------------------------------------------
  // A health run is a diagnosis the user asked for, so it is not refused while
  // the game is up - it is made not to write. Its write-access check forces a
  // probe, which creates a file inside modloader\; establishing the running
  // state first is what suppresses that, with no write of its own.
  ipcMain.handle('health:run', async (_e, profileId: number) => {
    await noteWhetherGameIsRunning()
    return runHealthCheck(requireProfile(profileId))
  })
  ipcMain.handle('health:crashes', (_e, profileId: number) => listCrashes(requireProfile(profileId)))
  ipcMain.handle('health:incidents', (_e, profileId: number) => listIncidents(requireProfile(profileId)))
  ipcMain.handle('health:scanCrashes', (_e, profileId: number) => scanCrashes(requireProfile(profileId)))
  ipcMain.handle('health:resolveCrash', (_e, id: number, resolved: boolean) => setCrashResolved(id, resolved))
  ipcMain.handle('health:lookupAddress', async (_e, address: string) => {
    const m = await lookup(address)
    return {
      address: m.address,
      cause: m.cause ?? (m.nearest ? `${m.nearest.cause} (nearest known address ${m.nearest.address})` : null),
      solution: m.solution
    }
  })
  // "Deep analysis": for a crash address CrashList has no entry for. Not a
  // disassembler - see src/main/diagnostics/disasm.ts for exactly what this
  // does and does not do.
  ipcMain.handle('health:deepAnalyze', async (_e, address: string) => {
    const game = requireActiveGame()
    const exeName = gameDefinition(game.kind).exeNames[0]
    const { deepAnalyse } = await import('./diagnostics/disasm')
    return deepAnalyse(path.join(game.path, exeName), address)
  })
  // The renderer still passes a profile id; the logs are not per-profile, and an
  // extra argument to a handler that ignores it is harmless.
  ipcMain.handle('health:modLoaderReport', async (_e, profileId: number) => {
    const game = requireActiveGame()
    const expected = (
      getDb()
        .prepare('SELECT folder_name FROM install WHERE profile_id = ? AND enabled = 1 AND folder_name IS NOT NULL')
        .all(requireProfile(profileId)) as { folder_name: string }[]
    ).map((r) => r.folder_name)
    const { reportFromGame } = await import('./diagnostics/modloaderLog')
    return reportFromGame(game.path, expected)
  })
  ipcMain.handle('health:fixStreamingMemory', async (_e, memoryMb?: number) => {
    await requireIdleGame()
    const game = requireActiveGame()
    const { setStreamingMemory, SAFE_STREAMING_MEMORY_MB } = await import('./game/streamIni')
    const result = await setStreamingMemory(
      game.path,
      memoryMb ?? SAFE_STREAMING_MEMORY_MB,
      path.join(Paths.quarantine(), 'stream-ini')
    )
    toast('success', t('messages.installDeps.streamingFixed', { from: String(result.from ?? '?'), to: result.to }))
    return result
  })
  ipcMain.handle('health:logs', () => collectLogs())
  ipcMain.handle('health:bisectStart', async (_e, profileId: number) => {
    await requireIdleGame()
    // The session applies its own first step: it turns mods off through the ini
    // rather than moving files, so there is nothing else to do here.
    return startBisect(requireProfile(profileId))
  })
  // Both of these rewrite modloader.ini - recording a result applies the next
  // step, aborting restores the original. Bisecting is launch-test-record in a
  // loop, so it is the likeliest thing to be done with the game still open.
  ipcMain.handle('health:bisectResult', async (_e, sessionId: string, result: 'good' | 'bad') => {
    await requireGameClosed()
    return recordResult(sessionId, result)
  })
  ipcMain.handle('health:bisectAbort', async (_e, sessionId: string) => {
    await requireGameClosed()
    return abortBisect(sessionId)
  })
  ipcMain.handle('health:bisectCurrent', (_e, profileId: number) => currentBisect(requireProfile(profileId)))

  // --- tasks ----------------------------------------------------------------
  ipcMain.handle('tasks:cancel', (_e, taskId: string) => {
    tasks.get(taskId)?.abort()
    tasks.delete(taskId)
  })
}

/**
 * Byte totals for everything Modão owns under userData, so the Settings
 * screen can say where the disk went. The database is reported with its
 * write-ahead log, which can be larger than the database file itself, and
 * downloaded archives are split out of the store total rather than counted
 * twice - they live inside it.
 */
export async function storageReport(): Promise<StorageReport> {
  const dbFile = Paths.db()
  let dbBytes = 0
  for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) {
    const st = await fsp.stat(f).catch(() => null)
    if (st) dbBytes += st.size
  }
  const archivesBytes = await dirSize(Paths.archives())
  const storeBytes = Math.max(0, (await dirSize(Paths.store())) - archivesBytes)

  // Snapshots live per profile; a quarantined snapshot is counted as quarantine.
  const profilesRoot = path.join(Paths.userData(), 'profiles')
  let snapshotBytes = 0
  const profileDirs = await fsp.readdir(profilesRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of profileDirs) {
    if (!entry.isDirectory()) continue
    snapshotBytes += await dirSize(path.join(profilesRoot, entry.name, 'snapshots'))
  }

  return {
    userData: Paths.userData(),
    dbBytes,
    storeBytes,
    archivesBytes,
    cacheBytes: await dirSize(Paths.httpCache()),
    quarantineBytes: await dirSize(Paths.quarantine()),
    snapshotBytes
  }
}

/**
 * Empties one cache directory and reports what that recovered.
 *
 * Quarantine is not a cache: it holds save snapshots, files the user edited
 * after installing, and payloads displaced by an install - the last copy of
 * each. So the total is summed first and only then is anything deleted, and
 * the caller is told the number rather than left to guess.
 */
export async function clearCache(kind: CacheKind): Promise<{ freed: number }> {
  const dir =
    kind === 'http' ? Paths.httpCache() : kind === 'archives' ? Paths.archives() : kind === 'quarantine' ? Paths.quarantine() : null
  if (!dir) throw new Error(t('messages.cache.unknownKind', { kind: String(kind) }))

  const freed = (await walk(dir)).reduce((a, f) => a + f.size, 0)
  for (const entry of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    await fsp.rm(path.join(dir, entry.name), { recursive: true, force: true })
  }
  return { freed }
}

/**
 * Forgets a game install. The profiles built against it are detached rather
 * than cascaded away - their mod lists, saves and snapshots outlive the path,
 * and the user may be re-adding the same folder from a different drive letter.
 */
export function removeGame(id: number): void {
  const db = getDb()
  const row = db.prepare('SELECT id, path, is_active FROM game_install WHERE id = ?').get(id) as
    | { id: number; path: string; is_active: number }
    | undefined
  if (!row) return
  const active = db.prepare('SELECT name FROM profile WHERE game_id = ? AND is_active = 1').get(id) as { name: string } | undefined
  if (active) {
    throw new Error(t('messages.game.activeElsewhere', { profile: active.name, path: row.path }))
  }
  db.transaction(() => {
    db.prepare('UPDATE profile SET game_id = NULL WHERE game_id = ?').run(id)
    db.prepare('DELETE FROM game_install WHERE id = ?').run(id)
    if (row.is_active) {
      const next = db.prepare('SELECT id FROM game_install ORDER BY id LIMIT 1').get() as { id: number } | undefined
      if (next) db.prepare('UPDATE game_install SET is_active = 1 WHERE id = ?').run(next.id)
    }
  })()
}

/**
 * Downloads a mod archive into the store, with progress and cancellation, then
 * verifies it - against the catalogue hash when one is known, and by looking at
 * the bytes either way.
 *
 * File hosts in this scene reject anything that does not look like a browser
 * following a link from the mod page, and some answer 200 with an HTML
 * interstitial instead of the file. Both cases are caught here and reported as
 * "download it yourself", because that is the only thing the user can act on.
 */
/**
 * GitHub publishes releases through an API, so a link to a release page is
 * still something Modão can install: ask for the release, take the first
 * asset that is an archive. Unauthenticated calls are rate limited to 60 an
 * hour, which is far beyond what installing a mod needs.
 */
async function resolveGithubRelease(url: string): Promise<string> {
  const repo = githubRepo(new URL(url))
  if (!repo) throw new Error(t('messages.download.notGithubRelease'))
  const { request } = await import('undici')
  const { userAgent } = await import('./catalog/http')
  const api = repo.tag
    ? `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/tags/${repo.tag}`
    : `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`

  const res = await request(api, {
    headers: { 'user-agent': userAgent(), accept: 'application/vnd.github+json' },
    maxRedirections: 3
  })
  if (res.statusCode >= 400) {
    throw new Error(t('messages.download.githubHttpError', { status: res.statusCode, repo: `${repo.owner}/${repo.repo}` }))
  }
  const release = (await res.body.json()) as { assets?: { name: string; browser_download_url: string }[]; html_url?: string }
  const asset = (release.assets ?? []).find((a) => /\.(7z|zip|rar)$/i.test(a.name))
  if (!asset) {
    throw new Error(t('messages.download.noArchiveAsset', { repo: `${repo.owner}/${repo.repo}` }))
  }
  log('resolved a GitHub release to an asset', { repo: `${repo.owner}/${repo.repo}`, asset: asset.name })
  return asset.browser_download_url
}

async function downloadArchive(
  url: string,
  taskId: string,
  label: string,
  signal: AbortSignal,
  expectedSha: string | null,
  modVersionId: number,
  referer: string
): Promise<string> {
  const kind = classifyDownload(url)

  // A link to a file is fetched directly. A link to a download page - which is
  // nearly everything MixMods points at - is opened in an invisible sandboxed
  // browser window, which is the only thing these hosts will serve. Either way
  // the user gets an archive and the same install plan.
  let dest: string
  if (kind.direct) {
    dest = await downloadFile(kind.kind === 'github-release' ? await resolveGithubRelease(url) : url, {
      taskId,
      label,
      signal,
      referer
    })
  } else {
    progress(taskId, `Fetching ${label}`, `opening ${kind.host}`, 0, 100)
    log('fetching through a browser window', { host: kind.host, url })
    dest = await fetchThroughBrowser(url, {
      destDir: Paths.archives(),
      referer,
      signal,
      onProgress: (received, total) => progress(taskId, `Downloading ${label}`, kind.host, received, total || received)
    })
  }

  progress(taskId, `Verifying ${label}`, 'verify', 1, 1)
  const { sha256File } = await import('./util/fsx')
  const actual = await sha256File(dest)
  if (expectedSha && expectedSha !== actual) {
    await fsp.rm(dest, { force: true })
    throw new Error(
      t('messages.download.hashMismatch', { label, expected: expectedSha.slice(0, 16), actual: actual.slice(0, 16) })
    )
  }
  if (!expectedSha) {
    const size = (await fsp.stat(dest)).size
    getDb().prepare('UPDATE mod_version SET sha256 = ?, file_size = ? WHERE id = ?').run(actual, size, modVersionId)
  }
  return dest
}

/** The plain HTTP path, for links that really are files. */
async function downloadFile(
  fileUrl: string,
  ctx: { taskId: string; label: string; signal: AbortSignal; referer: string }
): Promise<string> {
  const { request } = await import('undici')
  const { userAgent } = await import('./catalog/http')
  const res = await request(fileUrl, {
    headers: {
      'user-agent': userAgent(),
      accept: 'application/octet-stream, application/zip, application/x-7z-compressed, */*',
      'accept-language': 'en,pt-BR;q=0.8',
      referer: ctx.referer
    },
    maxRedirections: 5,
    signal: ctx.signal
  })
  if (res.statusCode >= 400) {
    throw new Error(t('messages.download.httpError', { host: hostOf(fileUrl), status: res.statusCode, label: ctx.label }))
  }
  if (/text\/html/i.test(String(res.headers['content-type'] ?? ''))) {
    throw new Error(t('messages.download.gotWebPage', { host: hostOf(fileUrl) }))
  }

  const total = Number.parseInt(String(res.headers['content-length'] ?? '0'), 10)
  const name = path.basename(new URL(fileUrl).pathname) || `${ctx.label.replace(/[^\w]+/g, '-')}.7z`
  const dest = path.join(Paths.archives(), `${Date.now()}-${name}`)

  // Streamed to disk rather than buffered: a texture pack is routinely larger
  // than the memory a renderer process is willing to hand out in one block.
  const handle = await fsp.open(dest, 'w')
  let received = 0
  let head = Buffer.alloc(0)
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk)
      if (head.length < 8) head = Buffer.concat([head, buf.subarray(0, 8)]).subarray(0, 8)
      await handle.write(buf)
      received += buf.length
      progress(ctx.taskId, `Downloading ${ctx.label}`, 'download', received, total || received)
    }
  } finally {
    await handle.close()
  }

  if (!looksLikeArchive(head)) {
    await fsp.rm(dest, { force: true })
    throw new Error(t('messages.download.notAnArchive', { host: hostOf(fileUrl) }))
  }
  return dest
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return t('messages.download.fallbackHost')
  }
}

export async function bootstrap(): Promise<void> {
  getDb()
  setMainLanguage(getSetting('ui.language', DEFAULT_LANGUAGE))
  await loadSeedCatalog()
}

/**
 * Downloads a catalogue release and turns it into an install plan.
 *
 * Two channels reach this: the catalogue screen, which has a version id, and a
 * requirement named in a readme, which has a slug. Calling one IPC handler from
 * another does not work - ipcMain keeps handlers in a map of its own, not as
 * listeners - which is how "handler is not a function" happened.
 */
async function planFromCatalogVersion(modVersionId: number, profileId: number): Promise<InstallPlan> {
  const db = getDb()
  const row = db
    .prepare(
      `SELECT mv.id, mv.download_url, mv.version_label, m.id AS mod_id, m.title, m.author, m.source_url, m.paywalled
         FROM mod_version mv JOIN mod m ON m.id = mv.mod_id WHERE mv.id = ?`
    )
    .get(modVersionId) as
    | {
        id: number
        download_url: string | null
        version_label: string
        mod_id: number
        title: string
        author: string
        source_url: string
        paywalled: number
      }
    | undefined
  if (!row) throw new Error(t('messages.install.versionGone'))
  if (row.paywalled) throw new Error(t('messages.install.paywalled', { title: row.title }))
  if (!row.download_url) throw new Error(t('messages.install.noDownloadLink', { title: row.title }))

  const expected = (db.prepare('SELECT sha256 FROM mod_version WHERE id = ?').get(modVersionId) as {
    sha256: string | null
  }).sha256
  const task = newTask(`Installing ${row.title}`)
  try {
    const archivePath = await downloadArchive(
      row.download_url,
      task.id,
      row.title,
      task.signal,
      expected,
      modVersionId,
      row.source_url
    )
    const plan = await createPlan({
      archivePath,
      profileId,
      modId: row.mod_id,
      modVersionId: row.id,
      title: row.title,
      author: row.author,
      sourceUrl: row.source_url,
      signal: task.signal,
      onProgress: (phase, c, total) => progress(task.id, `Installing ${row.title}`, phase, c, total)
    })
    task.end()
    return plan
  } catch (e) {
    task.end((e as Error).message)
    throw e
  }
}
