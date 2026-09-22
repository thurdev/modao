import { app, BrowserWindow } from 'electron'
import type { UpdateProgress, UpdateStatus } from '@shared/types'
import { getSetting, setSetting } from '../db'
import { log, logError } from './log'
import { isNewer } from './updates'

/**
 * Updating without leaving the app.
 *
 * electron-updater reads the release GitHub publishes, downloads the installer
 * in the background and hands it to Windows, which replaces the app and starts
 * it again. Nobody should have to go to a web page, find a file and run an
 * installer to get a bug fix.
 *
 * Two rules it follows:
 *
 *   - It never downloads on its own. The user is told a version exists and
 *     decides; a mod manager has no business spending someone's bandwidth
 *     because it felt like it.
 *   - It never restarts on its own either. quitAndInstall is called when the
 *     user presses the button, not when the download happens to finish, because
 *     the app may be mid-install of a 7 GB mod.
 *
 * The installer is unsigned, which Windows will warn about - electron-updater
 * still verifies the download against the sha512 in the release metadata, so a
 * corrupted or swapped file is rejected.
 */
const DISMISSED_KEY = 'updates.dismissedVersion'

type Updater = typeof import('electron-updater').autoUpdater

let updater: Updater | null = null
let downloading = false
let downloaded: string | null = null

function send(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/**
 * Loaded lazily: electron-updater refuses to run unpackaged, and importing it
 * at startup would make `npm run dev` noisy for no reason.
 */
async function getUpdater(): Promise<Updater | null> {
  if (!app.isPackaged) return null
  if (updater) return updater
  const { autoUpdater } = await import('electron-updater')
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.logger = {
    info: (m: unknown) => log(`updater: ${String(m)}`),
    warn: (m: unknown) => log(`updater: ${String(m)}`),
    error: (m: unknown) => logError('updater', m),
    debug: () => undefined
  }

  autoUpdater.on('download-progress', (p) => {
    const progress: UpdateProgress = {
      percent: Math.round(p.percent),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: Math.round(p.bytesPerSecond)
    }
    send('event:updateProgress', progress)
  })
  autoUpdater.on('update-downloaded', (info) => {
    downloading = false
    downloaded = info.version
    log('update downloaded', { version: info.version })
    send('event:updateReady', { version: info.version })
  })
  autoUpdater.on('error', (err) => {
    downloading = false
    logError('update failed', err)
    send('event:updateError', { message: err.message })
  })

  updater = autoUpdater
  return updater
}

/** Asks the release feed what the newest version is. Downloads nothing. */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = app.getVersion()
  const base: UpdateStatus = {
    current,
    latest: null,
    available: false,
    dismissed: false,
    releaseUrl: null,
    publishedAt: null,
    notes: null,
    checkedAt: new Date().toISOString(),
    error: null,
    downloading,
    downloadedVersion: downloaded,
    canInstall: downloaded !== null
  }

  const u = await getUpdater()
  if (!u) {
    // Unpackaged: the HTTP check still answers, so the UI can be worked on.
    const { checkForUpdate: viaApi } = await import('./updates')
    const status = await viaApi(true)
    return { ...base, ...status, downloading, downloadedVersion: downloaded, canInstall: downloaded !== null }
  }

  try {
    const result = await u.checkForUpdates()
    const latest = result?.updateInfo.version ?? null
    return {
      ...base,
      latest,
      available: latest !== null && isNewer(latest, current),
      dismissed: latest !== null && getSetting(DISMISSED_KEY, '') === latest,
      publishedAt: result?.updateInfo.releaseDate ?? null,
      notes: typeof result?.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes.slice(0, 4000) : null,
      releaseUrl: `https://github.com/thurdev/modao/releases/tag/v${latest ?? current}`
    }
  } catch (e) {
    return { ...base, error: (e as Error).message }
  }
}

/** Starts the download the user asked for. Progress arrives as events. */
export async function downloadUpdate(): Promise<{ started: boolean; message: string }> {
  const u = await getUpdater()
  if (!u) {
    return {
      started: false,
      message: 'Updates install themselves only in the packaged app; this is a development build.'
    }
  }
  if (downloading) return { started: true, message: 'Already downloading.' }
  downloading = true
  try {
    await u.downloadUpdate()
    return { started: true, message: 'Downloading.' }
  } catch (e) {
    downloading = false
    throw e
  }
}

/**
 * Replaces the app and starts it again.
 *
 * Everything the app owns lives in userData and in the game folder, neither of
 * which the installer touches, so a restart here loses nothing - but it is
 * still the user's call, because they may be in the middle of something.
 */
export async function installUpdateAndRestart(): Promise<void> {
  const u = await getUpdater()
  if (!u || !downloaded) throw new Error('No update has been downloaded yet.')
  log('installing update and restarting', { version: downloaded })
  setSetting('updates.installedFrom', app.getVersion())
  // isSilent false: the NSIS installer shows its progress, which is what a user
  // expects to see when an app replaces itself.
  setImmediate(() => u.quitAndInstall(false, true))
}

export function dismissUpdate(version: string): void {
  setSetting(DISMISSED_KEY, version.replace(/^v/i, ''))
}

export function updateState(): { downloading: boolean; downloadedVersion: string | null } {
  return { downloading, downloadedVersion: downloaded }
}
