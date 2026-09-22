import path from 'node:path'
import fsp from 'node:fs/promises'
import iconv from 'iconv-lite'
import type { LogEntry } from '@shared/types'
import { activeGame } from '../game/detect'
import { exists, walk } from '../util/fsx'

const KNOWN_LOGS = ['modloader/modloader.log', 'modloader.log', 'VehFuncs.log', 'cleo/cleo.log', 'SilentPatchSA.log', 'crashinfo.log']

/**
 * Collects every log the game and its mods leave behind into one timeline.
 *
 * There is nothing per-profile to collect: the game writes these logs into the
 * game folder as it runs, and only one profile is materialised there at a time,
 * so the logs are always the active profile's. Taking a profileId would promise
 * a filter that cannot exist.
 */
export async function collectLogs(): Promise<LogEntry[]> {
  const game = activeGame()
  if (!game) return []
  const files = new Set<string>()
  for (const rel of KNOWN_LOGS) {
    const p = path.join(game.path, rel)
    if (exists(p)) files.add(p)
  }
  // Per-mod logs dropped anywhere in the game root or modloader folder.
  for (const dir of [game.path, path.join(game.path, 'modloader')]) {
    if (!exists(dir)) continue
    for (const f of await walk(dir, { maxFiles: 4000 })) {
      if (/\.log$/i.test(f.rel) && f.size < 8 * 1024 * 1024) files.add(f.abs)
    }
  }

  const entries: LogEntry[] = []
  for (const file of files) {
    const buf = await fsp.readFile(file).catch(() => null)
    if (!buf) continue
    const text = iconv.decode(buf, 'win1252')
    const source = path.relative(game.path, file).replace(/\\/g, '/')
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (!line.trim()) continue
      entries.push({
        timestamp: parseTimestamp(line),
        source,
        level: /\b(error|erro|fail|falha|exception|crash)\b/i.test(line)
          ? 'error'
          : /\b(warn|aviso|deprecated)\b/i.test(line)
            ? 'warn'
            : 'info',
        message: line.slice(0, 500)
      })
    }
  }

  return entries
    .sort((a, b) => {
      if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp)
      if (a.timestamp) return -1
      if (b.timestamp) return 1
      return a.source.localeCompare(b.source)
    })
    .slice(-3000)
}

function parseTimestamp(line: string): string | null {
  const m =
    /\[(\d{2}:\d{2}:\d{2})\]/.exec(line) ??
    /(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/.exec(line) ??
    /(\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2})/.exec(line)
  return m ? m[1] : null
}
