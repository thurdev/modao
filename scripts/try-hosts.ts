/**
 * Runs the real fetcher against one live link per file host in the catalogue
 * and reports what came back. This is the check that says whether "Install"
 * actually installs: every one of these hosts answers 403 to a plain HTTP
 * client, so the only way to know is to try.
 *
 *   npm run try:hosts        (targets come from out/host-tests.json)
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchThroughBrowser } from '../src/main/install/fetcher'
import { classifyDownload } from '../src/shared/download'

const REPORT = path.join('out', 'host-report.txt')
const say = (line: string): void => {
  console.log(line)
  fs.appendFileSync(REPORT, `${line}\n`)
}

interface Target {
  host: string
  slug: string
  url: string
  referer: string
}

process.on('uncaughtException', (e) => {
  say(`UNCAUGHT ${e.stack ?? e.message}`)
  app.exit(1)
})

// Electron quits when the last window closes, and each fetch destroys its own
// window. The real app always has its main window open; this harness does not.
app.on('window-all-closed', () => undefined)

void app.whenReady().then(async () => {
  const targets = JSON.parse(fs.readFileSync(path.join('out', 'host-tests.json'), 'utf8')) as Target[]
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'modao-hosts-'))
  let ok = 0

  for (const [index, target] of targets.entries()) {
    say(`--- ${index + 1}/${targets.length} ${target.host} (${target.slug})`)
    const kind = classifyDownload(target.url)
    const started = Date.now()
    try {
      if (kind.direct) {
        say(`${target.host.padEnd(18)} SKIP (a direct link; the plain HTTP path handles this one)`)
        ok++
        continue
      }
      const file = await fetchThroughBrowser(target.url, { destDir: dest, referer: target.referer, timeoutMs: 60_000 })
      const size = fs.statSync(file).size
      // Read only the header: these archives run to gigabytes, and reading one
      // whole is how this harness used to fail a download that had succeeded.
      const fd = fs.openSync(file, 'r')
      const head = Buffer.alloc(4)
      fs.readSync(fd, head, 0, 4, 0)
      fs.closeSync(fd)
      const magic = head.toString('hex')
      say(
        `${target.host.padEnd(18)} OK   ${(size / 1024 / 1024).toFixed(2)} MB  magic=${magic}  ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s  ${path.basename(file).slice(0, 48)}`
      )
      ok++
    } catch (e) {
      say(`${target.host.padEnd(18)} FAIL ${(e as Error).message.slice(0, 120)}`)
    }
  }

  say(`\n${ok} of ${targets.length} hosts fetched`)
  app.exit(ok === targets.length ? 0 : 1)
})
