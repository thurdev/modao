import path from 'node:path'
import fsp from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { exists } from '../util/fsx'
import { t } from '../util/i18n'
import { classifyArchiveFailure, shouldRetryWithPassword, type ArchiveFailure } from '@shared/archiveFailure'

/**
 * The binary comes from 7zip-bin and is unpacked out of the asar at build time.
 *
 * It is `path7za`, the REDUCED build: `7za i` lists 7z, Cab, Split, bzip2,
 * gzip, lzma, lzma86, tar, xz and zip - and no Rar. MixMods does ship the odd
 * .rar, and there is no honest way to open one here, so a .rar is still
 * recognised as an archive and still handed to 7-Zip; when it fails to open,
 * the failure is named as the format it is rather than dressed up as damage.
 */
export function sevenZipPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const bin = require('7zip-bin') as { path7za: string }
  let p = bin.path7za
  if (app.isPackaged) p = p.replace('app.asar', 'app.asar.unpacked')
  return p
}

export class ArchiveError extends Error {
  /** What went wrong, as far as 7-Zip's output says. */
  readonly failure: ArchiveFailure | 'cancelled'
  /** 7-Zip's own output, stderr first, kept so a caller can look closer. */
  readonly output: string

  constructor(message: string, failure: ArchiveFailure | 'cancelled' = 'unknown', output = '') {
    super(message)
    this.failure = failure
    this.output = output
  }
}

function run(
  args: string[],
  archive: string,
  onLine?: (line: string) => void,
  signal?: AbortSignal
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(sevenZipPath(), args, { windowsHide: true })
    let out = ''
    let err = ''
    const onAbort = (): void => {
      child.kill()
      reject(new ArchiveError('Cancelled', 'cancelled'))
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
      else {
        // Both streams, because the password lines come over stderr and
        // `Can't open as archive` over stdout.
        const output = `${err}\n${out}`
        reject(
          new ArchiveError(
            err.trim() || out.trim() || `7-Zip exited with code ${code}`,
            classifyArchiveFailure(output, archive),
            output
          )
        )
      }
    })
  })
}

export interface ExtractOptions {
  onProgress?: (percent: number, file: string) => void
  signal?: AbortSignal
  /**
   * A password to try first. Nothing sets it today - the MixMods one below is
   * tried on its own when an archive turns out to be locked - but every layer
   * from here down takes it, so asking the user for a password is a dialog and
   * one extra argument, not a change to the extractor.
   */
  password?: string
}

/** The password MixMods puts in its file names, for the archives that carry one. */
export const MIXMODS_PASSWORD = 'mixmods.com.br'

/**
 * One `7z x`. The `-p` is never omitted: without it 7-Zip prints "Enter
 * password (will not be echoed):" and waits on a stdin nobody here ever writes
 * to or closes, so an encrypted archive hangs the install forever rather than
 * failing.
 */
function extractOnce(archive: string, dest: string, password: string, opts: ExtractOptions): Promise<string> {
  return run(
    ['x', archive, `-o${dest}`, '-y', '-bsp1', '-bb1', `-p${password}`],
    archive,
    (line) => {
      const pm = /(\d+)%/.exec(line)
      const fm = /^- (.+)$/.exec(line)
      if (opts.onProgress && (pm || fm)) {
        opts.onProgress(pm ? Number.parseInt(pm[1], 10) : -1, fm ? fm[1] : '')
      }
    },
    opts.signal
  )
}

/**
 * Extract, and answer a locked archive with the password MixMods locks them
 * with.
 *
 * The retry lives here rather than at the call site because this is the only
 * place that knows the arguments, the binary and which password was already
 * tried - and because `archiveOrDirectory` and everything downstream of it
 * would otherwise each need their own copy of the same two lines. A caller gets
 * one extraction that either works or explains itself.
 *
 * Both locked shapes reach this: an archive whose FILES are encrypted (7-Zip
 * names the wrong password) and one whose HEADERS are encrypted, `-mhe=on`,
 * which MixMods does ship - there 7-Zip cannot read the file list at all and
 * reports a headers error, which reads exactly like a damaged download. Telling
 * someone to re-download a file that is merely locked sends them round a loop
 * that cannot end, so the refusal below names the password and never damage.
 */
export async function extractArchive(archive: string, dest: string, opts: ExtractOptions = {}): Promise<string> {
  await fsp.mkdir(dest, { recursive: true })
  const supplied = opts.password ?? ''
  try {
    await extractOnce(archive, dest, supplied, opts)
    return dest
  } catch (e) {
    if (!(e instanceof ArchiveError) || e.failure === 'cancelled') throw e
    if (e.failure === 'rar-unsupported') {
      throw new ArchiveError(
        t('messages.install.archiveRarUnsupported', { file: path.basename(archive) }),
        e.failure,
        e.output
      )
    }
    if (!shouldRetryWithPassword(e.failure, supplied)) throw e

    try {
      await extractOnce(archive, dest, MIXMODS_PASSWORD, opts)
      return dest
    } catch (retry) {
      if (!(retry instanceof ArchiveError) || retry.failure === 'cancelled') throw retry
      // A retry that fails for some OTHER reason is that other reason. Only a
      // second password refusal proves the password is the thing missing.
      if (!shouldRetryWithPassword(retry.failure)) throw retry
      throw new ArchiveError(
        t('messages.install.archivePasswordProtected', {
          file: path.basename(archive),
          password: MIXMODS_PASSWORD
        }),
        retry.failure,
        retry.output
      )
    }
  }
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

/**
 * Extensions worth handing to 7-Zip. `.rar` stays on the list even though the
 * bundled binary has no RAR decoder: dropping it would make a downloaded .rar
 * "neither an archive nor an existing folder", and being told the file is not
 * an archive is a worse answer than being told which archives Modão can open.
 */
export function isArchiveFile(file: string): boolean {
  return /\.(7z|zip|rar)$/i.test(file)
}

export async function archiveOrDirectory(input: string, dest: string, opts: ExtractOptions = {}): Promise<string> {
  if (isArchiveFile(input)) return extractArchive(input, dest, opts)
  if (exists(input)) return input
  throw new ArchiveError(`${input} is neither an archive nor an existing folder`)
}
