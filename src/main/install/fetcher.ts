import path from 'node:path'
import { BrowserWindow, session as electronSession } from 'electron'
import type { DownloadItem } from 'electron'
import { classifyDownload, looksLikeArchive, normalizeForFetch } from '@shared/download'
import { log, logError } from '../util/log'
import { readFileChunk } from '../util/fsx'

/**
 * Fetches a mod archive from a file host that only serves browsers.
 *
 * Almost nothing in this scene is a direct link: MixMods points at sharemods,
 * MediaFire, Mega and Google Drive, which answer 403 to a plain HTTP client and
 * hand a browser an interstitial with a button on it. Rather than
 * reimplementing each host's handshake - and re-breaking every time one of them
 * changes - Modão does what a person does: it opens the page in a real but
 * invisible sandboxed window, presses the download control, and catches the
 * file Chromium downloads.
 *
 * The window is as locked down as a window gets: no Node, context isolation on,
 * sandbox on, its own session partition, popups denied (these pages are thick
 * with them, and following one would navigate away from the download), and it
 * is destroyed the moment the transfer ends. The only thing that survives is
 * the archive.
 */
const PARTITION = 'persist:modao-downloads'
const FIRST_PRESS_MS = 1200
const PRESS_INTERVAL_MS = 2500
/** How long a page may go without producing anything before Modão gives up. */
const STALL_TIMEOUT_MS = 90_000

/**
 * What runs inside the page, written against what these hosts actually do:
 *
 *  - a cookie wall covers everything until it is dismissed, and "reject"
 *    dismisses it without consenting to tracking on the user's behalf
 *  - XFileSharing hosts (sharemods and relatives) show "Create download link",
 *    which posts a hidden form and rebuilds the page
 *  - the link that appears afterwards is a signed storage URL carrying the file
 *    name in its query string, so matching only ".zip" at the end of a path
 *    misses every one of them
 */
const PAGE_DRIVER = `
(function () {
  var log = []
  var textOf = function (el) { return ((el.textContent || '') + ' ' + (el.value || '')).trim().toLowerCase() }
  var visible = function (el) {
    if (!el) return false
    var r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  var all = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)) }

  var consent = all('button, a').filter(function (b) {
    return /^(reject all|only necessary|essential only|rejeitar)/.test(textOf(b))
  })[0]
  if (visible(consent)) {
    consent.click()
    log.push('dismissed the cookie wall')
  }

  var isArchiveHref = function (href) {
    if (!href) return false
    if (/\\.(7z|zip|rar)(\\?|$)/i.test(href)) return true
    if (/response-content-disposition/i.test(href)) {
      try {
        return /\\.(7z|zip|rar)/i.test(decodeURIComponent(href))
      } catch (e) {
        return false
      }
    }
    return false
  }

  // The real file always lives somewhere else: download844.mediafire.com, a
  // signed storage bucket, a CDN. A link on this host that merely ends in .7z
  // is another page about the file, and downloading it yields HTML.
  var isTheFileItself = function (href) {
    if (!isArchiveHref(href)) return false
    if (/response-content-disposition/i.test(href)) return true
    try {
      return new URL(href, location.href).hostname !== location.hostname
    } catch (e) {
      return false
    }
  }

  var archive = all('a').filter(function (a) { return isTheFileItself(a.href) })[0]
  if (archive) {
    // Hand the link back rather than clicking it: a click may open a tab, be
    // swallowed by an overlay, or navigate somewhere that never downloads.
    // The main process can fetch it directly, with this page's cookies.
    return JSON.stringify({ found: archive.href, note: log.join(' | ') })
  }

  // A same-host page about the file is a step on the way, not the end of it.
  var filePage = all('a').filter(function (a) {
    return isArchiveHref(a.href) && a.href !== location.href
  })[0]
  if (filePage) {
    log.push('following the file page')
    location.href = filePage.href
    return JSON.stringify({ found: '', note: log.join(' | ') })
  }

  var button =
    document.querySelector('#downloadbtn') ||
    document.querySelector('#downloadButton') ||
    document.querySelector('#download-button') ||
    document.querySelector('a.download_bt') ||
    document.querySelector('#uc-download-link')
  if (visible(button)) {
    button.click()
    log.push('pressed ' + (button.id || button.className))
    return JSON.stringify({ found: '', note: log.join(' | ') })
  }

  var countdown = document.querySelector('#countdown, .countdown, #cxc, .seconds')
  if (countdown && textOf(countdown)) {
    log.push('waiting out the timer: ' + textOf(countdown).slice(0, 24))
    return JSON.stringify({ found: '', note: log.join(' | ') })
  }

  var form = document.querySelector('form[name="F1"], form#F1')
  if (form) {
    var submit = form.querySelector('input[type="submit"], button[type="submit"]')
    if (visible(submit)) {
      submit.click()
      log.push('submitted the download form')
      return JSON.stringify({ found: '', note: log.join(' | ') })
    }
  }

  return JSON.stringify({ found: '', note: log.length ? log.join(' | ') : 'nothing to press (' + document.title.slice(0, 40) + ')' })
})()
`

