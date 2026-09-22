/**
 * Manual check for the browser-based fetcher: hand it a real file-host link and
 * see whether an archive lands on disk. Run inside Electron, because that is
 * where the download window lives.
 *
 *   npm run build && npx electron out/main/index.js   (no)
 *   npm run try:fetch -- <url> [referer]
 */
import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fetchThroughBrowser } from '../src/main/install/fetcher'

// Electron detaches stdio on Windows, so the result goes to a file the shell can read.
const REPORT = path.join(process.cwd(), 'out', 'fetch-report.txt')
const report = (line: string): void => {
  console.log(line)
  fs.appendFileSync(REPORT, `${line}
`)
}

process.on('uncaughtException', (e) => {
  report(`UNCAUGHT ${e.stack ?? e.message}`)
  app.exit(1)
})
process.on('unhandledRejection', (e) => {
  report(`UNHANDLED ${(e as Error)?.stack ?? String(e)}`)
  app.exit(1)
})

void app.whenReady().then(async () => {
  report(`argv: ${JSON.stringify(process.argv.slice(1))}`)
  // Electron swallows a URL passed on the command line, so the target comes
  // from a file the caller writes.
  const cfg = JSON.parse(fs.readFileSync(path.join('out', 'fetch-target.json'), 'utf8')) as { url: string; referer?: string }
  const url = cfg.url
  const referer = cfg.referer ?? 'https://www.mixmods.com.br/'
  if (!url) {
    report('usage: try:fetch <url> [referer]')
    app.exit(1)
    return
  }
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'modao-fetch-'))
  const started = Date.now()
  try {
    const file = await fetchThroughBrowser(url, {
      destDir: dest,
      referer,
      onProgress: (r, t) => {
        if (r % (2 * 1024 * 1024) < 65536) report(`  ${(r / 1024 / 1024).toFixed(1)} MB of ${(t / 1024 / 1024).toFixed(1)} MB`)
      }
    })
    const size = fs.statSync(file).size
    report(`OK  ${path.basename(file)}  ${(size / 1024 / 1024).toFixed(2)} MB in ${((Date.now() - started) / 1000).toFixed(1)}s`)
    app.exit(0)
  } catch (e) {
    report(`FAIL  ${(e as Error).message}`)
    app.exit(1)
  }
})
