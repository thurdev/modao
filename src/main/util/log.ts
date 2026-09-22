import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * A plain text log in userData. A packaged Electron app has no console, so
 * without this a startup failure is invisible: the window never appears and
 * there is nothing to read. Every line is timestamped and the file is trimmed
 * rather than allowed to grow forever.
 */
let logFile: string | null = null

function file(): string {
  if (logFile) return logFile
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  logFile = path.join(dir, 'main.log')
  try {
    const stat = fs.statSync(logFile)
    if (stat.size > 512 * 1024) fs.writeFileSync(logFile, '')
  } catch {
    /* first run */
  }
  return logFile
}

export function log(message: string, detail?: unknown): void {
  const line = `${new Date().toISOString()}  ${message}${detail === undefined ? '' : ` ${format(detail)}`}
`
  try {
    fs.appendFileSync(file(), line)
  } catch {
    /* logging must never be the thing that breaks startup */
  }
  if (!app.isPackaged) process.stdout.write(line)
}

export function logError(message: string, error: unknown): void {
  const err = error as Error
  log(`ERROR ${message}`, err?.stack ?? err?.message ?? String(error))
}

export function logPath(): string {
  return file()
}

function format(detail: unknown): string {
  if (typeof detail === 'string') return detail
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}