export interface BrowserFetchOptions {
  /** Where the archive should end up. */
  destDir: string
  /** The mod page, sent as the referer - some hosts insist on it. */
  referer?: string
  onProgress?: (received: number, total: number) => void
  signal?: AbortSignal
  timeoutMs?: number
}

export class DownloadRefused extends Error {}

export async function fetchThroughBrowser(url: string, opts: BrowserFetchOptions): Promise<string> {
  const ses = electronSession.fromPartition(PARTITION)
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  win.webContents.setWindowOpenHandler(({ url: popup }) => {
    // These pages are thick with ad popups, but the file itself is sometimes
    // opened the same way. Take the download, drop everything else.
    if (classifyDownload(popup).direct || /response-content-disposition|\/download/i.test(popup)) {
      log('a popup carried the download', popup.slice(0, 120))
      win.webContents.downloadURL(popup)
    } else {
      log('blocked a popup from the download page', popup.slice(0, 120))
    }
    return { action: 'deny' }
  })

  let settle: ((file: string) => void) | null = null
  let fail: ((error: Error) => void) | null = null
  const finished = new Promise<string>((resolve, reject) => {
    settle = resolve
    fail = reject
  })

  const onWillDownload = (_event: Electron.Event, item: DownloadItem): void => {
    const name = sanitize(item.getFilename())
    const file = path.join(opts.destDir, `${Date.now()}-${name}`)
    log('download started', { name, bytes: item.getTotalBytes() })
    item.setSavePath(file)
    item.on('updated', (_e, state) => {
      if (state !== 'progressing') return
      keepAlive()
      opts.onProgress?.(item.getReceivedBytes(), item.getTotalBytes())
    })
    item.once('done', (_e, state) => {
      if (state === 'completed') settle?.(file)
      else fail?.(new DownloadRefused(`The transfer stopped (${state}).`))
    })
  }
  ses.on('will-download', onWillDownload)

  const abort = (): void => fail?.(new DownloadRefused('Cancelled.'))
  opts.signal?.addEventListener('abort', abort, { once: true })

  // A watchdog on silence, not on total time: a 2 GB texture pack may take a
  // quarter of an hour, and cutting it off at a fixed deadline would fail the
  // downloads people care most about. Any progress resets it.
  const stallMs = opts.timeoutMs ?? STALL_TIMEOUT_MS
  let watchdog: NodeJS.Timeout | null = null
  const keepAlive = (): void => {
    if (watchdog) clearTimeout(watchdog)
    watchdog = setTimeout(
      () =>
        fail?.(
          new DownloadRefused(
            'The file host stopped responding. It may have changed its page, or be asking for something only a person can answer.'
          )
        ),
      stallMs
    )
  }
  keepAlive()

  let presser: NodeJS.Timeout | null = null
  try {
    const target = normalizeForFetch(url)
    if (target !== url) log('rewrote the link to one that can be driven', target.slice(0, 120))

    // A navigation that turns straight into a download - which is exactly what
    // a working link does - makes loadURL reject with ERR_FAILED or
    // ERR_ABORTED. That is success, not failure, so the load result is noted
    // and the download itself decides the outcome.
    await win
      .loadURL(target, opts.referer ? { httpReferrer: opts.referer } : undefined)
      .then(() => log('opened the download page', target.slice(0, 120)))
      .catch((e: Error) => log('the page became a download or refused to render', e.message.slice(0, 120)))

    let downloadStarted = false
    ses.once('will-download', () => {
      downloadStarted = true
    })

    /**
     * Three ways to take a link the page produced, tried in the order that
     * works most often: hand it to Chromium, navigate to it the way a click
     * would, then fetch it directly with the page's cookies. Whichever starts
     * first wins; none of them is fatal on its own.
     */
    const claimResolved = async (href: string): Promise<void> => {
      if (win.isDestroyed()) return
      win.webContents.downloadURL(href)
      await wait(6000)
      if (downloadStarted || win.isDestroyed()) return

      log('no download yet; navigating to the link instead')
      win.webContents.loadURL(href).catch(() => undefined)
      await wait(8000)
      if (downloadStarted || win.isDestroyed()) return

      log('still nothing; fetching the link directly with the page cookies')
      try {
        const file = await takeResolvedFile(ses, win.webContents.getURL(), href, opts, (received, total) => {
          keepAlive()
          opts.onProgress?.(received, total)
        })
        settle?.(file)
      } catch (e) {
        log('the direct fetch failed too', (e as Error).message.slice(0, 120))
      }
    }

    let requested = ''
    const press = (): void => {
      if (win.isDestroyed()) return
      win.webContents
        .executeJavaScript(PAGE_DRIVER, true)
        .then((raw: string) => {
          const result = parseDriverResult(raw)
          if (result.note && !result.note.startsWith('nothing')) log('download page', result.note)
          if (result.found && result.found !== requested) {
            requested = result.found
            log('resolved the file link', result.found.slice(0, 120))
            void claimResolved(result.found)
          }
        })
        .catch(() => undefined)
    }
    // These hosts rebuild the page after the first press, so keep pressing
    // until the download starts or the timeout gives up.
    setTimeout(press, FIRST_PRESS_MS)
    presser = setInterval(press, PRESS_INTERVAL_MS)

    const file = await finished

    const head = await readFileChunk(file, 0, 8)
    if (!looksLikeArchive(head)) {
      throw new DownloadRefused('What the host sent is not a .7z, .zip or .rar - most likely an error page.')
    }
    return file
  } catch (e) {
    logError(`browser download failed for ${url}`, e)
    throw e instanceof DownloadRefused ? e : new DownloadRefused((e as Error).message)
  } finally {
    if (presser) clearInterval(presser)
    if (watchdog) clearTimeout(watchdog)
    opts.signal?.removeEventListener('abort', abort)
    ses.removeListener('will-download', onWillDownload)
    if (!win.isDestroyed()) win.destroy()
  }
}

