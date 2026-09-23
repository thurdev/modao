import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { exists } from '../util/fsx'

/**
 * 7-Zip handles .7z, .zip and .rar, which is everything MixMods ships.
 * The binary comes from 7zip-bin and is unpacked out of the asar at build time.
 */
export function sevenZipPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bin = require('7zip-bin') as { path7za: string }
  let p = bin.path7za
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked')
  return p
}

export class ArchiveError extends Error {}

function run(args: string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath(), args, { windowsHide: true })
    let out = ''
    let err = ''
    const onAbort = (): void => {
      child.kill()
      reject(new ArchiveError('Cancelled'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (d: Buffer) => {
      const text = d.toString('utf8')
      out += text
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line)
    })
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')))
    child.on('error', (e) => reject(new ArchiveError(e.message)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolve(out)
      else reject(new ArchiveError(err.trim() || out.trim() || `7-Zip exited with code ${code}`))
    })
  })
}

export interface ExtractOptions {
  onProgress?: (percent: number, file: string) => void
  signal?: AbortSignal
  /** MixMods ships some archives locked with the site's own name. */
  password?: string
}

/** The password MixMods puts in its file names, for the archives that carry one. */
export const MIXMODS_PASSWORD = 'mixmods.com.br'

export async function extractArchive(archive: string, dest: string, opts: ExtractOptions = {}): Promise<string> {
  await fsp.mkdir(dest, { recursive: true })
  await run(
    ['x', archive, `-o${dest}`, '-y', '-bsp1', '-bb1', `-p${opts.password ?? ''}`],
    (line) => {
      const pm = /(\d+)%/.exec(line)
      const fm = /^- (.+)$/.exec(line)
      if (opts.onProgress && (pm || fm)) {
        opts.onProgress(pm ? Number.parseInt(pm[1], 10) : -1, fm ? fm[1] : '')
      }
    },
    opts.signal
  )
  return dest
}

/** Archives often wrap everything in a single top folder; unwrap it for classification. */
export async function effectiveRoot(dir: string): Promise<string> {
  let current = dir
  for (let depth = 0; depth < 4; depth++) {
    const entries = await fsp.readdir(current, { withFileTypes: true })
    const visible = entries.filter((e) => !e.name.startsWith('.') && e.name.toLowerCase() !== '__macosx')
    if (visible.length === 1 && visible[0].isDirectory()) {
      const inner = path.join(current, visible[0].name)
      // Do not unwrap a folder that is itself the mod (a Mod Loader folder).
      if (looksLikeModFolder(await fsp.readdir(inner).catch(() => []))) return current
      current = inner
      continue
    }
    break
  }
  return current
}

const MOD_SUBFOLDERS = new Set([
  'models',
  'data',
  'cleo',
  'anim',
  'text',
  'audio',
  'movies',
  'effects',
  'sfx',
  'streams'
])

export function looksLikeModFolder(names: string[]): boolean {
  const lower = names.map((n) => n.toLowerCase())
  if (lower.some((n) => MOD_SUBFOLDERS.has(n))) return true
  return lower.some((n) => /\.(dff|txd|ifp|col|ide|ipl|dat|img|fxp|cfg)$/.test(n))
}

export function isArchiveFile(file: string): boolean {
  return /\.(7z|zip|rar)$/i.test(file)
}

export async function archiveOrDirectory(input: string, dest: string, opts: ExtractOptions = {}): Promise<string> {
  if (isArchiveFile(input)) return extractArchive(input, dest, opts)
  if (exists(input)) return input
  throw new ArchiveError(`${input} is neither an archive nor an existing folder`)
}
