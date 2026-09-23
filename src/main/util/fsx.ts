import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface WalkedFile {
  /** Absolute path. */
  abs: string
  /** Path relative to the walk root, with forward slashes. */
  rel: string
  size: number
  mtimeMs: number
}

/**
 * Walks a tree, following directory junctions - a materialised profile is made
 * of them, so a walk that skipped them would report a mod folder as empty.
 * The chain of resolved ancestor paths is tracked so a junction loop cannot
 * spin forever.
 *
 * The guard is the ANCESTOR chain, deliberately not a global log of every
 * realpath ever visited. Two different junctions resolving to the same target
 * is normal here - `storeKey()` is slug+version+variant, so two installs of the
 * same mod share one store folder - and both are genuinely live at their own
 * path in the game tree. A global set would enter the first and silently return
 * on the second, hiding a file that really is present at a second location.
 * Only a directory that is its own ancestor means the walk is looping.
 */
export async function walk(root: string, opts: { maxFiles?: number } = {}): Promise<WalkedFile[]> {
  const out: WalkedFile[] = []
  const max = opts.maxFiles ?? Number.MAX_SAFE_INTEGER

  async function rec(dir: string, prefix: string, ancestors: readonly string[]): Promise<void> {
    const real = (await fsp.realpath(dir).catch(() => dir)).toLowerCase()
    if (ancestors.includes(real)) return
    const chain = [...ancestors, real]

    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= max) return
      const abs = path.join(dir, e.name)
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      let isDir = e.isDirectory()
      let isFile = e.isFile()
      if (e.isSymbolicLink()) {
        const st = await fsp.stat(abs).catch(() => null)
        isDir = !!st?.isDirectory()
        isFile = !!st?.isFile()
      }
      if (isDir) {
        await rec(abs, rel, chain)
      } else if (isFile) {
        const st = await fsp.stat(abs).catch(() => null)
        if (st) out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs })
      }
    }
  }

  await rec(root, '', [])
  return out
}

export async function sha256File(file: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256')
    const s = fs.createReadStream(file)
    s.on('error', reject)
    s.on('data', (d) => h.update(d))
    s.on('end', () => resolve(h.digest('hex')))
  })
}

export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

export async function dirSize(dir: string): Promise<number> {
  const files = await walk(dir)
  return files.reduce((a, f) => a + f.size, 0)
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

export function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** True when the path is a junction / symlink rather than a real directory. */
export function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

export function volumeOf(p: string): string {
  const root = path.parse(path.resolve(p)).root
  return root.toUpperCase()
}

export function sameVolume(a: string, b: string): boolean {
  return volumeOf(a) === volumeOf(b)
}

/** Directory junction via mklink /J. Works across volumes; no admin rights needed. */
export async function createJunction(link: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(link), { recursive: true })
  await removeLinkOrDir(link)
  try {
    await fsp.symlink(target, link, 'junction')
  } catch {
    await execFileAsync('cmd.exe', ['/c', 'mklink', '/J', link, target], { windowsHide: true })
  }
}

export async function createHardlink(link: string, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(link), { recursive: true })
  if (exists(link)) await fsp.rm(link, { force: true })
  await fsp.link(target, link)
}

/** Hardlink when possible, copy when the volumes differ. */
export async function linkOrCopyFile(target: string, link: string): Promise<'hardlink' | 'copy'> {
  await fsp.mkdir(path.dirname(link), { recursive: true })
  if (exists(link)) await fsp.rm(link, { force: true })
  if (sameVolume(target, link)) {
    try {
      await fsp.link(target, link)
      return 'hardlink'
    } catch {
      /* fall through to copy */
    }
  }
  await fsp.copyFile(target, link)
  return 'copy'
}

/** Removes a junction without following it into the target. */
export async function removeLinkOrDir(p: string): Promise<void> {
  if (!exists(p) && !isLink(p)) return
  const st = await fsp.lstat(p)
  if (st.isSymbolicLink()) {
    await fsp.unlink(p).catch(async () => {
      await fsp.rmdir(p).catch(() => undefined)
    })
    return
  }
  if (st.isDirectory()) {
    await fsp.rm(p, { recursive: true, force: true })
    return
  }
  await fsp.rm(p, { force: true })
}

/** Moves a path, falling back to copy+delete across volumes. Never destroys the source on failure. */
export async function moveSafe(from: string, to: string): Promise<void> {
  await fsp.mkdir(path.dirname(to), { recursive: true })
  try {
    await fsp.rename(from, to)
    return
  } catch {
    await copyRecursive(from, to)
    await fsp.rm(from, { recursive: true, force: true })
  }
}

export async function copyRecursive(from: string, to: string): Promise<void> {
  const st = await fsp.stat(from)
  if (st.isDirectory()) {
    await fsp.mkdir(to, { recursive: true })
    for (const e of await fsp.readdir(from, { withFileTypes: true })) {
      await copyRecursive(path.join(from, e.name), path.join(to, e.name))
    }
  } else {
    await fsp.mkdir(path.dirname(to), { recursive: true })
    await fsp.copyFile(from, to)
  }
}

/**
 * A second reference to the same bytes, for when one copy has to be reachable
 * from two places at once - a displaced file is both the backup that will be
 * put back and the quarantine entry the user can see. Hardlinks inside one
 * volume, so mirroring a multi-gigabyte mod folder costs nothing; falls back to
 * a real copy across volumes.
 */
export async function mirrorRecursive(from: string, to: string): Promise<void> {
  const st = await fsp.stat(from)
  if (st.isDirectory()) {
    await fsp.mkdir(to, { recursive: true })
    for (const e of await fsp.readdir(from, { withFileTypes: true })) {
      await mirrorRecursive(path.join(from, e.name), path.join(to, e.name))
    }
    return
  }
  await linkOrCopyFile(from, to)
}

export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

export function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()
}

export function timestampSlug(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

export async function readFileChunk(file: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fsp.open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}
