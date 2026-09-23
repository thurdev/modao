import path from 'node:path'
import fs from 'node:fs'
import { app } from 'electron'
import { getDb } from './db'
import { Paths } from './util/paths'
import { loadSeedCatalog, listCatalog } from './catalog/service'
import { createProfile, listProfiles } from './profiles/manager'
import { resolveDependencies } from './deps/resolver'
import { addressFromOffset, lookup } from './diagnostics/crashlist'
import { listConflicts, providesKey } from './conflicts'
import type { GameInstall } from '@shared/types'

/**
 * Headless self-check, run with MODAO_SMOKE=1. Exercises the database,
 * migrations, seed catalog, dependency graph and crash lookup without a UI.
 */
export async function runSmoke(): Promise<number> {
  let failures = 0
  const check = (name: string, ok: boolean, extra?: unknown): void => {
    if (ok) console.log(`  PASS  ${name}`)
    else {
      failures++
      console.log(`  FAIL  ${name}`, extra ?? '')
    }
  }

  const db = getDb()
  const migrations = db.prepare('SELECT COUNT(*) c FROM schema_migration').get() as { c: number }
  check('migrations applied', migrations.c >= 2, migrations)
  check('provides index exists', !!db.prepare("SELECT name FROM sqlite_master WHERE name='idx_provides_path'").get())

  const seeded = await loadSeedCatalog(true)
  check('seed catalog loaded', seeded > 10, seeded)

  const catalog = listCatalog({ sort: 'rating' })
  check('catalog ranks by synthesised score', catalog.mods.length > 0 && catalog.mods[0].rating >= catalog.mods[catalog.mods.length - 1].rating)
  check(
    'rating inputs are exposed, not just a score',
    catalog.mods.every((m) => typeof m.ratingInputs.recency === 'number' && typeof m.ratingInputs.inEssentials === 'boolean')
  )
  check(
    'every catalogue entry links back to its author page',
    catalog.mods.every((m) => m.sourceUrl.startsWith('https://www.mixmods.com.br/')),
    catalog.mods.find((m) => !m.sourceUrl.startsWith('https://www.mixmods.com.br/'))?.slug
  )
  // The bundled catalogue is a way to find someone else's work, not a copy of
  // it: a summary and a link ship with the app, and the author's post is read
  // from MixMods when the user opens the mod.
  check(
    'the bundled catalogue carries a summary, not the whole post',
    catalog.mods.every((m) => m.blocks.length === 0),
    `${catalog.mods.filter((m) => m.blocks.length > 0).length} entries still carry page blocks`
  )
  check(
    'every entry still has something to read and a link to the original',
    catalog.mods.every((m) => m.description.trim().length > 0 && m.sourceUrl.length > 0),
    catalog.mods.find((m) => !m.description.trim())?.slug
  )
  const paywalled = catalog.mods.filter((m) => m.paywalled)
  check('paywalled releases are flagged and never carry a direct download', paywalled.every((m) => m.versions.every((v) => !v.downloadUrl) || m.paywalled), paywalled.map((m) => m.slug))

  const profile = await createProfile({ name: `smoke ${Date.now()}` })
  check('profile created', profile.id > 0)
  check('profile listed', (await listProfiles()).some((p) => p.id === profile.id))

  const fakeGame: GameInstall = {
    id: -1,
    path: 'C:/nonexistent',
    label: 'smoke',
    kind: 'sa',
    gameName: 'GTA: San Andreas',
    supportsModLoader: true,
    supportsCleo: true,
    supportsAsi: true,
    pakDir: null,
    hasCrashList: true,
    exeSize: 14_383_616,
    exeSha256: '',
    exeTimestamp: 0x427101ca,
    isV1UsOriginal: true,
    largeAddressAware: false,
    asiDirectory: 'C:/nonexistent',
    asiLoader: 'C:/nonexistent/vorbisFile.dll',
    hasModLoader: true,
    modLoaderVersion: '0.3.7',
    cleoVersion: '4.3',
    userFilesDir: '',
    sameVolumeAsStore: true,
    linkStrategy: 'hardlink',
    access: { writable: true, probedPath: 'C:/nonexistent', code: null, reason: null, needsElevation: false }
  }

  const cleoPlusId = (db.prepare("SELECT id FROM mod WHERE slug = 'cleoplus'").get() as { id: number } | undefined)?.id ?? 0
  const cleoDeps = resolveDependencies({ modId: cleoPlusId, profileId: profile.id, game: fakeGame })
  check(
    'CLEO+ is version-gated against CLEO 4.3',
    cleoDeps.some((d) => d.resolution === 'blocking' && /ordinal 22/.test(d.note ?? '')),
    cleoDeps
  )
  const cleo44 = resolveDependencies({ modId: cleoPlusId, profileId: profile.id, game: { ...fakeGame, cleoVersion: '4.4.4' } })
  check('CLEO 4.4 satisfies CLEO+', cleo44.every((d) => d.resolution !== 'blocking'), cleo44)

  const fixesId = (db.prepare("SELECT id FROM mod WHERE slug = 'sa-proper-fixes'").get() as { id: number } | undefined)?.id ?? 0
  const fixDeps = resolveDependencies({ modId: fixesId, profileId: profile.id, game: fakeGame })
  check(
    'Proper Fixes models "Proper Shaders OR SkyGfx"',
    fixDeps.some((d) => d.kind === 'alt' && (d.alternatives?.length ?? 0) === 2),
    fixDeps
  )

  const shadersId = (db.prepare("SELECT id FROM mod WHERE slug = 'sa-proper-shaders'").get() as { id: number } | undefined)?.id ?? 0
  const shaderDeps = resolveDependencies({ modId: shadersId, profileId: profile.id, game: fakeGame })
  check(
    'Proper Shaders declares anti-dependencies on SkyGfx and Ped Spec',
    shaderDeps.filter((d) => d.kind === 'conflicts').length === 2,
    shaderDeps
  )

  // The seed file is the graph. A row that does not reach the table is a
  // relationship the app does not know about, and until now one of them never
  // did: `more-radar-icons requires cleoplus` was dropped at every startup
  // because its SUBJECT is not one of the 127 catalogue entries.
  const seedRows = (
    JSON.parse(fs.readFileSync(path.join(Paths.resources(), 'dependencies.json'), 'utf8')) as {
      dependencies: { mod: string; kind: string; target: string }[]
    }
  ).dependencies
  const storedEdges = new Set(
    (db.prepare('SELECT mod_slug, kind, requires_slug FROM dependency').all() as {
      mod_slug: string | null
      kind: string
      requires_slug: string | null
    }[]).map((r) => `${r.mod_slug}|${r.kind}|${r.requires_slug}`)
  )
  const lost = seedRows.filter((r) => !storedEdges.has(`${r.mod}|${r.kind}|${r.target}`))
  check('every seeded dependency edge reaches the table', lost.length === 0, lost)
  check(
    'the edge that used to be dropped is loaded: More Radar Icons requires CLEO+',
    storedEdges.has('more-radar-icons|requires|cleoplus')
  )

  const vehId = (db.prepare("SELECT id FROM mod WHERE slug = 'sa-vehfuncs'").get() as { id: number } | undefined)?.id ?? 0
  const vehDeps = resolveDependencies({ modId: vehId, profileId: profile.id, game: fakeGame })
  check(
    'VehFuncs PROVIDES gsx.asi - it is never reported as a missing dependency named after the file',
    vehDeps.some((d) => d.kind === 'provides' && d.slug === 'gsx.asi' && d.resolution === 'ok') &&
      !vehDeps.some((d) => d.slug === 'gsx.asi' && d.resolution === 'missing'),
    vehDeps
  )

  // The worked example from the brief.
  const address = addressFromOffset('0x00349b7b')
  check('fault offset 0x00349b7b maps to 0x00749B7B', address === '0x00749B7B', address)
  const match = await lookup(address)
  check('CrashList match found', !!match.cause && /modelo|txd/i.test(match.cause), match)
  // Not pinned to the bundled excerpt: this is an address the spec names, read
  // out of an "Erro:" stanza, so a refreshed CrashList still answers it.
  const pedLimit = await lookup('0x004c67bb')
  check('CrashList reads an Erro: stanza', /Limite de modelos de pedestres/i.test(pedLimit.cause ?? ''), pedLimit)

  check('provides key strips the mod folder', providesKey('modloader/Weapon Icons/models/hud.txd') === 'models/hud.txd')
  check('provides key keeps non-modloader paths', providesKey('cleo/radar.cs') === 'cleo/radar.cs')
  check('conflict query runs on an empty profile', listConflicts(profile.id).length === 0)

  check('store directory created under userData', fs.existsSync(Paths.storeMods()))
  check('quarantine directory created', fs.existsSync(Paths.quarantine()))
  check('seed resources resolved', fs.existsSync(path.join(Paths.resources(), 'CrashList.txt')))

  db.prepare('DELETE FROM profile WHERE id = ?').run(profile.id)

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
  console.log(`userData: ${app.getPath('userData')}`)
  return failures
}