/**
 * Fetches the link the page produced, with that page's cookies and referer.
 *
 * Handing the URL back to Chromium is not enough on every host: MediaFire's
 * signed link is bound to the session that produced it, and a bare navigation
 * to it is refused with no event at all - the app would simply wait until it
 * timed out. Fetching it explicitly gives a status code to report and bytes to
 * check.
 */
async function takeResolvedFile(
  ses: Electron.Session,
  pageUrl: string,
  fileUrl: string,
  opts: BrowserFetchOptions,
  onBytes?: (received: number, total: number) => void
): Promise<string> {
  const { request } = await import('undici')
  const fsp = await import('node:fs/promises')
  const cookies = await ses.cookies.get({ url: fileUrl }).catch(() => [])
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ')

  const res = await request(fileUrl, {
    headers: {
      // The page's own user agent: these links are checked against it.
      'user-agent': ses.getUserAgent(),
      accept: '*/*',
      referer: pageUrl,
      ...(cookieHeader ? { cookie: cookieHeader } : {})
    },
    maxRedirections: 5,
    signal: opts.signal
  })
  if (res.statusCode >= 400) throw new DownloadRefused(`the host answered HTTP ${res.statusCode}`)

  const name = sanitize(decodeURIComponent(path.basename(new URL(fileUrl).pathname)) || 'mod.zip')
  const file = path.join(opts.destDir, `${Date.now()}-${name}`)
  const total = Number.parseInt(String(res.headers['content-length'] ?? '0'), 10)

  // Streamed, never buffered: mod archives in this scene run to gigabytes, and
  // holding one in memory fails with "Array buffer allocation failed" on
  // exactly the packs people most want.
  const handle = await fsp.open(file, 'w')
  let received = 0
  let head = Buffer.alloc(0)
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.from(chunk)
      if (head.length < 8) head = Buffer.concat([head, buf.subarray(0, 8)]).subarray(0, 8)
      await handle.write(buf)
      received += buf.length
      onBytes?.(received, total || received)
    }
  } finally {
    await handle.close()
  }

  if (!looksLikeArchive(head)) {
    await fsp.rm(file, { force: true })
    throw new DownloadRefused('the bytes are not an archive')
  }
  log('fetched the resolved file', { name, bytes: received })
  return file
}

/** The page driver answers with JSON; older hosts may still answer with prose. */
function parseDriverResult(raw: string): { found: string; note: string } {
  try {
    const parsed = JSON.parse(raw) as { found?: string; note?: string }
    return { found: parsed.found ?? '', note: parsed.note ?? '' }
  } catch {
    return { found: '', note: String(raw ?? '') }
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]/g, '_').trim()
  return cleaned.length > 0 ? cleaned : 'download.bin'
}
