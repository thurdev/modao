/* Smoke tests for the parsers and the classifier. Run outside Electron. */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import iconv from 'iconv-lite'
import { analyzeTxdBuffer } from '../src/main/formats/txd'
import { analyzeImg } from '../src/main/formats/img'
import {
  parseIni,
  readPriorities,
  applyProfileToIni,
  stringifyIni,
  resolveWinner,
  decodeIni,
  encodeIni,
  looksLikeUtf8,
  unmappableInWin1252,
  applyIgnoreState,
  readIgnoreState
} from '../src/main/game/modloaderIni'
import {
  describeAbsoluteAddress,
  groupIncidents,
  normalizeAddress,
  parseModuleName,
  resolveCrashAddress
} from '../src/shared/crash'
import { collectAddresses, parseCrashList } from '../src/shared/crashlist'
import type { CrashReport } from '../src/shared/types'
import {
  canonicalDependencyName,
  decodeReadme,
  needsReadmeAcknowledgement,
  parseDeclaredDependencies,
  parseReadmeText,
  unparsedReadmeWarning
} from '../src/main/install/readme'
import { extractActivationCodes } from '../src/shared/activation'
import { classifyTree } from '../src/main/install/classify'
import { buildPersistedVariantGroups, configVariantParent, isAddonFolder } from '../src/shared/variantGroups'
import { displaceForeign, isOwned, ownedKey } from '../src/main/store/displace'
import {
  describeFsError,
  forgetWriteAccess,
  isProtectedLocation,
  probeWriteAccess,
  writeAccessUnlessGameRunning
} from '../src/main/game/access'
import { setMainLanguage } from '../src/main/util/i18n'
import { translate } from '../src/shared/i18n'
import { classifyDownload, looksLikeArchive, normalizeForFetch } from '../src/shared/download'
import { foldText, relevance } from '../src/shared/search'
import { requirementMet } from '../src/shared/requirements'
import { catalogKind } from '../src/shared/catalogKind'
import { parseCrashDump, parseModLoaderLog } from '../src/main/diagnostics/modloaderLog'
import { limitAdjusterNames, parseStreamIni, SAFE_STREAMING_MEMORY_MB } from '../src/main/game/streamIni'
import { identifyLimitAdjusters } from '../src/shared/limitAdjusters'
import { groupDuplicateAssets } from '../src/shared/duplicateAssets'
import { pluginEvidence } from '../src/main/formats/strings'
import { decodeMangledHex, extractMangledAddresses } from '../src/shared/mangled'
import { findHookCollisions } from '../src/shared/hookCollisions'
import { formatHexDump, vaToFileOffset } from '../src/shared/disasm'
import {
  assertGameNotRunning,
  checkGameRunning,
  forgetRunningProcesses,
  gameExeNames,
  gameRunningVerdict,
  rememberGameRunning,
  whenGameClosed,
  type RunningProcess
} from '../src/main/game/running'
import { signatureForArchive } from '../src/main/knowledge/signature'
import {
  bisectGate,
  compareAgainstUpstream,
  outdatedSignature,
  planBisectStart,
  resolveRepo,
  upstreamCheckVerdict,
  UPSTREAM_REGISTRY,
  type InstalledBinary,
  type OutdatedBuild,
  type ReleaseFetcher,
  type UpstreamRelease
} from '../src/shared/upstream'
import { createJunction, removeLinkOrDir, walk } from '../src/main/util/fsx'
import { scanRoots } from '../src/main/diagnostics/duplicateAssets'
import type { GameInstall, HealthCheck, HealthReport } from '../src/shared/types'
import {
  buildDependencyNodes,
  dependencyLaunchBlockers,
  planCuratedDependencies,
  type CuratedDependencySeed,
  type GraphDependencyRow
} from '../src/shared/dependencyGraph'
import { blockersFromReport, describeBlockers, launchGate, type LaunchBlocker } from '../src/shared/launchGate'
import {
  installFingerprint,
  launchDecision,
  reportIsReusable,
  reportKey,
  REPORT_MAX_AGE_MS
} from '../src/shared/prelaunch'
import { cleoPluginRequirements, cleoRequirementStatus } from '../src/shared/cleoPlugins'
import { satisfiesRange } from '../src/shared/versionRange'
import { gameRootPlacements } from '../src/shared/asiData'
import type { ReadmeParse } from '../src/shared/types'
import { findSplitModels, modelStem } from '../src/shared/splitModels'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) console.log(`  PASS  ${name}`)
  else {
    failures++
    console.log(`  FAIL  ${name}`, extra ?? '')
  }
}

// --- TXD -------------------------------------------------------------------
function chunk(type: number, version: number, body: Buffer): Buffer {
  const head = Buffer.alloc(12)
  head.writeUInt32LE(type, 0)
  head.writeUInt32LE(body.length, 4)
  head.writeUInt32LE(version, 8)
  return Buffer.concat([head, body])
}

function textureNative(name: string, w: number, h: number): Buffer {
  const struct = Buffer.alloc(88)
  struct.writeUInt32LE(9, 0) // platform d3d9
  struct.write(name, 8, 'latin1')
  struct.writeUInt32LE(0x31545844, 76) // DXT1
  struct.writeUInt16LE(w, 80)
  struct.writeUInt16LE(h, 82)
  struct.writeUInt8(32, 84)
  struct.writeUInt8(1, 85)
  return chunk(0x15, 0x1803ffff, chunk(0x01, 0x1803ffff, struct))
}

const txdBody = Buffer.concat([
  chunk(0x01, 0x1803ffff, (() => {
    const b = Buffer.alloc(4)
    b.writeUInt16LE(2, 0)
    return b
  })()),
  textureNative('hud_ok', 256, 256),
  textureNative('hud_bad', 300, 128)
])
const txd = chunk(0x16, 0x1803ffff, txdBody)
const txdAnalysis = analyzeTxdBuffer(txd, 'synthetic.txd')
check('txd: both textures parsed', txdAnalysis.textureCount === 2, txdAnalysis)
check('txd: names read at +8', txdAnalysis.textures.map((t) => t.name).join(',') === 'hud_ok,hud_bad', txdAnalysis.textures)
check('txd: dimensions read at +80', txdAnalysis.textures[1].width === 300 && txdAnalysis.textures[1].height === 128)
check('txd: non-power-of-two flagged', txdAnalysis.nonPowerOfTwo.length === 1 && txdAnalysis.nonPowerOfTwo[0].name === 'hud_bad')
check('txd: DXT1 compression decoded', txdAnalysis.textures[0].compression === 'DXT1')

// --- IMG -------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modao-test-'))
const imgPath = path.join(tmp, 'anim.img')
{
  const header = Buffer.alloc(8)
  header.write('VER2', 0, 'latin1')
  header.writeUInt32LE(2, 4)
  const e1 = Buffer.alloc(32)
  e1.writeUInt32LE(1, 0)
  e1.writeUInt16LE(3, 4)
  e1.writeUInt16LE(0, 6)
  e1.write('ped.ifp', 8, 'latin1')
  const e2 = Buffer.alloc(32)
  e2.writeUInt32LE(4, 0)
  e2.writeUInt16LE(2, 4)
  e2.writeUInt16LE(0, 6)
  e2.write('swim.ifp', 8, 'latin1')
  fs.writeFileSync(imgPath, Buffer.concat([header, e1, e2, Buffer.alloc(2048 * 8)]))
}
const img = await analyzeImg(imgPath)
check('img: VER2 header', img.version === 'VER2' && img.entryCount === 2)
check('img: names and sector maths', img.entries[1].name === 'swim.ifp' && img.entries[1].byteOffset === 4 * 2048 && img.entries[1].byteSize === 2 * 2048, img.entries)

// --- modloader.ini ----------------------------------------------------------
const iniText = [
  '; user comment kept',
  '[Config]',
  'IgnoreAllFiles=0',
  '',
  '[Profiles.Default.Priority]',
  'SkyGfx=70',
  'HD Peds=0'
].join('\r\n')
const ini = parseIni(iniText)
const prios = readPriorities(ini, 'Default')
check('ini: priorities parsed', prios['SkyGfx'] === 70 && prios['HD Peds'] === 0, prios)
applyProfileToIni(ini, 'Race', { SkyGfx: 80, VehFuncs: 55 })
const out = stringifyIni(ini)
check('ini: user comment preserved', out.includes('; user comment kept'))
check('ini: unrelated section preserved', out.includes('IgnoreAllFiles=0'))
check('ini: new profile block written', out.includes('[Profiles.Race.Priority]') && out.includes('SkyGfx=80'))
check('ini: Folder.Config Profile written', /\[Folder\.Config\][\s\S]*Profile=Race/.test(out), out)

const winner = resolveWinner([
  { priority: 50, folder: 'A mod', enabled: true },
  { priority: 70, folder: 'B mod', enabled: true },
  { priority: 90, folder: 'C mod', enabled: false },
  { priority: 0, folder: 'D mod', enabled: true }
])
check('priority: highest enabled non-zero wins', winner?.folder === 'B mod', winner)
check('priority: all-disabled means no winner', resolveWinner([{ priority: 60, folder: 'X', enabled: false }]) === null)

// --- modloader.ini encoding (regression: accented folder names) --------------
// Mod Loader reads this file as Windows-1252. Writing it as UTF-8 turns
// "Animações de Kung Fu melhoradas" into a name that matches no folder, and the
// priority line silently stops applying.
const accented = ['Animações de Kung Fu melhoradas', 'Tradução', 'ECG ParticleTXD (versão Normal)']
const accentedIni = parseIni('[Config]\r\nIgnoreAllFiles=0\r\n')
applyProfileToIni(accentedIni, 'Real install', { [accented[0]]: 70, [accented[1]]: 65, [accented[2]]: 50 })
const encoded = encodeIni(accentedIni)
check(
  'ini: accented names are encoded as cp1252, one byte per character',
  encoded.includes(Buffer.from([0xe7, 0xf5])) && !encoded.includes(Buffer.from([0xc3, 0xa7])),
  encoded.toString('latin1')
)
const decodedBack = readPriorities(parseIni(decodeIni(encoded)), 'Real install')
check(
  'ini: every accented name round-trips unchanged',
  accented.every((name) => name in decodedBack),
  Object.keys(decodedBack)
)
check('ini: accented priorities keep their values', decodedBack[accented[0]] === 70 && decodedBack[accented[1]] === 65, decodedBack)
check(
  'ini: a file an older build wrote as UTF-8 still reads correctly',
  decodeIni(Buffer.from('[Profiles.X.Priority]\r\nTradução=65\r\n', 'utf8')).includes('Tradução')
)
check('ini: a UTF-8 BOM is stripped rather than parsed as a key', !decodeIni(Buffer.from('﻿[Config]\r\n', 'utf8')).startsWith('﻿'))
check('ini: plain ASCII is not mistaken for UTF-8', !looksLikeUtf8(Buffer.from('Old Cars=60\r\n', 'latin1')))
check('ini: cp1252 bytes are not mistaken for UTF-8', !looksLikeUtf8(Buffer.from([0x54, 0x72, 0x61, 0x64, 0xe7, 0xe3, 0x6f])))
check('ini: characters cp1252 cannot carry are reported', unmappableInWin1252('Русский мод').length > 0)
check('ini: pt-BR accents are not reported as unmappable', unmappableInWin1252(accented.join(' ')).length === 0)

// --- priorities are the user's, and only for mods that are present ----------
const stale = parseIni(
  ['[Profiles.Race.Priority]', '; keep this comment', 'Beta Gang Members=50', 'SkyGfx=70', ''].join('\r\n')
)
applyProfileToIni(stale, 'Race', { SkyGfx: 70, VehFuncs: 65 })
const staleOut = stringifyIni(stale)
check('ini: a mod no longer in the profile loses its priority line', !/Beta Gang Members/.test(staleOut), staleOut)
check('ini: the mods that are present keep theirs', /SkyGfx=70/.test(staleOut) && /VehFuncs=65/.test(staleOut), staleOut)
check('ini: user comments inside the block survive the rewrite', /; keep this comment/.test(staleOut), staleOut)

const inherited = parseIni(
  ['[Priority]', 'Old Cars=55', '', '[Profiles.Default.Priority]', 'SkyGfx=70', 'HD Peds=65'].join('\r\n')
)
const forNewProfile = readPriorities(inherited, 'Real install', { inherit: true })
check(
  'ini: a profile with no block of its own inherits what the user already set',
  forNewProfile['SkyGfx'] === 70 && forNewProfile['HD Peds'] === 65 && forNewProfile['Old Cars'] === 55,
  forNewProfile
)

// --- crash addressing --------------------------------------------------------
// 0x400000 + offset is the crash address ONLY when the faulting module is the
// exe. For a DLL the offset is relative to that DLL, and looking the sum up in
// CrashList produces a confident wrong answer.
const exeCrash = resolveCrashAddress('gta_sa.exe', '0x000c0c63')
check('crash: an exe fault is image base plus offset', exeCrash.kind === 'exe' && exeCrash.display === '0x004C0C63', exeCrash)
check('crash: an exe fault is looked up', exeCrash.lookupAddress === '0x004C0C63', exeCrash)

const dllCrash = resolveCrashAddress('std.data.dll', '0x0001a2b0')
check('crash: a DLL fault is shown as module+offset', dllCrash.kind === 'module' && dllCrash.display === 'std.data.dll+0x0001A2B0', dllCrash)
check('crash: a DLL fault is never looked up in CrashList', dllCrash.lookupAddress === null, dllCrash)
check('crash: the UI is told why there is no lookup', !!dllCrash.note && /CrashList/.test(dllCrash.note), dllCrash.note)

// The literal VERIFY of spec item 05: feed it a std.data.dll_unloaded event and
// assert it does not add the image base. The "_unloaded" suffix must not make
// the module stop being a DLL.
const unloadedCrash = resolveCrashAddress('std.data.dll_unloaded', '0x0001a2b0')
check(
  'crash: an already-unloaded DLL fault does not get the image base',
  unloadedCrash.kind === 'module' && !/0x004[0-9A-F]{5}/.test(unloadedCrash.display),
  unloadedCrash
)
check(
  'crash: an already-unloaded DLL fault still renders as module+offset',
  unloadedCrash.display === 'std.data.dll+0x0001A2B0',
  unloadedCrash.display
)
check(
  'crash: an already-unloaded DLL fault is never looked up in CrashList',
  unloadedCrash.lookupAddress === null,
  unloadedCrash
)

check('crash: an unloaded module is recognised', parseModuleName('std.data.dll_unloaded').unloaded)
check('crash: its real name is kept', parseModuleName('std.data.dll_unloaded').name === 'std.data.dll')
check('crash: gta_sa.exe is recognised whatever the case', parseModuleName('GTA_SA.EXE').isExe)

function crash(id: number, module: string, offset: string, at: string, pid: string): CrashReport {
  const addressing = resolveCrashAddress(module, offset)
  return {
    id,
    profileId: null,
    occurredAt: at,
    faultOffset: offset,
    module: parseModuleName(module).name,
    moduleRaw: module,
    moduleUnloaded: parseModuleName(module).unloaded,
    processId: pid,
    exceptionCode: '0xc0000005',
    crashAddress: addressing.display,
    addressKind: addressing.kind,
    addressNote: addressing.note,
    matchedCause: null,
    matchedSolution: null,
    resolved: false,
    kind: 'exception',
    raw: ''
  }
}

const incidents = groupIncidents([
  crash(3, 'ntdll.dll_unloaded', '0x00001000', '2026-09-20T10:00:05.000Z', '0x2b10'),
  crash(2, 'std.data.dll', '0x0001a2b0', '2026-09-20T10:00:02.000Z', '0x2b10'),
  crash(1, 'gta_sa.exe', '0x000c0c63', '2026-09-20T09:00:00.000Z', '0x1a04')
])
check('crash: records from one dead process become one incident', incidents.length === 2, incidents.length)
const grouped = incidents.find((i) => i.processId === '0x2b10')!
check('crash: the incident carries the other records instead of listing them apart', grouped.related.length === 1, grouped.related.length)
check(
  'crash: an already-unloaded module is not taken as the cause',
  grouped.primary.module === 'std.data.dll',
  grouped.primary.module
)
check('crash: incidents are listed newest first', incidents[0].processId === '0x2b10', incidents.map((i) => i.processId))

// --- the image base is added once, at one site -------------------------------
// The field report saw one crash rendered as both 0x004C67BB and 0x008C67BB:
// 0x400000 added to an address that already had it. A source that reports an
// ABSOLUTE address - modloader.log's own crash handler - goes through
// describeAbsoluteAddress, which normalises and adds nothing.
const absolute = describeAbsoluteAddress('gta_sa.exe', '0x005B8E55')
check(
  'crash: an already-absolute address is not based a second time',
  absolute.kind === 'exe' && absolute.display === '0x005B8E55' && absolute.lookupAddress === '0x005B8E55',
  absolute
)
check(
  'crash: describing an absolute address twice changes nothing',
  describeAbsoluteAddress('gta_sa.exe', absolute.display).display === '0x005B8E55',
  describeAbsoluteAddress('gta_sa.exe', absolute.display)
)
check(
  'crash: an absolute address inside a DLL is still never looked up',
  describeAbsoluteAddress('std.data.dll', '0x0F2B1000').lookupAddress === null,
  describeAbsoluteAddress('std.data.dll', '0x0F2B1000')
)

// The spec's own VERIFY for item 06, run as a test: "search for every site that
// adds 0x400000 and confirm there is only one." String literals and prose are
// stripped first - the UI labels the arithmetic, it does not perform it.
function sourceFilesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFilesUnder(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}
const baseAdditions: string[] = []
for (const file of sourceFilesUnder('src')) {
  fs.readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, i) => {
      const code = line.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '')
      if (/(?:IMAGE_BASE|0x400000|4194304)\s*\+|\+\s*(?:IMAGE_BASE|0x400000|4194304)\b/.test(code)) {
        baseAdditions.push(`${file.replace(/\\/g, '/')}:${i + 1}`)
      }
    })
}
check(
  'crash: exactly one site in src/ adds the image base',
  baseAdditions.length === 1 && baseAdditions[0].startsWith('src/shared/crash.ts:'),
  baseAdditions
)

// --- CrashList ---------------------------------------------------------------
// The real CrashList is a pt-BR document in Windows-1252, written as
// "Erro:"/"Causa:" stanzas - not an ini. A parser anchored on hex at the start
// of the line matches none of it, which is why two addresses that ARE in the
// list came back as "não está no CrashList".
const bundledCrashList = parseCrashList(
  iconv.decode(fs.readFileSync(path.join('resources', 'seed', 'CrashList.txt')), 'win1252')
)
check(
  'CrashList: 0x004C67BB resolves to the pedestrian model limit entry',
  /Limite de modelos de pedestres no \.ide/.test(bundledCrashList.get('0x004C67BB')?.cause ?? ''),
  bundledCrashList.get('0x004C67BB')
)
check(
  'CrashList: 0x007F3825 resolves to the texture unload entry',
  /Descarregamento de uma textura/.test(bundledCrashList.get('0x007F3825')?.cause ?? ''),
  bundledCrashList.get('0x007F3825')
)
check(
  'CrashList: the one-liner entries of the bundled excerpt are still read',
  /modelo que nao existe/.test(bundledCrashList.get('0x00749B7B')?.cause ?? ''),
  bundledCrashList.get('0x00749B7B')
)
check(
  'CrashList: case, 0x prefix and zero padding are all the same key',
  ['4c67bb', '0X004C67BB', '004c67bb', '0x4C67BB'].every(
    (a) => bundledCrashList.get(normalizeAddress(a))?.address === '0x004C67BB'
  )
)

// A stanza indexes EVERY address it names, including runs joined by "Ou".
const multiLine = parseCrashList(
  [
    'Erro: 0x004C9691 0x00732924 0x00749B7B',
    'Causa: Três endereços, uma causa.',
    '',
    'Erro: 0x00564192 0x0053CB61 Ou 0x00801D58 0x005D9802 0x007F3851 0x00552A53',
    'Causa: Dois grupos separados por Ou.',
    'Solução: Continua sendo uma entrada só.',
    '',
    'Erro: 0x006A1000',
    'Ou 0x006A2000',
    'Causa: O Ou continuou na linha seguinte.'
  ].join('\r\n')
)
check(
  'CrashList: every address on a multi-address Erro: line is indexed',
  ['0x004C9691', '0x00732924', '0x00749B7B'].every((a) => multiLine.get(a)?.cause === 'Três endereços, uma causa.'),
  [...multiLine.keys()]
)
check(
  'CrashList: an Ou line indexes both runs against the one entry',
  ['0x00564192', '0x0053CB61', '0x00801D58', '0x005D9802', '0x007F3851', '0x00552A53'].every(
    (a) => multiLine.get(a)?.cause === 'Dois grupos separados por Ou.'
  ),
  [...multiLine.keys()]
)
check(
  'CrashList: the entry keeps its solution across every address it names',
  multiLine.get('0x00552A53')?.solution === 'Continua sendo uma entrada só.',
  multiLine.get('0x00552A53')
)
check(
  'CrashList: an Ou continued onto its own line still belongs to the entry',
  multiLine.get('0x006A1000')?.cause === 'O Ou continuou na linha seguinte.' &&
    multiLine.get('0x006A2000')?.cause === 'O Ou continuou na linha seguinte.',
  [multiLine.get('0x006A1000'), multiLine.get('0x006A2000')]
)
check(
  'CrashList: a pt-BR word spelled in hex digits is not read as an address',
  collectAddresses('Causa: a textura dedada do veiculo').length === 0,
  collectAddresses('Causa: a textura dedada do veiculo')
)

// --- readme ------------------------------------------------------------------
const readmePt = iconv.encode(
  [
    'Mod de teste - instalação',
    '',
    'Extraia a pasta "Weapon Icons" para a pasta do ModLoader.',
    'Requer: https://www.mixmods.com.br/2015/01/mod-loader/',
    'A versão 2K é recomendada para 1920x1080.'
  ].join('\r\n'),
  'win1252'
)
const decoded = decodeReadme(readmePt)
check('readme: cp1252 decoded, no mojibake', decoded.text.includes('instalação') && decoded.encoding === 'windows-1252', decoded.encoding)
const parsedReadme = parseReadmeText('Leiame (ou morra).txt', decoded.text, decoded.encoding)
check('readme: instruction recognised', parsedReadme.instructions[0]?.destination === 'modloader-folder', parsedReadme.instructions)
check('readme: folder extracted', parsedReadme.instructions[0]?.folder === 'Weapon Icons', parsedReadme.instructions)
check('readme: requirement URL captured', parsedReadme.requirementUrls.length === 1, parsedReadme.requirementUrls)
check('readme: language detected', parsedReadme.language === 'pt-BR')

const readmeEn = 'Extract the folder "Cool Cars" to the modloader folder.'
const parsedEn = parseReadmeText('Readme (or die).txt', readmeEn, 'ascii')
check('readme: english instruction recognised', parsedEn.instructions[0]?.folder === 'Cool Cars', parsedEn.instructions)

// --- classifier ---------------------------------------------------------------
const archive = path.join(tmp, 'archive')
function write(rel: string, content = 'x'): void {
  const p = path.join(archive, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
write('Loadscreens 2K Definitive/models/LOADSCS.txd')
write('Loadscreens 4K Definitive/models/LOADSCS.txd')
write('CLEO+.cleo')
write('scripts/gsx.asi')
write('cleo/radar.cs')
write('Leiame (ou morra).txt', 'Extraia a pasta "Loadscreens" para a pasta do ModLoader.')

const ctx = { asiRelative: 'scripts', readmes: [parsedReadme], fallbackName: 'Loadscreens Definitive' }
const unresolved = await classifyTree(archive, ctx, {})
check('classify: variant group detected', unresolved.variants.length === 1 && unresolved.variants[0].options.length === 2, unresolved.variants)
check(
  'classify: unresolved variant warns and installs neither',
  unresolved.warnings.some((w) => w.code === 'variant-unresolved') &&
    !unresolved.files.some((f) => f.targetRelative.includes('LOADSCS')),
  unresolved.files.map((f) => f.targetRelative)
)

const chosenId = unresolved.variants[0].options.find((o) => o.label.includes('2K'))!.id
const resolved = await classifyTree(archive, ctx, { [unresolved.variants[0].id]: chosenId })
const targets = resolved.files.map((f) => `${f.destination}:${f.targetRelative}`)
check('classify: chosen variant becomes the mod folder', targets.some((t) => t === 'modloader-folder:modloader/Loadscreens 2K Definitive/models/LOADSCS.txd'), targets)
check('classify: unchosen variant excluded', !targets.some((t) => t.includes('4K')), targets)
check('classify: .cleo goes to cleo/', targets.includes('cleo-plugin:cleo/CLEO+.cleo'), targets)
check('classify: .cs goes to cleo/', targets.includes('cleo-script:cleo/radar.cs'), targets)
check('classify: .asi honours the detected ASI directory', targets.includes('asi-plugin:scripts/gsx.asi'), targets)
check('classify: readme is documentation, not an installed file', !targets.some((t) => t.includes('Leiame')), targets)

const ctxRoot = { asiRelative: '', readmes: [], fallbackName: 'Some Mod' }
const rootMod = path.join(tmp, 'rootmod')
fs.mkdirSync(path.join(rootMod, 'models'), { recursive: true })
fs.writeFileSync(path.join(rootMod, 'models', 'player.dff'), 'x')
fs.writeFileSync(path.join(rootMod, 'readme.txt'), 'hi')
const rootResult = await classifyTree(rootMod, ctxRoot, {})
check(
  'classify: bare mod folder wraps into modloader/<name>',
  rootResult.files.some((f) => f.targetRelative === 'modloader/Some Mod/models/player.dff'),
  rootResult.files.map((f) => f.targetRelative)
)

const asiRoot = path.join(tmp, 'asiroot')
fs.mkdirSync(asiRoot, { recursive: true })
fs.writeFileSync(path.join(asiRoot, 'SilentPatchSA.asi'), 'x')
fs.writeFileSync(path.join(asiRoot, 'SilentPatchSA.ini'), 'x')
const asiResult = await classifyTree(asiRoot, ctxRoot, {})
check(
  'classify: root-loading install puts .asi in the game root',
  asiResult.files.some((f) => f.destination === 'asi-plugin' && f.targetRelative === 'SilentPatchSA.asi') &&
    asiResult.files.some((f) => f.destination === 'root-file' && f.targetRelative === 'SilentPatchSA.ini'),
  asiResult.files.map((f) => `${f.destination}:${f.targetRelative}`)
)

// --- permission errors -------------------------------------------------------
// The exact shape Windows produced on a repack installed under Program Files.
const epermPath = String.raw`C:\Program Files (x86)\Rockstar Games\GTA San Andreas\modloader\Beta Vinewood Sign Vegetation\readme.txt`
const eperm = Object.assign(new Error(`EPERM: operation not permitted, unlink '${epermPath}'`), {
  code: 'EPERM',
  path: epermPath
})
const epermText = describeFsError(eperm)
check('access: Program Files is recognised as protected', isProtectedLocation(epermPath))
// The default language is pt-BR, so this is what a Brazilian user actually reads.
check(
  'access: EPERM names the path and the fix, not the syscall',
  epermText.includes('administrador') && epermText.includes('Program Files') && epermText.includes(epermPath),
  epermText
)
check('access: the original errno is kept for bug reports', epermText.includes('EPERM'), epermText)
const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY', path: String.raw`D:\Games\GTA\gta_sa.exe` })
check('access: EBUSY tells the user to close the game', describeFsError(busy).includes('feche o GTA'), describeFsError(busy))

setMainLanguage('en')
check(
  'access: the same error reads in English once the language is switched',
  describeFsError(busy).includes('close the game'),
  describeFsError(busy)
)
check(
  'i18n: an English key that has no translation falls back to Portuguese',
  translate('en', 'profiles.dryRunHint').length > 0 && translate('en', 'app.done') === 'Done'
)
check('i18n: a missing key never shows the user a raw path', translate('pt-BR', 'nope.not.here') === 'here')
check(
  'i18n: placeholders are filled and plurals pick a form',
  translate('pt-BR', 'library.untrackedTitle', { count: 1, profile: 'Meu perfil' }).includes('não é rastreado') &&
    translate('pt-BR', 'library.untrackedTitle', { count: 4, profile: 'Meu perfil' }).includes('não são rastreados')
)
setMainLanguage('pt-BR')
check('access: a folder outside Program Files is not flagged', !isProtectedLocation(String.raw`D:\Games\GTA San Andreas`))

// --- mod layout, from the three installs that came out inert -----------------
// Every case here is a real archive that Modão previously laid out wrongly, and
// the failure was always the same shape: Mod Loader loaded nothing and said so
// in modloader.log while the app reported success.

const layout = path.join(tmp, 'layout')
function lay(rel: string, content = 'x'): void {
  const p = path.join(layout, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

// 1. GTA V HUD: the plugin and its resources shipped side by side. Lifting
//    VHud.asi into scripts\ left ~250 files with "No handler or callme".
lay('VHud.asi', 'plugin')
lay('VHud/blips/radar_ammu.png')
lay('VHud/map/map.txd')
lay('VHud/data/hud.dat')
lay('VHud/fonts/font.txd')
// 2. Proper Shaders: nine quality presets, each holding the same file.
for (const preset of ['(0a- lowest)', '(1 - low)', '(3 - high DEFAULT)', '(5 - very high)']) {
  lay(`Proper Shaders/${preset}/ProperShaders.ini`, preset)
}
// 3. An add-on that only means something merged into the mod it belongs to.
lay('Extra/GTA UG/VHud/data/hud.dat', 'override')
// 4. A bare loader, which genuinely does belong in the ASI directory.
lay('SilentPatchSA.asi', 'loader')

const layoutCtx = { asiRelative: 'scripts', readmes: [], fallbackName: 'GTA V HUD' }
const laidOut = await classifyTree(layout, layoutCtx, {})
const target = (needle: string): string | undefined =>
  laidOut.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative

check(
  'layout: an .asi that owns resources goes into the mod folder, not scripts\\',
  target('VHud.asi') === 'modloader/VHud/VHud.asi',
  target('VHud.asi')
)
check(
  'layout: its resources land beside it, under the same mod folder',
  target('VHud/blips/radar_ammu.png') === 'modloader/VHud/blips/radar_ammu.png' &&
    target('VHud/data/hud.dat') === 'modloader/VHud/data/hud.dat',
  laidOut.files.map((f) => f.targetRelative)
)
check(
  'layout: the install says why the plugin was kept with its files',
  laidOut.warnings.some((w) => w.code === 'asi-bundle'),
  laidOut.warnings.map((w) => w.code)
)
check(
  'layout: a bare loader still goes to the ASI directory',
  target('SilentPatchSA.asi') === 'scripts/SilentPatchSA.asi',
  target('SilentPatchSA.asi')
)

const presetGroup = laidOut.variants.find((v) => v.options.some((o) => o.label.includes('very high')))
check('layout: quality presets are detected as one exclusive group', !!presetGroup, laidOut.variants.map((v) => v.id))
check(
  'layout: every preset is an option in it',
  presetGroup?.options.length === 4,
  presetGroup?.options.map((o) => o.label)
)
check(
  'layout: the preset the author marked DEFAULT is preselected',
  presetGroup?.options.find((o) => o.label.includes('DEFAULT'))?.recommended === true,
  presetGroup?.options.map((o) => `${o.label}:${o.recommended}`)
)
check(
  'layout: with no preset chosen, not one of them is installed',
  !laidOut.files.some((f) => f.targetRelative.toLowerCase().includes('propershaders.ini')),
  laidOut.files.filter((f) => f.targetRelative.includes('roper')).map((f) => f.targetRelative)
)
const onePreset = await classifyTree(layout, layoutCtx, { [presetGroup!.id]: presetGroup!.options[3].id })
check(
  'layout: choosing one installs exactly one copy of the shared file',
  onePreset.files.filter((f) => f.targetRelative.toLowerCase().endsWith('propershaders.ini')).length === 1,
  onePreset.files.filter((f) => f.targetRelative.toLowerCase().endsWith('propershaders.ini')).map((f) => f.targetRelative)
)

check(
  'layout: an Extra/ folder is not installed as a mod of its own',
  !laidOut.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/extra')),
  laidOut.files.map((f) => f.targetRelative).filter((t) => t.toLowerCase().includes('extra'))
)
check(
  'layout: and the user is told what happened to it',
  laidOut.warnings.some((w) => w.code === 'addon-folder'),
  laidOut.warnings.map((w) => w.code)
)

// The archive that ships the game's own layout must not defeat rule 1 either.
const split = path.join(tmp, 'split')
function spl(rel: string): void {
  const p = path.join(split, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
}
spl('scripts/VHud.asi')
spl('modloader/VHud/data/hud.dat')
const splitOut = await classifyTree(split, { asiRelative: 'scripts', readmes: [], fallbackName: 'VHud' }, {})
check(
  'layout: an archive shipping scripts\\ and modloader\\ separately still gets a working install',
  splitOut.files.some((f) => f.targetRelative === 'modloader/VHud/VHud.asi') ||
    splitOut.warnings.some((w) => w.code === 'asi-split'),
  splitOut.files.map((f) => f.targetRelative)
)

// --- field audit item 09: nine mutually exclusive presets, all installed ----
// The real archive: nine quality presets, each holding its own ProperShaders.ini.
// Mod Loader logged "No handler or callme for file ProperShaders.ini" nine times
// because every one of them was installed at once.
const shadersDir = path.join(tmp, 'proper-shaders')
function sh(rel: string, content = 'x'): void {
  const p = path.join(shadersDir, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
const presetNames = [
  '(0a- only improvements + postfx)',
  '(0b- only improvements)',
  '(1a- very low)',
  '(1b- very low - no shadows)',
  '(2- low)',
  '(3a- medium - DEFAULT)',
  '(3b- medium-high)',
  '(4- high)',
  '(5 - very high)'
]
for (const preset of presetNames) sh(`Proper Shaders/${preset}/ProperShaders.ini`, preset)
const shadersOut = await classifyTree(shadersDir, { asiRelative: 'scripts', readmes: [], fallbackName: 'Proper Shaders' }, {})
const shaderGroup = shadersOut.variants.find((v) => v.options.length === presetNames.length)
check('field audit 09: all nine presets are one exclusive group', !!shaderGroup, shadersOut.variants.map((v) => v.options.length))
check(
  'field audit 09: the author-marked DEFAULT preset is preselected',
  shaderGroup?.options.find((o) => o.label.includes('DEFAULT'))?.recommended === true,
  shaderGroup?.options.map((o) => `${o.label}:${o.recommended}`)
)
const chosenPreset = shaderGroup!.options.find((o) => o.label.includes('DEFAULT'))!
const shadersChosen = await classifyTree(
  shadersDir,
  { asiRelative: 'scripts', readmes: [], fallbackName: 'Proper Shaders' },
  { [shaderGroup!.id]: chosenPreset.id }
)
check(
  'field audit 09: choosing one preset installs exactly one ProperShaders.ini',
  shadersChosen.files.filter((f) => f.targetRelative.toLowerCase().endsWith('propershaders.ini')).length === 1,
  shadersChosen.files.map((f) => f.targetRelative)
)
// The other eight are never lost: every option is still on record, ready to be
// snapshotted into the store and switched to later without touching the archive.
const persisted = buildPersistedVariantGroups(
  shadersOut.variants,
  { [shaderGroup!.id]: chosenPreset.id },
  shadersChosen.files.map((f) => ({ sourcePath: f.sourcePath, targetRelative: f.targetRelative }))
)
check(
  'field audit 09: all nine presets remain recorded and switchable, not just the chosen one',
  persisted.find((g) => g.id === shaderGroup!.id)?.options.length === presetNames.length,
  persisted.find((g) => g.id === shaderGroup!.id)?.options.map((o) => o.id)
)
check(
  'field audit 09: the persisted record names which preset is active',
  persisted.find((g) => g.id === shaderGroup!.id)?.chosenOptionId === chosenPreset.id
)

// --- field audit item 10: "(alt - blue paint)" must not become a top-level mod
const altCase = path.join(tmp, 'alt-case')
function altw(rel: string): void {
  const p = path.join(altCase, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
}
altw('Cool Cars/models/a.dff')
altw('(alt - blue paint)/models/a.dff')
const altOut = await classifyTree(altCase, { asiRelative: 'scripts', readmes: [], fallbackName: 'Cool Cars' }, {})
check(
  'field audit 10: "(alt - blue paint)" never becomes a top-level modloader\\ entry',
  !altOut.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/(alt')),
  altOut.files.map((f) => f.targetRelative)
)
check('field audit 10: isAddonFolder now matches a qualified alt folder', isAddonFolder('(alt - blue paint)'))
check(
  'field audit 10: it is offered back as an add-on rather than silently dropped',
  altOut.addOns.some((a) => a.label === '(alt - blue paint)'),
  altOut.addOns
)
const altEnabled = await classifyTree(
  altCase,
  { asiRelative: 'scripts', readmes: [], fallbackName: 'Cool Cars' },
  {},
  { '(alt - blue paint)': true }
)
check(
  'field audit 10: enabling the add-on merges it into the mod it overrides',
  altEnabled.files.some(
    (f) => f.targetRelative === 'modloader/Cool Cars/models/a.dff' && f.sourcePath === '(alt - blue paint)/models/a.dff'
  ),
  altEnabled.files.map((f) => `${f.sourcePath} -> ${f.targetRelative}`)
)
check(
  'field audit 10: enabled or not, it is never a top-level modloader\\ entry of its own',
  !altEnabled.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/(alt')),
  altEnabled.files.map((f) => f.targetRelative)
)
check(
  'field audit 10: the file it overrides is replaced, not installed twice',
  altEnabled.files.filter((f) => f.targetRelative === 'modloader/Cool Cars/models/a.dff').length === 1,
  altEnabled.files.map((f) => f.targetRelative)
)
check(
  'field audit 10: and the install says which files the add-on replaced',
  altEnabled.warnings.some((w) => w.code === 'addon-enabled' && w.message.includes('Cool Cars')),
  altEnabled.warnings.map((w) => `${w.code}: ${w.message}`)
)

// The field report's own shape: "Extra\GTA UG\VHud\data" repeats the mod's
// folder name inside itself, so enabling it must land on VHud's own data\,
// not at modloader\Extra\ nor at modloader\VHud\GTA UG\VHud\data\.
const extraCase = path.join(tmp, 'extra-case')
function ex(rel: string, content = 'x'): void {
  const p = path.join(extraCase, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
ex('VHud/data/hud.dat', 'stock')
ex('VHud/map/map.txd')
ex('Extra/GTA UG/VHud/data/hud.dat', 'override')
const extraEnabled = await classifyTree(
  extraCase,
  { asiRelative: 'scripts', readmes: [], fallbackName: 'GTA V HUD' },
  {},
  { Extra: true }
)
check(
  'field audit 10: "Extra\\GTA UG\\VHud\\data" lands on VHud\'s own data folder',
  extraEnabled.files.some(
    (f) => f.targetRelative === 'modloader/VHud/data/hud.dat' && f.sourcePath === 'Extra/GTA UG/VHud/data/hud.dat'
  ),
  extraEnabled.files.map((f) => `${f.sourcePath} -> ${f.targetRelative}`)
)
check(
  'field audit 10: and nothing of it reaches modloader\\Extra',
  !extraEnabled.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/extra')),
  extraEnabled.files.map((f) => f.targetRelative)
)

// --- field audit item 09b: "(configurações)" attaches to Zone Text ----------
const zoneText = path.join(tmp, 'zone-text')
function zt(rel: string, content = 'x'): void {
  const p = path.join(zoneText, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
zt('Zone Text/cleo/zonetext.cs')
zt('Zone Text/cleo/zonetext.ini', 'original')
zt('(configurações)/(minimalista)/zonetext.ini', 'minimalista')
zt('(configurações)/(padrão)/zonetext.ini', 'padrão')
const zoneOut = await classifyTree(zoneText, { asiRelative: 'scripts', readmes: [], fallbackName: 'Zone Text' }, {})
const zoneGroup = zoneOut.variants.find((v) => v.parentPath === '(configurações)')
check('field audit 09b: the config folder is detected as a variant group', !!zoneGroup, zoneOut.variants)
check(
  'field audit 09b: it is attached to Zone Text, not left standalone',
  zoneGroup?.attachedToPath === 'Zone Text',
  zoneGroup?.attachedToPath
)
const zoneChosen = await classifyTree(
  zoneText,
  { asiRelative: 'scripts', readmes: [], fallbackName: 'Zone Text' },
  { [zoneGroup!.id]: '(configurações)/(minimalista)' }
)
check(
  'field audit 09b: "(configurações)" never becomes a top-level modloader\\ entry',
  !zoneChosen.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/(')),
  zoneChosen.files.map((f) => f.targetRelative)
)
check(
  'field audit 09b: the chosen config lands inside Zone Text\'s own folder',
  zoneChosen.files.some((f) => f.targetRelative.toLowerCase() === 'modloader/zone text/zonetext.ini'),
  zoneChosen.files.map((f) => f.targetRelative)
)
check(
  'configVariantParent: a plain (parenthesised) folder sharing a config filename with a sibling names that sibling',
  configVariantParent(
    { name: '(x)', rel: '(x)', isDir: true, fileCount: 1, size: 1, children: [{ name: 'a.ini', rel: '(x)/a.ini', isDir: false, fileCount: 1, size: 1, children: [] }] },
    [{ name: 'Sibling', rel: 'Sibling', isDir: true, fileCount: 1, size: 1, children: [{ name: 'a.ini', rel: 'Sibling/a.ini', isDir: false, fileCount: 1, size: 1, children: [] }] }]
  )?.rel === 'Sibling'
)

// --- modloader.log is the only honest answer to "did it install?" -----------
// These lines are the shapes Mod Loader really writes, including the one that
// gave away the broken GTA V HUD install: a folder full of files it refused,
// and "No files in" for the same folder.
const mlLog = [
  '========================== Mod Loader 0.3.7 ==========================',
  'Installing file "modloader\\VehFuncs\\vehfuncs.dat"',
  'Installing file "modloader\\VehFuncs\\models\\infernus.dff"',
  'No files in "modloader\\VHud\\"',
  'No handler or callme for file "modloader\\VHud\\blips\\radar_ammu.png"',
  'No handler or callme for file "modloader\\VHud\\data\\hud.dat"',
  'No handler or callme for file "modloader\\Proper Shaders\\ProperShaders.ini"',
  'No handler or callme for file "stream.ini"',
  ''
].join('\r\n')

const mlReport = parseModLoaderLog(mlLog, ['VehFuncs', 'VHud', 'Proper Shaders', 'Never Mentioned'])
const verdictOf = (folder: string): string | undefined => mlReport.mods.find((m) => m.folder === folder)?.verdict

check('modloader.log: the Mod Loader version is read', mlReport.version === '0.3.7', mlReport.version)
check('modloader.log: a mod whose files were installed is active', verdictOf('VehFuncs') === 'active', verdictOf('VehFuncs'))
check(
  'modloader.log: a mod with no installed files and refused files is mis-installed',
  verdictOf('VHud') === 'mis-installed',
  verdictOf('VHud')
)
check(
  'modloader.log: the explanation names the likely cause instead of quoting the log',
  (mlReport.mods.find((m) => m.folder === 'VHud')?.explanation ?? '').includes('separated from its own data'),
  mlReport.mods.find((m) => m.folder === 'VHud')?.explanation
)
check(
  'modloader.log: a mod whose only files Mod Loader does not manage is inert, not broken',
  verdictOf('Proper Shaders') === 'inert',
  verdictOf('Proper Shaders')
)
check(
  'modloader.log: a folder the log never mentions is reported, not dropped',
  verdictOf('Never Mentioned') === 'unknown',
  verdictOf('Never Mentioned')
)
check('modloader.log: a refused file outside any mod folder is kept separately', mlReport.looseUnhandled.includes('stream.ini'), mlReport.looseUnhandled)
check('modloader.log: a clean log reports no crash', mlReport.crash === null)

const crashLog = [
  'Opening file for streaming "MODELS\\GTA3.IMG"',
  'Unhandled exception at 0x005B8E55 in module "gta_sa.exe"',
  'EXCEPTION_ACCESS_VIOLATION writing to 0x00000024',
  'Backtrace:',
  '  0x005B8E55 gta_sa.exe CStreaming::RequestModelStream',
  '  0x004C0C63 gta_sa.exe CStreaming::LoadAllRequestedModels',
  '',
  '--------------------------------'
].join('\r\n')
const mlCrash = parseCrashDump(crashLog)
check('modloader.log: a crash dump is recognised', !!mlCrash, mlCrash)
check('modloader.log: the faulting address is read from the dump', mlCrash?.address === '0x005B8E55', mlCrash?.address)
// This dump reports the address the process faulted at - 0x400000 is already in
// it. Treating it as a fault offset is what rendered this crash as 0x009B8E55.
check('modloader.log: the dump address is marked as already absolute', mlCrash?.addressIsAbsolute === true, mlCrash)
const mlAddressing = describeAbsoluteAddress(mlCrash?.module ?? '', mlCrash?.address ?? '')
check(
  'modloader.log: the crash address is shown as recorded, not re-based',
  mlAddressing.display === '0x005B8E55' && mlAddressing.lookupAddress === '0x005B8E55',
  mlAddressing
)
check(
  'modloader.log: treating it as an offset would have produced 0x009B8E55',
  resolveCrashAddress(mlCrash?.module ?? '', mlCrash?.address ?? '').display === '0x009B8E55' &&
    mlAddressing.display !== '0x009B8E55',
  resolveCrashAddress(mlCrash?.module ?? '', mlCrash?.address ?? '').display
)
check('modloader.log: the faulting module is read', mlCrash?.module === 'gta_sa.exe', mlCrash?.module)
check('modloader.log: the backtrace is kept, innermost frame first', mlCrash?.backtrace.length === 2, mlCrash?.backtrace)
check(
  'modloader.log: the last streamed file is kept, since it is usually the culprit',
  mlCrash?.lastStreamedFile === 'MODELS\\GTA3.IMG',
  mlCrash?.lastStreamedFile
)

// --- stream.ini: the crash that looks like a broken mod ---------------------
// A DODI repack shipped Streaming Memory=13500. GTA SA is a 32-bit process, so
// the streamer dies on the first .IMG read and the fault lands in CStreaming -
// nothing about the mods is wrong, and no other check would ever find it.
check(
  'stream.ini: the memory value is read whatever the adjuster calls the key',
  parseStreamIni('[Streaming]\r\nStreaming Memory=13500\r\n').memoryMb === 13500 &&
    parseStreamIni('StreamMemory = 2048\r\n').memoryMb === 2048 &&
    parseStreamIni('Memory=512').memoryMb === 512,
  parseStreamIni('[Streaming]\r\nStreaming Memory=13500\r\n')
)
check('stream.ini: the key name is kept so a rewrite does not rename it', parseStreamIni('StreamMemory = 2048').key === 'StreamMemory')
check('stream.ini: comments and section headers are not mistaken for values', parseStreamIni('; Memory=99\r\n[Memory]\r\n').memoryMb === null)
check('stream.ini: a file with no memory line reads as unset', parseStreamIni('Something=1\r\n').memoryMb === null)
check('stream.ini: the safe value is below the 32-bit ceiling', SAFE_STREAMING_MEMORY_MB <= 2048)
check(
  'stream.ini: a limit adjuster is recognised by any of its usual names',
  ['OpenLimitAdjuster.asi', 'III.VC.SA.LimitAdjuster.asi', 'fastman92limitAdjuster.asi'].every((n) =>
    limitAdjusterNames().test(n)
  )
)

// --- limit-adjuster IDENTITY, not just presence ------------------------------
// The field install had Open Limit Adjuster (shipped as III.VC.SA.LimitAdjuster.asi)
// AND SimpleLimitAdjuster_Enex.asi active together; the CrashList warns that
// stacking limit adjusters crashes the game. limitAdjusterNames() is a boolean
// used everywhere via .some() and cannot see that two DIFFERENT ones are present
// at once - identifyLimitAdjusters() is the piece that counts distinct products.
check(
  'limit adjusters: a single product present is not a stack',
  identifyLimitAdjusters(['modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi']).length === 1
)
check(
  'limit adjusters: Open Limit Adjuster is one product, not two, even though its file name ' +
    'also matches the bare "LimitAdjuster" pattern',
  identifyLimitAdjusters(['modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi']).map((p) => p.id).join(',') ===
    'open-limit-adjuster'
)
check(
  'limit adjusters: Open Limit Adjuster plus SimpleLimitAdjuster_Enex is a stack of two',
  identifyLimitAdjusters([
    'modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi',
    'scripts/SimpleLimitAdjuster_Enex.asi'
  ]).length === 2
)
check(
  'limit adjusters: the stack names both products with the files that identified them',
  (() => {
    const found = identifyLimitAdjusters([
      'modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi',
      'scripts/SimpleLimitAdjuster_Enex.asi'
    ])
    const open = found.find((p) => p.id === 'open-limit-adjuster')
    const simple = found.find((p) => p.id === 'simple-limit-adjuster')
    return (
      !!open &&
      open.matches.includes('modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi') &&
      !!simple &&
      simple.matches.includes('scripts/SimpleLimitAdjuster_Enex.asi')
    )
  })()
)
check('limit adjusters: fastman92\'s build is its own product, distinct from the others', identifyLimitAdjusters(['fastman92limitAdjuster.asi']).map((p) => p.id).join(',') === 'fastman92-limit-adjuster')
check('limit adjusters: no adjuster anywhere is zero products, not a stack', identifyLimitAdjusters(['ReadMe.txt', 'CLEO.asi']).length === 0)

// --- duplicate .asi across scripts\ and a junctioned modloader\ folder ------
check(
  'duplicate assets: byte-identical files at two paths are grouped, naming both',
  (() => {
    const groups = groupDuplicateAssets([
      { name: 'III.VC.SA.LimitAdjuster.asi', path: 'scripts/III.VC.SA.LimitAdjuster.asi', hash: 'abc' },
      { name: 'III.VC.SA.LimitAdjuster.asi', path: 'modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi', hash: 'abc' }
    ])
    return (
      groups.length === 1 &&
      groups[0].paths.includes('scripts/III.VC.SA.LimitAdjuster.asi') &&
      groups[0].paths.includes('modloader/Open Limit Adjuster/III.VC.SA.LimitAdjuster.asi')
    )
  })()
)
check(
  'duplicate assets: same name, different bytes is not a duplicate',
  groupDuplicateAssets([
    { name: 'x.asi', path: 'scripts/x.asi', hash: 'aaa' },
    { name: 'x.asi', path: 'modloader/Mod/x.asi', hash: 'bbb' }
  ]).length === 0
)
check(
  'duplicate assets: same path counted twice (overlapping scan roots) is not a duplicate of itself',
  groupDuplicateAssets([
    { name: 'x.asi', path: 'scripts/x.asi', hash: 'aaa' },
    { name: 'x.asi', path: 'scripts/x.asi', hash: 'aaa' }
  ]).length === 0
)

// --- what a plugin says about itself -----------------------------------------
// Guessing an .asi's layout from the archive is what put VHud.asi in scripts\
// with its files elsewhere. The binary settles it.
function pe(strings: string[], wide: string[] = []): Buffer {
  const parts: Buffer[] = [Buffer.from('MZ\x90\x00', 'latin1')]
  for (const s of strings) parts.push(Buffer.from(s + '\0', 'latin1'))
  for (const s of wide) parts.push(Buffer.from(s + '\0', 'utf16le'))
  return Buffer.concat(parts)
}

// A backslash written literally here is one escape away from being a backspace,
// so the separator is built rather than typed.
const BS = String.fromCharCode(92)
const vhud = pluginEvidence(
  pe(
    [`VHud${BS}blips`, `VHud${BS}data`, `VHud${BS}map`, 'VHud.ini', 'kernel32.dll', 'd3d9.dll'],
    [`VHud${BS}fonts`, 'SilentPatch is installed.']
  )
)
check('strings: the folder the plugin expects to own is derived from its own paths', vhud.rootFolder === 'VHud', vhud.rootFolder)
check(
  'strings: the paths it opens are listed',
  vhud.paths.includes(`VHud${BS}blips`) && vhud.paths.includes(`VHud${BS}fonts`),
  vhud.paths
)
check('strings: UTF-16 strings are read too, not just ASCII', vhud.paths.includes(`VHud${BS}fonts`), vhud.paths)
check('strings: its own config is picked out', vhud.configs.includes('VHud.ini'), vhud.configs)
check('strings: Windows DLLs every PE mentions are ignored', !vhud.modules.some((m) => /kernel32/i.test(m)), vhud.modules)
check('strings: a plugin it probes for is reported as a dependency candidate', vhud.probes.includes('SilentPatch'), vhud.probes)

const bare = pluginEvidence(pe(['SilentPatchSA.ini', 'kernel32.dll', 'CreateFileA']))
check('strings: a plugin with no folder of its own claims none', bare.rootFolder === null, bare.rootFolder)

const shaders = pluginEvidence(pe(['SilentPatch is installed.', 'Open Limit Adjuster is installed.', 'ProperShaders.ini']))
check(
  'strings: both runtime probes Proper Shaders prints are found',
  shaders.probes.includes('SilentPatch') && shaders.probes.includes('Open Limit Adjuster'),
  shaders.probes
)

// --- asar offsets ------------------------------------------------------------
// The archive verifier reads the built app the way Electron does. asar pads its
// header to a 4-byte boundary, and forgetting that makes every file look
// shifted - a CI build was rejected for a corruption that did not exist.
function asarDataStart(headerSize: number): number {
  return 16 + headerSize + ((4 - (headerSize % 4)) % 4)
}
check('asar: an aligned header needs no padding', asarDataStart(552384) === 16 + 552384)
check('asar: an unaligned header is padded up to the next boundary', asarDataStart(553) === 16 + 553 + 3, asarDataStart(553))
check('asar: padding is never four bytes', [0, 1, 2, 3].every((r) => asarDataStart(100 + r) - (16 + 100 + r) < 4))

// --- what the readme says the mod needs --------------------------------------
// Proper Shaders names SilentPatch and Open Limit Adjuster in its readme and
// probes for them at runtime. Installed without either, the game crashed - so
// these lines are read as dependency edges, not left as prose.
const CRLF = String.fromCharCode(13, 10)
const declaredText = [
  'Proper Shaders',
  '',
  'NECESSARIO: Mod Loader',
  'Requer: SilentPatch',
  '-- Download do Open Limit Adjuster: https://www.mixmods.com.br/2015/03/open-limit-adjuster/',
  'ATENCAO: O mod inclui "gsx.asi", certifique-se de que voce ja nao o tenha.',
  'NAO use junto com SkyGfx, os dois fazem a mesma coisa.',
  'Extraia a pasta "Proper Shaders" para a pasta do ModLoader.'
].join(CRLF)
const declared = parseDeclaredDependencies(declaredText)
const named = (kind: string): string[] => declared.filter((d) => d.kind === kind).map((d) => d.name)

check('readme deps: a NECESSARIO line is a requirement', named('requires').includes('Mod Loader'), named('requires'))
check('readme deps: a Requer line is a requirement', named('requires').includes('SilentPatch'), named('requires'))
check(
  'readme deps: a download line for a companion mod is a requirement',
  named('requires').includes('Open Limit Adjuster'),
  named('requires')
)
check(
  'readme deps: the download URL is kept so the app can offer to fetch it',
  declared.find((d) => d.name === 'Open Limit Adjuster')?.url?.includes('open-limit-adjuster') === true,
  declared.find((d) => d.name === 'Open Limit Adjuster')?.url
)
check('readme deps: a bundled plugin is recorded as included, not required', named('includes').includes('gsx.asi'), named('includes'))
check('readme deps: an incompatibility is recorded as a conflict', named('conflicts').includes('SkyGfx'), named('conflicts'))
check(
  'readme deps: the install instruction is not mistaken for a dependency',
  !declared.some((d) => /extraia|pasta/i.test(d.name)),
  declared.map((d) => d.name)
)
check(
  "readme deps: the author's own line is kept, for showing beside the parse",
  declared.every((d) => d.line.length > 0)
)

// --- safe mode, the way Mod Loader does it ----------------------------------
// Bisection must not move files: chasing a crash by moving gigabytes risks
// creating a second problem while looking for the first. Mod Loader already has
// the switch - ExcludeAllMods plus an [IncludeMods] list.
const safeIni = parseIni(['; keep me', '[Config]', 'IgnoreAllFiles=0', '', '[IncludeMods]', 'Old Cars'].join(CRLF))
applyIgnoreState(safeIni, { excludeAll: true, include: ['SilentPatch', 'Proper Shaders'], ignore: ['Broken Mod'] })
const safeText = stringifyIni(safeIni)
check('safe mode: ExcludeAllMods is written where Mod Loader reads it', /\[Folder\.Config\][\s\S]*ExcludeAllMods=true/.test(safeText), safeText)
check('safe mode: the mods under test are the include list', /\[IncludeMods\][\s\S]*SilentPatch[\s\S]*Proper Shaders/.test(safeText), safeText)
check('safe mode: a previous include is replaced, not appended to', !/Old Cars/.test(safeText), safeText)
check('safe mode: the ignore list is written too', /\[IgnoreMods\][\s\S]*Broken Mod/.test(safeText), safeText)
check('safe mode: user comments survive', safeText.includes('; keep me'))

const readBack = readIgnoreState(parseIni(safeText))
check('safe mode: the state reads back as written', readBack.excludeAll && readBack.include.length === 2 && readBack.ignore.length === 1, readBack)

const restored = parseIni(safeText)
applyIgnoreState(restored, { excludeAll: false, include: [], ignore: [] })
const restoredState = readIgnoreState(parseIni(stringifyIni(restored)))
check(
  'safe mode: restoring puts every mod back',
  restoredState.excludeAll === false && restoredState.include.length === 0,
  restoredState
)

// --- Mod Loader mechanics that decide whether a copied mod works ------------
const mech = path.join(tmp, 'mechanics')
function mechFile(rel: string): void {
  const p = path.join(mech, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 'x')
}
mechFile('Cool Cars/models/infernus.dff')
mechFile('Cool Cars/txd/infernus.txd')
mechFile('Cool Cars/models/infernus.col')
mechFile('Cool Cars/player.img/shirt.dff')
const mechOut = await classifyTree(
  mech,
  { asiRelative: 'scripts', readmes: [], fallbackName: 'Cool Cars' },
  {}
)
const warned = (code: string): boolean => mechOut.warnings.some((w) => w.code === code)
check(
  'mechanics: a vehicle texture in a folder named txd is flagged as a sprite folder',
  warned('txd-sprite-folder'),
  mechOut.warnings.map((w) => w.code)
)
check('mechanics: a .col with no COLFILE line is flagged', warned('col-without-loader'), mechOut.warnings.map((w) => w.code))

const asiFirst = path.join(tmp, 'loadfirst')
fs.mkdirSync(asiFirst, { recursive: true })
fs.writeFileSync(path.join(asiFirst, 'EarlyPatch.asi'), 'x')
const firstOut = await classifyTree(
  asiFirst,
  {
    asiRelative: 'scripts',
    readmes: [
      {
        file: 'leiame.txt',
        encoding: 'windows-1252',
        raw: 'Este mod precisa carregar primeiro, antes dos outros plugins.',
        language: 'pt-BR',
        instructions: [],
        requirementUrls: [],
        declared: [],
        confidence: 0.5
      }
    ],
    fallbackName: 'EarlyPatch'
  },
  {}
)
check(
  'mechanics: "load first" suggests the $ prefix, which is load order, not priority',
  firstOut.warnings.some((w) => w.code === 'asi-load-order'),
  firstOut.warnings.map((w) => w.code)
)

// --- how a mod is recognised again -------------------------------------------
// A rule learned once has to apply to that archive forever, and to archives
// shaped the same way even when their file names differ.
const sigA = signatureForArchive(['VHud.asi', 'VHud/blips/a.png', 'VHud/data/b.dat'], 'Leiame do VHud')
const sigAgain = signatureForArchive(['VHud/data/b.dat', 'VHud.asi', 'VHud/blips/a.png'], 'Leiame do VHud')
check('signature: the same archive signs the same whatever order the files arrive in', sigA.exact === sigAgain.exact)

const sigOther = signatureForArchive(['Other.asi', 'Other/blips/x.png', 'Other/data/y.dat'], 'Outro leiame')
check('signature: a different archive is a different identity', sigA.exact !== sigOther.exact)
check(
  'signature: but an archive laid out the same way shares a shape',
  sigA.shape === sigOther.shape,
  [sigA.shapeParts, sigOther.shapeParts]
)

const sigBig = signatureForArchive(
  ['Pack/models/' + Array.from({ length: 40 }, (_, i) => `car${i}.dff`).join(''), 'Pack/data/handling.cfg'],
  null
)
check('signature: a differently shaped archive does not share it', sigA.shape !== sigBig.shape)
check('signature: the shape says what it is made of, for showing the user', sigA.shapeParts.some((p) => p.startsWith('folders:')), sigA.shapeParts)

// --- requirements named in prose, read as names -----------------------------
// Real failure: Loadscreens 4K says "Download da última versão do Modloader"
// and again in English. That became two requirements - "última versão do
// Modloader" and "latest version of Modloader" - neither of which matched the
// Mod Loader the user already had, and the install was blocked over it.
check('dep names: the Portuguese phrasing resolves to the mod', canonicalDependencyName('última versão do Modloader') === 'Mod Loader', canonicalDependencyName('última versão do Modloader'))
check('dep names: the English phrasing resolves to the same mod', canonicalDependencyName('latest version of Modloader') === 'Mod Loader', canonicalDependencyName('latest version of Modloader'))
check('dep names: spelling variants collapse', canonicalDependencyName('Mod Loader') === 'Mod Loader' && canonicalDependencyName('SA-Modloader') === 'Mod Loader')
check('dep names: CLEO with a version is still CLEO', canonicalDependencyName('CLEO 4.4') === 'CLEO', canonicalDependencyName('CLEO 4.4'))
check('dep names: CLEO+ is not CLEO', canonicalDependencyName('CLEO+') === 'CLEO+')
check('dep names: a word that names nothing is dropped', canonicalDependencyName('versão') === null && canonicalDependencyName('the mod') === null)

const bilingual = parseDeclaredDependencies(
  [
    '-- Download da última versão do Modloader: MixMods.com.br/2015/01/SA-Modloader.html',
    '-- Download the latest version of Modloader: MixMods.com.br/2015/01/SA-Modloader.html'
  ].join(CRLF)
)
check('dep names: the same requirement stated twice is one edge', bilingual.length === 1, bilingual)
check('dep names: and it is the canonical name', bilingual[0]?.name === 'Mod Loader', bilingual[0])

// "Extract the single folder to the ModLoader folder" names no folder at all.
const generic = parseReadmeText('Readme (or die).txt', 'Extract the single folder to the ModLoader folder.', 'ascii')
check(
  'readme: a phrase that describes a folder without naming one yields no folder',
  generic.instructions[0]?.folder === null,
  generic.instructions[0]
)
check(
  'readme: the instruction is still understood as a modloader install',
  generic.instructions[0]?.destination === 'modloader-folder',
  generic.instructions[0]
)

// --- search has to answer what was typed -------------------------------------
// Typing a mod name against three thousand rows and getting them in rating
// order means hunting for the one you named.
const catalogRows = [
  { title: '[SA] VehFuncs v2.5.5', slug: 'sa-vehfuncs', author: 'Junior_Djjr', category: 'Carros', description: 'Funcionalidades para carros' },
  { title: '[SA] VehFuncs Addon Pack', slug: 'sa-vehfuncs-addon', author: 'Community', category: 'Carros', description: 'Addons' },
  { title: '[SA] Animações de Kung Fu melhoradas', slug: 'sa-kung-fu', author: 'Junior_Djjr', category: 'Animações', description: 'Anima o kung fu' },
  { title: '[SA] Real Vehicles Pack', slug: 'sa-rvp', author: 'Outro', category: 'Carros', description: 'Usa o VehFuncs junto' }
]
const ranked = (query: string): string[] =>
  catalogRows
    .map((r) => ({ r, score: relevance(r, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.r.slug)

check('search: the exact mod typed comes first', ranked('vehfuncs')[0] === 'sa-vehfuncs', ranked('vehfuncs'))
check('search: a mod that only mentions it in the description ranks below', ranked('vehfuncs').indexOf('sa-rvp') > 0, ranked('vehfuncs'))
check('search: the game tag in the title is not in the way', relevance(catalogRows[0], 'vehfuncs v2.5.5') > 0)
check(
  'search: typing without accents finds the accented title',
  ranked('animacoes')[0] === 'sa-kung-fu',
  ranked('animacoes')
)
check('search: accents typed properly work too', ranked('animações')[0] === 'sa-kung-fu', ranked('animações'))
check('search: every word has to match, so two words narrow the result', ranked('vehfuncs addon').length === 1, ranked('vehfuncs addon'))
check('search: an author name finds their mods', ranked('junior_djjr').length === 2, ranked('junior_djjr'))
check('search: a word that appears nowhere finds nothing', ranked('helicoptero').length === 0, ranked('helicoptero'))
check('search: an empty query keeps everything', relevance(catalogRows[0], '') > 0)
check('search: folding strips case, accents and punctuation', foldText('Animações (v2.5)!') === 'animacoes v2 5', foldText('Animações (v2.5)!'))

// --- a pack answers for what it ships ----------------------------------------
// The Essentials pack installs SilentPatch, a limit adjuster, the Widescreen
// Fix and CLEO. Asking the user to go and find those again sends them hunting
// for mods they already have.
const essentialsHas = [
  'modloader/_ESSENTIALS/SilentPatch/SilentPatchSA.asi',
  'modloader/_ESSENTIALS/Widescreen Fix by ThirteenAG/GTASA.WidescreenFix.asi',
  'modloader/$fastman92 limit adjuster/fastman92limitAdjuster.asi',
  'scripts/CLEO.asi',
  'vorbisFile.dll',
  '[SA] Essentials (pack de mods que não podem faltar no GTA SA)'
]
check('requirements: SilentPatch inside a pack counts', requirementMet('SilentPatch', essentialsHas))
check('requirements: the Widescreen Fix inside a pack counts', requirementMet('Widescreen Fix', essentialsHas))
check(
  'requirements: a different limit adjuster answers the one the readme names',
  requirementMet('Open Limit Adjuster', essentialsHas),
  essentialsHas
)
check('requirements: any ASI loader answers "ASI Loader"', requirementMet('ASI Loader', essentialsHas))
check('requirements: CLEO is answered by cleo.asi', requirementMet('CLEO', essentialsHas))
check('requirements: CLEO+ is NOT answered by plain CLEO', !requirementMet('CLEO+', ['scripts/CLEO.asi']), 'CLEO+ needs CLEO+')
check('requirements: CLEO+ is answered by its own plugin', requirementMet('CLEO+', ['modloader/Essentials/CLEO/CLEO+.cleo']))
check('requirements: something nobody ships is still missing', !requirementMet('Proper Shaders', essentialsHas))
check('requirements: an empty name is not a requirement', requirementMet('', []))

// --- a mod, or a post about mods ---------------------------------------------
// MixMods is a blog as well as a catalogue: indexing it whole filled the browse
// screen with news and articles that cannot be installed.
const kindOf = (title: string, category: string, hasDownload: boolean, paywalled = false): string =>
  catalogKind({ title, category, hasDownload, paywalled })

check('catalogue: a post with a file is a mod, whatever it is filed under', kindOf('[SA] VehFuncs', 'Curiosidades', true) === 'mod')
check('catalogue: a paywalled release is still a mod', kindOf('[SA] Proper Shaders', 'Gráficos', false, true) === 'mod')
check('catalogue: a news post with nothing to download is an article', kindOf('Novidades de Janeiro', 'Novidades', false) === 'article')
check('catalogue: a myth-hunting post is an article', kindOf('O mito do Bigfoot', 'Mitos e Lendas', false) === 'article')
check('catalogue: a treasure hunt is an article', kindOf('Caça ao Tesouro #4', 'Caça ao Tesouro', false) === 'article')
check('catalogue: a Top 10 is an article even in a mod category', kindOf('Top 10 carros de 2024', 'Carros', false) === 'article')
check('catalogue: the app own adopted entries never show', kindOf('HD Ped Pack', 'Adopted', false) === 'internal')
check(
  'catalogue: a mod whose link the crawler missed is still shown, because hiding a real mod is worse',
  kindOf('[SA] Some Car Pack', 'Carros', false) === 'mod'
)

// --- download links ----------------------------------------------------------
// Which links Modão can fetch on its own decides whether "Install" installs
// or hands the user a chore, so the shapes are pinned down here.
check(
  'download: a file host landing page is not a direct link',
  classifyDownload('https://sharemods.com/llx280hsssre/SA_-_MixSets.zip.html').kind === 'landing'
)
check(
  'download: a GitHub release page is resolvable through the API',
  classifyDownload('https://github.com/CookiePLMonster/SilentPatch/releases/tag/1.1-BUILD34.1-SA').kind === 'github-release'
)
check(
  'download: a GitHub asset is a plain file',
  classifyDownload('https://github.com/x/y/releases/download/v1/mod.7z').kind === 'file'
)
check(
  'download: a file on the site itself is a plain file',
  classifyDownload('https://www.mixmods.com.br/wp-content/uploads/2020/01/mod.zip').kind === 'file'
)
check('download: an ad gate is never fetched directly', classifyDownload('http://linkshrink.net/SCn/x').kind === 'landing')
check(
  'download: Google Drive view links are rewritten to the download endpoint',
  normalizeForFetch('https://drive.google.com/file/d/115LMhaNP6mh/view') ===
    'https://drive.google.com/uc?export=download&id=115LMhaNP6mh',
  normalizeForFetch('https://drive.google.com/file/d/115LMhaNP6mh/view')
)
check('download: zip magic recognised', looksLikeArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
check('download: 7z magic recognised', looksLikeArchive(Buffer.from([0x37, 0x7a, 0xbc, 0xaf])))
check('download: rar magic recognised', looksLikeArchive(Buffer.from([0x52, 0x61, 0x72, 0x21])))
check('download: an HTML error page is not an archive', !looksLikeArchive(Buffer.from('<!DOCTYPE', 'latin1')))

// --- ownedPaths: what happens to the file already at a mod's target ----------
// The regression this pins: a profile switch handed the install its OWN target
// list as `ownedPaths`, so every target answered "already ours", the backup
// branch was unreachable, and the user's loose plugins were force-removed with
// no snapshot, no backup and no quarantine. 14 .asi and 27 CLEO scripts went
// that way in one switch. `ownedPaths` means the paths owned by the OTHER
// installs of the profile, and nothing else.
const displaceRoot = path.join(tmp, 'displace')
const gameFolder = path.join(displaceRoot, 'game')
const userBytes = "the user's own MixSets.asi"
const mixSets = path.join(gameFolder, 'scripts', 'MixSets.asi')
fs.mkdirSync(path.join(gameFolder, 'scripts'), { recursive: true })

fs.writeFileSync(mixSets, userBytes)
const displaced = await displaceForeign({
  target: mixSets,
  relativePath: 'scripts/MixSets.asi',
  // What the install path has always passed, and what the switch path now does:
  // this install's own target is deliberately absent from the set.
  ownedPaths: new Set(['modloader/Some Other Mod/x.dff'].map(ownedKey)),
  backupDir: path.join(displaceRoot, 'backup'),
  quarantineDir: path.join(displaceRoot, 'quarantine')
})
check(
  'ownedPaths: a foreign file is copied out before its path is taken',
  displaced.backedUp.length === 1 && fs.existsSync(displaced.backedUp[0].backupPath),
  displaced
)
check(
  'ownedPaths: the backup holds exactly the bytes the user wrote',
  displaced.backedUp.length === 1 && fs.readFileSync(displaced.backedUp[0].backupPath, 'utf8') === userBytes
)
check(
  'ownedPaths: the user can find the displaced file in quarantine',
  displaced.quarantined.length === 1 && fs.existsSync(displaced.quarantined[0].quarantinePath),
  displaced.quarantined
)
check(
  'ownedPaths: the quarantine copy holds the bytes too',
  displaced.quarantined.length === 1 && fs.readFileSync(displaced.quarantined[0].quarantinePath, 'utf8') === userBytes
)
check('ownedPaths: the target is free once both copies exist', !fs.existsSync(mixSets))

// A path another install of this profile already owns is Modão's own content:
// the store holds those bytes, so it is dropped with no copy and no quarantine
// entry - a backup there would promise a restore of something never lost.
const ourOwn = path.join(gameFolder, 'scripts', 'CLEO.asi')
fs.writeFileSync(ourOwn, 'bytes Modão itself linked in')
const ours = await displaceForeign({
  target: ourOwn,
  relativePath: 'scripts/CLEO.asi',
  ownedPaths: new Set(['scripts/cleo.asi', 'modloader/Some Other Mod/x.dff'].map(ownedKey)),
  backupDir: path.join(displaceRoot, 'backup-owned'),
  quarantineDir: path.join(displaceRoot, 'quarantine-owned')
})
check(
  'ownedPaths: a path the profile already owns is not backed up',
  ours.backedUp.length === 0 && ours.quarantined.length === 0 && !fs.existsSync(ourOwn),
  ours
)
check('ownedPaths: nothing was written to the backup directory', !fs.existsSync(path.join(displaceRoot, 'backup-owned')))

// A REAL folder the profile only partly owns. `isOwned` says "yes" for the
// folder as soon as one tracked file lives inside it - the right answer to "may
// Modão have this path", the wrong answer to "is everything in here Modão's" -
// and the per-folder answer took the stray file with it. This is the field
// failure in miniature: scripts\ held managed plugins and untracked files side
// by side. Decided per file, the stray is copied out like any loose plugin.
const partly = path.join(gameFolder, 'modloader', 'Half Ours')
fs.mkdirSync(path.join(partly, 'data'), { recursive: true })
fs.writeFileSync(path.join(partly, 'tracked.dff'), 'a file another install of this profile provides')
fs.writeFileSync(path.join(partly, 'data', 'stray.ini'), 'a file the user put there and nobody tracks')
const partial = await displaceForeign({
  target: partly,
  relativePath: 'modloader/Half Ours',
  ownedPaths: new Set(['modloader/Half Ours/tracked.dff'].map(ownedKey)),
  backupDir: path.join(displaceRoot, 'backup-partial'),
  quarantineDir: path.join(displaceRoot, 'quarantine-partial')
})
check(
  'ownedPaths: a partly-owned folder is judged file by file, not as a folder',
  partial.backedUp.length === 1 && partial.backedUp[0].relativePath === 'modloader/Half Ours/data/stray.ini',
  partial.backedUp
)
check(
  'ownedPaths: the stray inside it is backed up with its bytes',
  partial.backedUp.length === 1 &&
    fs.existsSync(partial.backedUp[0].backupPath) &&
    fs.readFileSync(partial.backedUp[0].backupPath, 'utf8') === 'a file the user put there and nobody tracks',
  partial.backedUp
)
check(
  'ownedPaths: and the stray is listed in quarantine',
  partial.quarantined.length === 1 &&
    partial.quarantined[0].relativePath === 'modloader/Half Ours/data/stray.ini' &&
    fs.existsSync(partial.quarantined[0].quarantinePath),
  partial.quarantined
)
check(
  'ownedPaths: the tracked file inside it is not copied out - the store has it',
  !fs.existsSync(path.join(displaceRoot, 'backup-partial', 'modloader', 'Half Ours', 'tracked.dff')),
  fs.existsSync(path.join(displaceRoot, 'backup-partial')) ? fs.readdirSync(path.join(displaceRoot, 'backup-partial', 'modloader', 'Half Ours')) : null
)
check('ownedPaths: the folder is gone once the stray is safe', !fs.existsSync(partly))

// The cheap path has to stay cheap: a folder where every file is accounted for
// copies nothing and creates no backup directory at all.
const whollyOurs = path.join(gameFolder, 'modloader', 'All Ours')
fs.mkdirSync(whollyOurs, { recursive: true })
fs.writeFileSync(path.join(whollyOurs, 'a.dff'), 'ours')
fs.writeFileSync(path.join(whollyOurs, 'b.txd'), 'ours too')
const allOurs = await displaceForeign({
  target: whollyOurs,
  relativePath: 'modloader/All Ours',
  ownedPaths: new Set(['modloader/All Ours/a.dff', 'modloader/All Ours/b.txd'].map(ownedKey)),
  backupDir: path.join(displaceRoot, 'backup-all-ours'),
  quarantineDir: path.join(displaceRoot, 'quarantine-all-ours')
})
check(
  'ownedPaths: a wholly-owned folder still costs nothing',
  allOurs.backedUp.length === 0 &&
    allOurs.quarantined.length === 0 &&
    !fs.existsSync(path.join(displaceRoot, 'backup-all-ours')) &&
    !fs.existsSync(whollyOurs),
  allOurs
)

// The exact shape of the bug, as an assertion: build the set the broken switch
// built - the install's own targets - and the user's file is judged ours.
check(
  "ownedPaths: an install's own target must never be in the set",
  isOwned(new Set(['scripts/MixSets.asi'].map(ownedKey)), 'scripts/MixSets.asi') &&
    !isOwned(new Set(['modloader/Some Other Mod/x.dff'].map(ownedKey)), 'scripts/MixSets.asi')
)
check(
  'ownedPaths: a folder is ours when a file we track lives inside it',
  isOwned(new Set(['modloader/vhud/data/radar.xml']), 'modloader/VHud') &&
    !isOwned(new Set(['modloader/vhud/data/radar.xml']), 'modloader/VHudExtra')
)
check('ownedPaths: slashes and case fold to one spelling', ownedKey('\\Scripts\\MixSets.ASI\\') === 'scripts/mixsets.asi')

// --- the game is running ---------------------------------------------------
// Mod Loader hot-reloads modloader\, so a write while the game is live crashes
// it. The verdict below is the whole decision; the process table it reads is
// injected here instead of being shelled out for.
const saInstall = { path: 'C:\\Games\\GTA San Andreas', kind: 'sa' as const }
const proc = (name: string, imagePath: string | null, pid = 4242): RunningProcess => ({ name, pid, imagePath })

check('running: nothing running is a pass', gameRunningVerdict(saInstall, []).allowed)
check('running: an unrelated process is a pass', gameRunningVerdict(saInstall, [proc('notepad.exe', 'C:\\Windows\\notepad.exe')]).allowed)

const live = gameRunningVerdict(saInstall, [proc('gta_sa.exe', 'C:\\Games\\GTA San Andreas\\gta_sa.exe')])
check('running: this install\'s exe refuses and names itself', !live.allowed && live.exe === 'gta_sa.exe' && !live.assumed, live)

check(
  'running: the same exe from another folder is not this game',
  gameRunningVerdict(saInstall, [proc('gta_sa.exe', 'D:\\Other\\GTA San Andreas\\gta_sa.exe')]).allowed
)
check(
  'running: a folder whose name only starts the same is not this game',
  gameRunningVerdict(saInstall, [proc('gta_sa.exe', 'C:\\Games\\GTA San Andreas 2\\gta_sa.exe')]).allowed
)
check(
  'running: case and slashes fold to one spelling',
  !gameRunningVerdict({ path: 'c:/games/gta san andreas/', kind: 'sa' }, [
    proc('GTA_SA.EXE', 'C:\\Games\\GTA San Andreas\\gta_sa.exe')
  ]).allowed
)

// tasklist reports no path at all, and Get-Process withholds it for a process
// running elevated. A name match that cannot be placed fails closed.
const unplaceable = gameRunningVerdict(saInstall, [proc('gta_sa.exe', null)])
check('running: a name match with no path refuses, and says it assumed', !unplaceable.allowed && unplaceable.assumed, unplaceable)

// Every target the app supports, not a hardcoded gta_sa.exe.
check('running: III is matched by gta3.exe', !gameRunningVerdict({ path: 'C:\\GTA3', kind: 'iii' }, [proc('gta3.exe', 'C:\\GTA3\\gta3.exe')]).allowed)
check(
  'running: Vice City is matched by either of its two exe names',
  !gameRunningVerdict({ path: 'C:\\VC', kind: 'vc' }, [proc('gta_vc.exe', 'C:\\VC\\gta_vc.exe')]).allowed &&
    !gameRunningVerdict({ path: 'C:\\VC', kind: 'vc' }, [proc('gta-vc.exe', 'C:\\VC\\gta-vc.exe')]).allowed
)
check(
  'running: SA:DE is matched by the exe nested under Gameface\\',
  gameExeNames('sade').includes('sanandreas.exe') &&
    !gameRunningVerdict({ path: 'C:\\SADE', kind: 'sade' }, [
      proc('SanAndreas.exe', 'C:\\SADE\\Gameface\\Binaries\\Win64\\SanAndreas.exe')
    ]).allowed
)
check('running: a III exe does not block a San Andreas install', gameRunningVerdict(saInstall, [proc('gta3.exe', 'C:\\GTA3\\gta3.exe')]).allowed)

// The refusal itself: it throws, and the message names the process.
const listerRunning = async (): Promise<RunningProcess[]> => [proc('gta_sa.exe', 'C:\\Games\\GTA San Andreas\\gta_sa.exe')]
const listerIdle = async (): Promise<RunningProcess[]> => []
let refusal: string | null = null
try {
  await assertGameNotRunning(saInstall, listerRunning)
} catch (e) {
  refusal = (e as Error).message
}
check('running: assertGameNotRunning throws and names the process', !!refusal && refusal.includes('gta_sa.exe'), refusal)
let closedThrew = false
try {
  await assertGameNotRunning(saInstall, listerIdle)
} catch {
  closedThrew = true
}
check('running: assertGameNotRunning passes when the game is closed', !closedThrew)


// --- what gets stored, and what comes back out ------------------------------
// The item 06 fix lives in the write and read paths of eventlog.ts, which reach
// PowerShell and better-sqlite3 and so cannot be loaded here. The DECISION those
// paths make is extracted into @shared/crashRecord, and it is tested directly:
// reverting any part of the fix makes one of these fail.
import { addressingForStorage, addressingFromStoredRow } from '../src/shared/crashRecord'

// Source 1: the Windows Event Log, which reports an offset relative to the module.
const storedExe = addressingForStorage({
  from: 'eventlog',
  kind: 'exception',
  module: 'gta_sa.exe',
  faultOffset: '0x000c0c63'
})
check(
  'stored: an Event Log offset inside the exe is stored as base + offset',
  storedExe.crashAddress === '0x004C0C63' && storedExe.addressKind === 'exe',
  storedExe
)
check(
  'stored: an Event Log row keeps its offset, because it really has one',
  storedExe.faultOffset === '0x000c0c63' && storedExe.lookupAddress === '0x004C0C63',
  storedExe
)

const storedUnloadedDll = addressingForStorage({
  from: 'eventlog',
  kind: 'exception',
  module: 'std.data.dll_unloaded',
  faultOffset: '0x0001a2b0'
})
check(
  'stored: an already-unloaded DLL offset is stored as module+offset, unbased',
  storedUnloadedDll.crashAddress === 'std.data.dll+0x0001A2B0' && storedUnloadedDll.addressKind === 'module',
  storedUnloadedDll
)
check(
  'stored: the unloaded marker is recorded rather than assumed',
  storedUnloadedDll.moduleUnloaded === true && storedUnloadedDll.lookupAddress === null,
  storedUnloadedDll
)

const storedHang = addressingForStorage({ from: 'eventlog', kind: 'hang', module: 'gta_sa.exe', faultOffset: '' })
check(
  'stored: a hang stores no address at all, and is never looked up',
  storedHang.crashAddress === '' && storedHang.addressKind === 'none' && storedHang.lookupAddress === null,
  storedHang
)

// Source 2: modloader.log, which reports the address the process faulted at.
// This is the regression the field report caught. If this call ever goes back
// through resolveCrashAddress, crashAddress becomes 0x009B8E55 and this fails.
const storedFromDump = addressingForStorage({ from: 'modloader', module: mlCrash?.module ?? '', address: mlCrash?.address ?? '' })
check(
  'stored: an absolute modloader.log address is stored exactly as recorded',
  storedFromDump.crashAddress === '0x005B8E55' && storedFromDump.addressKind === 'exe',
  storedFromDump
)
check(
  'stored: the image base is not added to an address that already has it',
  storedFromDump.crashAddress !== '0x009B8E55' &&
    storedFromDump.crashAddress !== resolveCrashAddress('gta_sa.exe', mlCrash?.address ?? '').display,
  storedFromDump.crashAddress
)
check(
  'stored: an absolute source leaves fault_offset empty, so no read can re-derive it',
  storedFromDump.faultOffset === '',
  storedFromDump
)
check(
  'stored: an absolute exe address is still the one thing CrashList may be asked',
  storedFromDump.lookupAddress === '0x005B8E55',
  storedFromDump
)

const storedDumpInDll = addressingForStorage({ from: 'modloader', module: 'std.data.dll_unloaded', address: '0x0F2B1000' })
check(
  'stored: an absolute address inside an unloaded DLL is flagged and never looked up',
  storedDumpInDll.moduleUnloaded === true &&
    storedDumpInDll.addressKind === 'module' &&
    storedDumpInDll.lookupAddress === null,
  storedDumpInDll
)
check(
  'stored: a modloader.log fault outside the exe gets no image base either',
  !/^0x00[4-9A-F]/.test(storedDumpInDll.crashAddress),
  storedDumpInDll.crashAddress
)

// Reading back. A row written by the module-aware scan is returned as stored -
// this is the half that used to re-derive base + already-based-address on every
// single read, long after the write site was corrected.
const readDumpRow = addressingFromStoredRow({
  kind: 'exception',
  module: 'gta_sa.exe',
  faultOffset: storedFromDump.faultOffset,
  crashAddress: storedFromDump.crashAddress,
  addressKind: storedFromDump.addressKind,
  addressNote: storedFromDump.addressNote
})
check(
  'read: a stored absolute address survives the round trip unchanged',
  readDumpRow.crashAddress === '0x005B8E55' && readDumpRow.derived === false,
  readDumpRow
)
check(
  'read: reading the same row a hundred times never moves the address',
  Array.from({ length: 100 }).reduce<string>(
    (addr) =>
      addressingFromStoredRow({
        kind: 'exception',
        module: 'gta_sa.exe',
        faultOffset: '',
        crashAddress: addr,
        addressKind: 'exe',
        addressNote: null
      }).crashAddress,
    storedFromDump.crashAddress
  ) === '0x005B8E55'
)

const readEventLogRow = addressingFromStoredRow({
  kind: 'exception',
  module: 'gta_sa.exe',
  faultOffset: storedExe.faultOffset,
  crashAddress: storedExe.crashAddress,
  addressKind: storedExe.addressKind,
  addressNote: storedExe.addressNote
})
check(
  'read: a stored Event Log address is not based a second time on read',
  readEventLogRow.crashAddress === '0x004C0C63' && readEventLogRow.derived === false,
  readEventLogRow
)

// Legacy rows - written before address_kind existed - are the only ones still
// worked out on read, and there the derivation wins: those rows hold the old
// exe-only guess, so a DLL fault has an exe address sitting in crash_address.
const readLegacyDll = addressingFromStoredRow({
  kind: 'exception',
  module: 'std.data.dll',
  faultOffset: '0x0001a2b0',
  crashAddress: '0x0041A2B0',
  addressKind: null,
  addressNote: null
})
check(
  'read: a legacy exe-era address stored against a DLL fault is not shown',
  readLegacyDll.crashAddress === 'std.data.dll+0x0001A2B0' && readLegacyDll.derived === true,
  readLegacyDll
)
check(
  'read: a legacy exe row is derived once, image base included',
  addressingFromStoredRow({
    kind: 'exception',
    module: 'gta_sa.exe',
    faultOffset: '0x000c0c63',
    crashAddress: '',
    addressKind: null,
    addressNote: null
  }).crashAddress === '0x004C0C63'
)

// --- the access probe must not write while the game is up -------------------
// probeWriteAccess establishes write access by creating and deleting a file
// inside modloader\ - the folder Mod Loader watches. app:elevation and
// game:list reach it without meaning to write anything at all, so with the game
// up it has to answer from what it already knows and touch nothing.
const probeRoot = path.join(tmp, 'probe-game')
const probeModloader = path.join(probeRoot, 'modloader')
fs.mkdirSync(probeModloader, { recursive: true })
const probeGame = { path: probeRoot, kind: 'sa' as const }
// The process has to be running out of *this* folder, or the verdict is
// "somebody else's install" and the probe is allowed to run after all.
const listerRunningHere = async (): Promise<RunningProcess[]> => [proc('gta_sa.exe', path.join(probeRoot, 'gta_sa.exe'))]

forgetWriteAccess()
forgetRunningProcesses()
const closedAccess = await writeAccessUnlessGameRunning(probeGame, listerIdle)
check('probe: with the game closed it probes and answers', closedAccess?.writable === true, closedAccess)
check('probe: the probe file is never left behind', fs.readdirSync(probeModloader).length === 0)

// Nothing known and the game up: "not known", rather than an answer invented by
// writing into a folder Mod Loader is watching. A probe here would have
// returned an ENOENT verdict, so null is proof that none was run.
fs.rmSync(probeRoot, { recursive: true, force: true })
forgetWriteAccess()
forgetRunningProcesses()
const unknownAccess = await writeAccessUnlessGameRunning(probeGame, listerRunningHere)
check('probe: nothing known and the game running answers nothing', unknownAccess === null, unknownAccess)
check('probe: and it did not create anything to find out', !fs.existsSync(probeRoot))

// With an earlier answer on record, that answer is what is served.
fs.mkdirSync(probeModloader, { recursive: true })
forgetRunningProcesses()
await writeAccessUnlessGameRunning(probeGame, listerIdle)
forgetRunningProcesses()
const runningAccess = await writeAccessUnlessGameRunning(probeGame, listerRunningHere)
check(
  'probe: with the game running the earlier answer is served',
  runningAccess?.writable === true && fs.readdirSync(probeModloader).length === 0,
  runningAccess
)

// The same rule has to reach the synchronous callers that cannot await - every
// activeGame() behind toGameInstall. A forced probe is still a write.
fs.rmSync(probeRoot, { recursive: true, force: true })
forgetWriteAccess()
rememberGameRunning(probeRoot, true)
const forced = probeWriteAccess(probeRoot, true)
check('probe: a forced sync probe is suppressed while the game is running', forced.writable === true && !fs.existsSync(probeRoot), forced)
forgetRunningProcesses()
const afterwards = probeWriteAccess(probeRoot, true)
check('probe: once the game is gone the sync probe runs again', afterwards.writable === false && afterwards.code === 'ENOENT', afterwards)
forgetWriteAccess()
forgetRunningProcesses()

// --- a refusal changes nothing ----------------------------------------------
// game:adopt used to point the app at the install before checking on it, so a
// refusal still moved the active-game pointer while telling the user nothing
// had changed. The mutation runs through whenGameClosed now.
let activeGameId = 1
let adoptRefusal: string | null = null
try {
  await whenGameClosed(saInstall, () => (activeGameId = 2), listerRunning)
} catch (e) {
  adoptRefusal = (e as Error).message
}
check('adopt: the refusal is raised', !!adoptRefusal && adoptRefusal.includes('gta_sa.exe'), adoptRefusal)
check('adopt: the active game is left exactly where it was', activeGameId === 1)
check(
  'adopt: with the game closed the change goes through',
  (await whenGameClosed(saInstall, () => (activeGameId = 2), listerIdle)) === 2 && activeGameId === 2
)
forgetRunningProcesses()

// --- outdated builds against upstream releases -------------------------------
// The field report: Collectibles on Radar installed as a 2021-12-26 build of
// 282,112 bytes, crashing every launch; upstream v1.0.4 is 253,440 bytes and
// fixes it. Days of bisecting for something one HTTP request answers.
const COLLECTIBLES_SHA = 'a'.repeat(64)
const UPSTREAM_SHA = 'b'.repeat(64)

const installedCollectibles: InstalledBinary = {
  relativePath: 'CollectiblesOnRadar.asi',
  sizeBytes: 282_112,
  sha256: COLLECTIBLES_SHA,
  // 2021-12-26, as the PE header records it.
  peTimestamp: Math.floor(Date.parse('2021-12-26T00:00:00Z') / 1000)
}

function release(assets: { name: string; sizeBytes: number; sha256?: string | null }[], publishedAt = '2026-02-01T00:00:00Z'): UpstreamRelease {
  return {
    tag: 'v1.0.4',
    publishedAt,
    htmlUrl: 'https://github.com/kong78/collectibles-on-radar-gta-sa/releases/tag/v1.0.4',
    assets: assets.map((a) => ({ name: a.name, sizeBytes: a.sizeBytes, sha256: a.sha256 ?? null }))
  }
}

const KONG = { owner: 'kong78', repo: 'collectibles-on-radar-gta-sa' }
const stub = (r: UpstreamRelease | null): ReleaseFetcher => async () => r
const offline: ReleaseFetcher = async () => {
  throw new Error('getaddrinfo ENOTFOUND api.github.com')
}

// Every repo the spec named has to be in the seeded registry, or the mod that
// started all of this is still invisible to the check.
for (const want of [
  'kong78/collectibles-on-radar-gta-sa',
  'Flentric/SA.MapCollectibles',
  'CookiePLMonster/SilentPatch',
  'GTAmodding/III.VC.SA.LimitAdjuster',
  'JuniorDjjr/CLEOPlus',
  'cleolibrary/CLEO4',
  'ThirteenAG/III.VC.SA.WindowedMode'
]) {
  check(
    `upstream: the registry is seeded with ${want}`,
    UPSTREAM_REGISTRY.some((e) => `${e.owner}/${e.repo}` === want)
  )
}

// How a mod is resolved to a repo, in the order the resolver tries.
check(
  'upstream: a catalog slug resolves to its repo',
  JSON.stringify(resolveRepo({ slug: 'sa-silentpatch' })) ===
    JSON.stringify({ owner: 'CookiePLMonster', repo: 'SilentPatch', via: 'slug' }),
  resolveRepo({ slug: 'sa-silentpatch' })
)
check(
  'upstream: a GitHub release download URL resolves to its repo',
  resolveRepo({
    slug: 'whatever-mixmods-called-it',
    downloadUrl: 'https://github.com/ThirteenAG/III.VC.SA.WindowedMode/releases/tag/1.3'
  })?.via === 'url'
)
check(
  'upstream: an unregistered mod with no GitHub link resolves to nothing',
  resolveRepo({ slug: 'tuning-mod', sourceUrl: 'https://www.mixmods.com.br/2019/01/tuning-mod/' }) === null
)
check(
  'upstream: the installed binary alone identifies the repo',
  resolveRepo({ slug: 'unknown', fileNames: ['modloader\\Collectibles\\CollectiblesOnRadar.asi'] })?.repo ===
    'collectibles-on-radar-gta-sa'
)

// The comparison itself, driven by a stubbed fetcher - no network in tests.
const same = await compareAgainstUpstream(
  installedCollectibles,
  KONG,
  stub(release([{ name: 'CollectiblesOnRadar.asi', sizeBytes: 282_112, sha256: COLLECTIBLES_SHA }]))
)
check('upstream: same size and hash is current', same.state === 'current' && same.reason === 'sha-match', same)

const sizeOnly = await compareAgainstUpstream(
  installedCollectibles,
  KONG,
  stub(release([{ name: 'CollectiblesOnRadar.asi', sizeBytes: 282_112 }]))
)
check('upstream: same size with no digest published is current', sizeOnly.state === 'current' && sizeOnly.reason === 'size-match', sizeOnly)

const theFieldReport = await compareAgainstUpstream(
  installedCollectibles,
  KONG,
  stub(release([{ name: 'CollectiblesOnRadar.asi', sizeBytes: 253_440 }]))
)
check(
  'upstream: 282,112 bytes installed against a 253,440 byte release is outdated',
  theFieldReport.state === 'outdated' && theFieldReport.reason === 'size-differs',
  theFieldReport
)

const hashDiffers = await compareAgainstUpstream(
  installedCollectibles,
  KONG,
  stub(release([{ name: 'CollectiblesOnRadar.asi', sizeBytes: 282_112, sha256: UPSTREAM_SHA }]))
)
check('upstream: same size, different hash is outdated', hashDiffers.state === 'outdated' && hashDiffers.reason === 'sha-differs', hashDiffers)

// The rule that matters most: a user with no network is never told their mods
// are stale.
const noNetwork = await compareAgainstUpstream(installedCollectibles, KONG, offline)
check('upstream: a fetch failure is unknown, never outdated', noNetwork.state === 'unknown' && noNetwork.reason === 'fetch-failed', noNetwork)
const noRelease = await compareAgainstUpstream(installedCollectibles, KONG, stub(null))
check('upstream: a repo with no release is unknown', noRelease.state === 'unknown' && noRelease.reason === 'no-release', noRelease)

// Most of these repos publish a .zip, so there is nothing to compare byte for
// byte and the PE timestamp is the only hint available.
const zipOnlyOld = await compareAgainstUpstream(installedCollectibles, KONG, stub(release([{ name: 'CollectiblesOnRadar.zip', sizeBytes: 90_000 }])))
check(
  'upstream: an archive-only release far newer than the PE timestamp is a hinted outdated',
  zipOnlyOld.state === 'outdated' && zipOnlyOld.reason === 'pe-older-than-release',
  zipOnlyOld
)
const zipOnlyFresh = await compareAgainstUpstream(
  { ...installedCollectibles, peTimestamp: Math.floor(Date.parse('2026-01-28T00:00:00Z') / 1000) },
  KONG,
  stub(release([{ name: 'CollectiblesOnRadar.zip', sizeBytes: 90_000 }]))
)
check(
  'upstream: a binary compiled just before the release is not called outdated',
  zipOnlyFresh.state === 'unknown' && zipOnlyFresh.reason === 'no-comparable-asset',
  zipOnlyFresh
)

// What startBisect does with that answer, as a rule it can be held to.
const finding: OutdatedBuild = {
  installId: 7,
  title: 'Collectibles on Radar',
  relativePath: 'CollectiblesOnRadar.asi',
  repo: 'kong78/collectibles-on-radar-gta-sa',
  installedBytes: 282_112,
  upstreamBytes: 253_440,
  upstreamTag: 'v1.0.4',
  releaseUrl: 'https://github.com/kong78/collectibles-on-radar-gta-sa/releases/tag/v1.0.4',
  reason: 'size-differs'
}
const refused = bisectGate([finding], new Set())
check('bisect: an outdated mod is surfaced instead of a first bisect step', !refused.proceed && refused.refusal?.key === 'messages.bisect.outdatedFirst', refused)
check(
  'bisect: the refusal names the mod and both sizes',
  refused.refusal?.params.title === 'Collectibles on Radar' &&
    refused.refusal?.params.installed === (282_112).toLocaleString() &&
    refused.refusal?.params.latest === (253_440).toLocaleString(),
  refused.refusal
)
const told = bisectGate([finding], new Set([outdatedSignature(finding)]))
check('bisect: once told, the user is not locked out of bisecting', told.proceed && told.outdated.length === 1, told)
check('bisect: with nothing outdated the bisect starts as before', bisectGate([], new Set()).proceed)
// Offline produces an empty finding list, which must read as "carry on", not
// as a refusal the user cannot clear.
check('bisect: an offline check never refuses a bisect', bisectGate([], new Set()).refusal === null)

// Important #2 regression: being told about one outdated mod must not
// suppress the warning for a DIFFERENT mod that goes stale later in the same
// session - the old per-profile boolean did exactly that.
const otherFinding: OutdatedBuild = {
  installId: 9,
  title: 'CLEO Plus',
  relativePath: 'cleo+.cleo',
  repo: 'JuniorDjjr/CLEOPlus',
  installedBytes: 40_000,
  upstreamBytes: 41_500,
  upstreamTag: 'v2.0',
  releaseUrl: 'https://github.com/JuniorDjjr/CLEOPlus/releases/tag/v2.0',
  reason: 'size-differs'
}
const toldOnlyFirst = new Set([outdatedSignature(finding)])
const stillRefusesForNewMod = bisectGate([finding, otherFinding], toldOnlyFirst)
check(
  'bisect: being told about one outdated mod does not suppress a different one found later',
  !stillRefusesForNewMod.proceed && stillRefusesForNewMod.refusal?.params.title === 'CLEO Plus',
  stillRefusesForNewMod
)
// The same finding a second time, once acknowledged, does proceed.
check('bisect: the same finding, once told, proceeds', bisectGate([finding], toldOnlyFirst).proceed)

// Important #3 regression: the check and the first halving are fused into one
// call so a reorder cannot run the halving ahead of the gate. A refusal
// carries no `first` step at all - there is nothing to read even if a future
// caller tried.
const refusePlan = planBisectStart([1, 2, 3, 4], [finding], new Set())
check(
  'bisect: an outdated mod refuses before any halving happens',
  refusePlan.kind === 'refuse' && !('first' in refusePlan),
  refusePlan
)
const startPlan = planBisectStart([1, 2, 3, 4], [], new Set())
check(
  'bisect: a clear scan starts already halved, one step in',
  startPlan.kind === 'start' && startPlan.first.step === 1 && startPlan.first.testing.length === 2 && startPlan.first.candidates.length === 4,
  startPlan
)
const startPlanAcknowledged = planBisectStart([10, 11, 12], [finding], new Set([outdatedSignature(finding)]))
check(
  'bisect: an acknowledged finding still starts the bisect, carrying the finding on the plan',
  startPlanAcknowledged.kind === 'start' && startPlanAcknowledged.outdated.length === 1,
  startPlanAcknowledged
)

for (const language of ['pt-BR', 'en'] as const) {
  const refusal = translate(language, 'messages.bisect.outdatedFirst', refused.refusal?.params)
  check(
    `bisect: the refusal is written in ${language}`,
    refusal.includes('Collectibles on Radar') && refusal.includes((253_440).toLocaleString()) && !refusal.includes('{'),
    refusal
  )
  const title = translate(language, 'checks.upstreamTitle')
  check(`upstream: the health check has a ${language} title`, title.length > 0 && title !== 'upstreamTitle', title)
  const capped = translate(language, 'checks.upstreamCapped', { count: 3 })
  check(`upstream: the capped-scan notice renders in ${language} with no leftover placeholder`, capped.includes('3') && !capped.includes('{'), capped)
}

// Critical regression: a scan where every mod resolved to a repo but every
// fetch failed must never present itself as "pass". Before this fix,
// `checked` counted attempts (including failed ones), so this exact shape -
// one repo resolved, its fetch failed, nothing else attempted - fell through
// to `pass` with "1 mod(s) checked... none behind", telling an offline user
// their mods were current when nothing had actually been verified.
const allFetchesFailed = { outdated: [], checked: 0, unknown: 1, empty: false, skippedRepos: 0 }
check(
  'upstream: a scan where every fetch failed is skip, never a false pass',
  upstreamCheckVerdict(allFetchesFailed).status === 'skip',
  upstreamCheckVerdict(allFetchesFailed)
)
check('upstream: that same skip is flagged as a partial scan', upstreamCheckVerdict(allFetchesFailed).partial === true)

const noModsResolved = { outdated: [], checked: 0, unknown: 0, empty: true, skippedRepos: 0 }
check('upstream: no mod resolving to a repo at all is skip', upstreamCheckVerdict(noModsResolved).status === 'skip')

const someReachable = { outdated: [], checked: 2, unknown: 1, empty: false, skippedRepos: 0 }
check(
  'upstream: some reachable and none outdated is a real pass, but still marked partial',
  upstreamCheckVerdict(someReachable).status === 'pass' && upstreamCheckVerdict(someReachable).partial === true,
  upstreamCheckVerdict(someReachable)
)

const everythingReachable = { outdated: [], checked: 3, unknown: 0, empty: false, skippedRepos: 0 }
check(
  'upstream: everything reachable and current is a pass with no partial flag',
  upstreamCheckVerdict(everythingReachable).status === 'pass' && upstreamCheckVerdict(everythingReachable).partial === false
)

const oneOutdatedRest = { outdated: [finding], checked: 1, unknown: 0, empty: false, skippedRepos: 0 }
check('upstream: an outdated mod is warn even when nothing else was left unresolved', upstreamCheckVerdict(oneOutdatedRest).status === 'warn')

// Minor regression: the per-run cap drops resolvable repos silently unless it
// is counted and surfaced as a partial scan - same rule as the Critical.
const cappedScan = { outdated: [], checked: 5, unknown: 0, empty: false, skippedRepos: 2 }
check(
  'upstream: repos dropped by the per-run cap mark the scan partial even when everything checked was current',
  upstreamCheckVerdict(cappedScan).status === 'pass' && upstreamCheckVerdict(cappedScan).partial === true,
  upstreamCheckVerdict(cappedScan)
)

// --- a health run diagnoses without writing ---------------------------------
// runHealthCheck forces a write-access probe, which creates a file inside
// modloader\. health:run is not refused while the game is up - a diagnosis is
// what the user asked for - so the handler establishes the running state first,
// and that is what suppresses the probe. This is that sequence.
const healthRoot = path.join(tmp, 'health-game')
const healthModloader = path.join(healthRoot, 'modloader')
fs.mkdirSync(healthModloader, { recursive: true })
const healthGame = { path: healthRoot, kind: 'sa' as const }
const listerRunningHealth = async (): Promise<RunningProcess[]> => [proc('gta_sa.exe', path.join(healthRoot, 'gta_sa.exe'))]

forgetWriteAccess()
forgetRunningProcesses()
await checkGameRunning(healthGame, listerRunningHealth) // what the handler awaits
const healthAccess = probeWriteAccess(healthRoot, true) // what runHealthCheck does
check(
  'health: a health run creates nothing under modloader\\ while the game is running',
  fs.readdirSync(healthModloader).length === 0 && healthAccess.writable === true,
  healthAccess
)

// Non-vacuous: with the folder gone, a probe that actually ran could only say
// ENOENT, and the cache is empty, so "writable" is proof nothing touched the
// disk. The control below shows the same call does probe once the game closes.
fs.rmSync(healthRoot, { recursive: true, force: true })
forgetWriteAccess()
forgetRunningProcesses()
await checkGameRunning(healthGame, listerRunningHealth)
check(
  'health: the forced probe inside it is suppressed, not merely cached',
  probeWriteAccess(healthRoot, true).writable === true && !fs.existsSync(healthRoot)
)
forgetWriteAccess()
forgetRunningProcesses()
await checkGameRunning(healthGame, listerIdle)
const healthClosed = probeWriteAccess(healthRoot, true)
check(
  'health: with the game closed that same probe runs for real',
  healthClosed.writable === false && healthClosed.code === 'ENOENT',
  healthClosed
)
forgetWriteAccess()
forgetRunningProcesses()

// --- MSVC-mangled hook addresses ---------------------------------------------
// A plugin-sdk .asi built with no source spells the addresses it hooks as hex
// nibbles A-P (A=0 .. P=15) inside its own symbol table. These four are the
// real mangled names CollectiblesOnRadar.SA.asi carries.
check('mangled: $0FDOJIB@ decodes to 0x53E981', decodeMangledHex('$0FDOJIB@') === 0x53e981, decodeMangledHex('$0FDOJIB@'))
check('mangled: $0FHFLEE@ decodes to 0x575B44', decodeMangledHex('$0FHFLEE@') === 0x575b44, decodeMangledHex('$0FHFLEE@'))
check('mangled: $0FIKKCN@ decodes to 0x58AA2D', decodeMangledHex('$0FIKKCN@') === 0x58aa2d, decodeMangledHex('$0FIKKCN@'))
check('mangled: $0FLPDKB@ decodes to 0x5BF3A1', decodeMangledHex('$0FLPDKB@') === 0x5bf3a1, decodeMangledHex('$0FLPDKB@'))
check('mangled: a malformed token decodes to nothing', decodeMangledHex('$0FDOJIB') === null)

const embeddedMangled = extractMangledAddresses(['??$Call@$0FDOJIB@@ClassX@@SAXXZ', 'no mangling in here at all'])
check(
  'mangled: a mangled token embedded in a longer decorated symbol is still found',
  embeddedMangled.includes(0x53e981),
  embeddedMangled
)

// --- two mods hooking one address --------------------------------------------
const hookCollisions = findHookCollisions([
  { title: 'Collectibles on Radar', file: 'CollectiblesOnRadar.SA.asi', addresses: [0x53e981, 0x575b44] },
  { title: 'Some Other Mod', file: 'OtherMod.asi', addresses: [0x53e981] }
])
check(
  'hooks: two different mods hooking one address are flagged',
  hookCollisions.some((c) => c.address === '0x0053E981' && new Set(c.claimants.map((x) => x.title)).size === 2),
  hookCollisions
)
check(
  'hooks: an address only one mod hooks is not flagged',
  !hookCollisions.some((c) => c.address === '0x00575B44'),
  hookCollisions
)
const noHookCollision = findHookCollisions([
  { title: 'Solo Mod', file: 'a.asi', addresses: [0x1000] },
  { title: 'Solo Mod', file: 'b.asi', addresses: [0x1000] }
])
check('hooks: the same mod hooking its own address from two files is not a collision', noHookCollision.length === 0, noHookCollision)

// --- deep analysis: VA to file offset, and a hex window -----------------------
// Not a disassembler - Python and capstone are not available to this app. This
// is the VA-to-file-offset conversion, over a synthetic PE section table.
const synthSections = [
  { name: '.text', virtualAddress: 0x1000, virtualSize: 0x5000, rawSize: 0x5000, rawPointer: 0x400 },
  { name: '.rdata', virtualAddress: 0x6000, virtualSize: 0x2000, rawSize: 0x2000, rawPointer: 0x5400 }
]
const synthImageBase = 0x400000
const offsetHit = vaToFileOffset(synthImageBase, synthSections, synthImageBase + 0x1200)
check(
  'disasm: a VA converts to the right file offset for a synthetic PE section table',
  offsetHit?.section === '.text' && offsetHit?.fileOffset === 0x600,
  offsetHit
)
const offsetMiss = vaToFileOffset(synthImageBase, synthSections, synthImageBase + 0x9000)
check('disasm: a VA outside every section converts to nothing', offsetMiss === null, offsetMiss)

// A .bss-like section: virtualSize exceeds rawSize, because its uninitialised
// tail has no bytes on disk at all. An address inside the raw-backed part
// still resolves; one inside the tail must report nothing rather than a
// wrong offset computed from bytes that do not exist in the file.
const sectionsWithBssTail = [
  ...synthSections,
  { name: '.bss', virtualAddress: 0x8000, virtualSize: 0x3000, rawSize: 0x1000, rawPointer: 0x7400 }
]
const bssBackedHit = vaToFileOffset(synthImageBase, sectionsWithBssTail, synthImageBase + 0x8500)
check(
  'disasm: an address inside a bss-like section but within its raw-backed range still resolves',
  bssBackedHit?.section === '.bss' && bssBackedHit?.fileOffset === 0x7900,
  bssBackedHit
)
const bssTailMiss = vaToFileOffset(synthImageBase, sectionsWithBssTail, synthImageBase + 0x9500)
check(
  'disasm: an address in a bss-like section\'s uninitialised tail (virtualSize > rawSize) has no file bytes, not a wrong offset',
  bssTailMiss === null,
  bssTailMiss
)

const hexLines = formatHexDump(Buffer.from(Array.from({ length: 16 }, (_, i) => i)), 0x600, 0x602)
check('disasm: the byte at the marked offset is bracketed in the hex dump', hexLines[0]?.includes('[02]'), hexLines)

// --- the register dump and stack dump Mod Loader's own handler writes -------
const crashLogWithRegs = [
  'Opening file for streaming "MODELS\\GTA3.IMG"',
  'Unhandled exception at 0x005B8E55 in module "gta_sa.exe"',
  'EXCEPTION_ACCESS_VIOLATION writing to 0x00000024',
  'Register dump:',
  'EAX=00000000 EBX=00892400 ECX=FFFFFFFF EDX=00000001',
  'ESI=00000000 EDI=00000000 EBP=0028F914 ESP=0028F8FC EIP=005B8E55',
  '',
  'Stack dump:',
  '0028F8FC  00 00 00 00 01 00 00 00',
  '0028F904  00 00 00 00 00 00 00 00',
  '',
  'Backtrace:',
  '  0x005B8E55 gta_sa.exe CStreaming::RequestModelStream',
  '  0x004C0C63 gta_sa.exe CStreaming::LoadAllRequestedModels',
  '',
  '--------------------------------'
].join('\r\n')
const regCrash = parseCrashDump(crashLogWithRegs)
check('modloader.log: a register dump is parsed, ECX included', regCrash?.registers.ECX === '0xFFFFFFFF', regCrash?.registers)
check('modloader.log: every register on the line is parsed, not just the first', regCrash?.registers.EIP === '0x005B8E55', regCrash?.registers)
check(
  'modloader.log: the stack dump is kept, separate from the backtrace',
  regCrash?.stack.length === 2 && regCrash?.stack[0].startsWith('0028F8FC'),
  regCrash?.stack
)
check(
  'modloader.log: the backtrace still reads correctly with a register and stack dump present',
  regCrash?.backtrace.length === 2,
  regCrash?.backtrace
)
check('modloader.log: a dump with no register block reports no registers', mlCrash?.registers && Object.keys(mlCrash.registers).length === 0, mlCrash?.registers)

// --- fsx.walk: a cycle guard that does not hide a second live mount ---------
// storeKey() is slug+version+variant, so two installs of the same mod+version
// share ONE store folder and materialise as two junctions onto it. A guard that
// logged every realpath ever visited entered the first junction and returned
// immediately on the second, so a file genuinely present at a second
// game-relative path was never enumerated, never hashed, never reported.
const twinTarget = path.join(tmp, 'walk-store', 'open-limit-adjuster')
fs.mkdirSync(twinTarget, { recursive: true })
fs.writeFileSync(path.join(twinTarget, 'III.VC.SA.LimitAdjuster.asi'), 'MZ-twin')
const twinTree = path.join(tmp, 'walk-twin', 'modloader')
fs.mkdirSync(twinTree, { recursive: true })
await createJunction(path.join(twinTree, 'Alpha Mod'), twinTarget)
await createJunction(path.join(twinTree, 'Beta Mod'), twinTarget)
const twinWalk = (await walk(twinTree)).map((f) => f.rel.toLowerCase()).sort()
check(
  'walk: two junctions onto the same store folder are both walked, not collapsed into one',
  twinWalk.length === 2 &&
    twinWalk[0] === 'alpha mod/iii.vc.sa.limitadjuster.asi' &&
    twinWalk[1] === 'beta mod/iii.vc.sa.limitadjuster.asi',
  twinWalk
)
await removeLinkOrDir(path.join(twinTree, 'Alpha Mod'))
await removeLinkOrDir(path.join(twinTree, 'Beta Mod'))

// ...and the guard still terminates, without the same physical file coming back
// as a copy of itself: a junction onto its own parent is descent, not a mount.
const loopRoot = path.join(tmp, 'walk-loop')
fs.mkdirSync(loopRoot, { recursive: true })
fs.writeFileSync(path.join(loopRoot, 'plugin.asi'), 'MZ-loop')
await createJunction(path.join(loopRoot, 'self'), loopRoot)
const loopWalk = (await walk(loopRoot)).map((f) => f.rel.toLowerCase())
check(
  'walk: a junction that loops back on its own parent terminates, and the file is reported once',
  loopWalk.length === 1 && loopWalk[0] === 'plugin.asi',
  loopWalk
)
await removeLinkOrDir(path.join(loopRoot, 'self'))

// --- the scan roots: nested roots are dropped before the walk, not after ----
// The game-root fallback recurses, unlike the shallow `?? game.path` reads
// elsewhere, so scripts\, cleo\ and modloader\ being INSIDE the root would
// otherwise mean walking the same subtrees twice on every health check.
const gameRootForRoots = path.join('C:', 'Games', 'GTA San Andreas')
const detectedRoots = scanRoots(gameRootForRoots, path.join(gameRootForRoots, 'scripts'))
check(
  'scan roots: with the ASI directory detected, scripts\\ is not listed twice',
  detectedRoots.length === 3 && detectedRoots[0] === path.join(gameRootForRoots, 'scripts'),
  detectedRoots
)
const fallbackRoots = scanRoots(gameRootForRoots, null)
check(
  'scan roots: with no ASI directory detected, the game root swallows the nested ones - one walk, not four',
  fallbackRoots.length === 1 && fallbackRoots[0] === gameRootForRoots,
  fallbackRoots
)

// --- field audit item 11: the binary decides where an .asi's data goes -------
// VHud.asi carries "VHud\data\blips.dat" and "VHud\fonts\%s". Those are
// relative paths, GTA's working directory is the GAME ROOT, and Mod Loader does
// not change it - so the data has to exist at <game root>\VHud\, whatever
// folder the .asi itself is installed into. Splitting the two is what printed
// "No handler or callme" for ~250 files and left the HUD absent.
{
  const dataRoot = path.join(tmp, 'asi-data-root')
  const put = (rel: string, content: Buffer | string = 'x'): void => {
    const p = path.join(dataRoot, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  put(
    'VHud.asi',
    pe(
      [`VHud${BS}data${BS}blips.dat`, `VHud${BS}blips`, `VHud${BS}map`, 'VHud.ini'],
      [`VHud${BS}fonts${BS}%s`, 'SilentPatch is installed.']
    )
  )
  put('VHud/data/blips.dat')
  put('VHud/fonts/pricedown.txd')
  put('VHud/blips/radar_ammu.png')

  const out = await classifyTree(dataRoot, { asiRelative: 'scripts', readmes: [], fallbackName: 'VHud' }, {})
  const to = (needle: string): string | undefined =>
    out.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative

  check(
    'field audit 11: the .asi is never lifted away from its own files',
    to('VHud.asi') === 'modloader/VHud/VHud.asi',
    to('VHud.asi')
  )
  check(
    'field audit 11: a file the binary names by relative path is installed at the game root',
    to('VHud/data/blips.dat') === 'VHud/data/blips.dat',
    to('VHud/data/blips.dat')
  )
  check(
    'field audit 11: a UTF-16 string ("VHud\\fonts\\%s") places the folder it enumerates too',
    to('VHud/fonts/pricedown.txd') === 'VHud/fonts/pricedown.txd',
    to('VHud/fonts/pricedown.txd')
  )
  check(
    'field audit 11: a folder the binary names without a file ("VHud\\blips") goes with it',
    to('VHud/blips/radar_ammu.png') === 'VHud/blips/radar_ammu.png',
    to('VHud/blips/radar_ammu.png')
  )
  check(
    'field audit 11: none of the data is left where the plugin cannot reach it',
    !out.files.some((f) => f.targetRelative.toLowerCase().startsWith('modloader/vhud/') && !/\.asi$/i.test(f.targetRelative)),
    out.files.map((f) => f.targetRelative)
  )
  check(
    'field audit 11: the install says which string in the binary decided it',
    out.warnings.some((w) => w.code === 'asi-data-root' && (w.detail ?? '').includes(`VHud${BS}data${BS}blips.dat`)),
    out.warnings.filter((w) => w.code === 'asi-data-root').map((w) => w.detail)
  )
  check(
    'field audit 11: reading the plugin is not thrown away - the caller gets the evidence back',
    out.asiEvidence['VHud.asi']?.rootFolder === 'VHud',
    Object.keys(out.asiEvidence)
  )

  // A readme is an instruction and this is an inference, so a readme that says
  // something genuinely different wins. But "extract the VHud folder into
  // modloader" is the DEFAULT placement, not a contradiction - it is the most
  // common line in the corpus and the only destination readme.ts ever attaches
  // a folder name to. Reading it as a conflict would veto the whole feature and
  // put VHud straight back to "No handler or callme".
  const readme = (destination: ReadmeParse['instructions'][number]['destination'], line: string): ReadmeParse =>
    ({
      file: 'leiame.txt',
      raw: line,
      instructions: [{ folder: 'VHud', destination, line }],
      declared: [],
      variantHints: []
    }) as unknown as ReadmeParse

  const boilerplate = await classifyTree(
    dataRoot,
    {
      asiRelative: 'scripts',
      readmes: [readme('modloader-folder', 'Coloque a pasta VHud na pasta modloader')],
      fallbackName: 'VHud'
    },
    {}
  )
  const boilerplateTo = (needle: string): string | undefined =>
    boilerplate.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative
  check(
    'field audit 11: ordinary "put the folder in modloader" boilerplate does not veto the binary',
    boilerplateTo('VHud/data/blips.dat') === 'VHud/data/blips.dat',
    boilerplateTo('VHud/data/blips.dat')
  )
  check(
    'field audit 11: and no conflict is invented out of the default placement',
    !boilerplate.warnings.some((w) => w.code === 'asi-data-readme'),
    boilerplate.warnings.map((w) => w.code)
  )

  // A readme that really does send the folder somewhere else is a different
  // thing, and it wins - loudly.
  const contradicts = await classifyTree(
    dataRoot,
    {
      asiRelative: 'scripts',
      readmes: [readme('asi-plugin', 'Coloque a pasta VHud na pasta scripts')],
      fallbackName: 'VHud'
    },
    {}
  )
  const contradictsTo = (needle: string): string | undefined =>
    contradicts.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative
  check(
    'field audit 11: a readme that sends the folder somewhere else outranks the binary',
    contradictsTo('VHud/data/blips.dat') === 'modloader/VHud/data/blips.dat',
    contradictsTo('VHud/data/blips.dat')
  )
  check(
    'field audit 11: and that disagreement is surfaced rather than swallowed',
    contradicts.warnings.some((w) => w.code === 'asi-data-readme'),
    contradicts.warnings.map((w) => w.code)
  )
}

// Two plugins in one undifferentiated pile: there is no way to tell whose data
// is whose, so neither gets to move the other's files.
{
  const pile = path.join(tmp, 'asi-pile')
  const put = (rel: string, content: Buffer | string = 'x'): void => {
    const p = path.join(pile, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  put('PluginA.asi', pe([`models${BS}x360btns.txd`, `models${BS}ps3btns.txd`]))
  put('PluginB.asi', pe([`data${BS}handling.cfg`, `data${BS}peds.ide`]))
  put('models/x360btns.txd')
  put('data/handling.cfg')

  const out = await classifyTree(pile, { asiRelative: 'scripts', readmes: [], fallbackName: 'Two Plugins' }, {})
  const to = (needle: string): string | undefined =>
    out.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative
  check(
    'field audit 11: with two plugins sharing one pile, neither relocates the other\'s files',
    to('models/x360btns.txd') === 'modloader/Two Plugins/models/x360btns.txd' &&
      to('data/handling.cfg') === 'modloader/Two Plugins/data/handling.cfg',
    [to('models/x360btns.txd'), to('data/handling.cfg')]
  )
  check(
    'field audit 11: and no placement is claimed for a pile it could not read',
    !out.warnings.some((w) => w.code === 'asi-data-root'),
    out.warnings.map((w) => w.code)
  )
}

// A bare loader in the pile is not read at all, and does not stop the plugin
// that does own the data from being placed by its own strings.
{
  const pile = path.join(tmp, 'asi-pile-loader')
  const put = (rel: string, content: Buffer | string = 'x'): void => {
    const p = path.join(pile, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  put('GInputSA.asi', pe([`models${BS}x360btns.txd`, `models${BS}pcbtns.txd`]))
  put('SilentPatchSA.asi', pe([`models${BS}x360btns.txd`]))
  put('models/x360btns.txd')

  const out = await classifyTree(pile, { asiRelative: 'scripts', readmes: [], fallbackName: 'GInput' }, {})
  const to = (needle: string): string | undefined =>
    out.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative
  check(
    'field audit 11: a bare loader beside the plugin is not read, so the plugin still places its own data',
    to('models/x360btns.txd') === 'models/x360btns.txd',
    to('models/x360btns.txd')
  )
  check(
    'field audit 11: and the bare loader was never probed',
    out.asiEvidence['SilentPatchSA.asi'] === undefined,
    Object.keys(out.asiEvidence)
  )
}

// GInput is the same rule with a vanilla folder name: its strings name
// models\x360btns.txd and friends, and without them at <game root>\models\ it
// prints "GInput could not load pad button textures... The game will now close."
{
  const ginput = path.join(tmp, 'ginput')
  const put = (rel: string, content: Buffer | string = 'x'): void => {
    const p = path.join(ginput, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  const pads = ['x360btns.txd', 'ps3btns.txd', 'sixaxis.txd', 'pcbtns.txd']
  put(
    'GInputSA.asi',
    pe(
      [...pads.map((n) => `models${BS}${n}`), 'GInput could not load pad button textures.', 'GInput.ini'],
      [`models${BS}x360btns.txd`]
    )
  )
  for (const n of pads) put(`models/${n}`)
  put('GInput.ini', '[Main]')

  const out = await classifyTree(ginput, { asiRelative: 'scripts', readmes: [], fallbackName: 'GInput' }, {})
  const to = (needle: string): string | undefined =>
    out.files.find((f) => f.sourcePath.toLowerCase().endsWith(needle.toLowerCase()))?.targetRelative
  check(
    'field audit 11: GInput\'s pad textures land at <game root>\\models\\',
    pads.every((n) => to(`models/${n}`) === `models/${n}`),
    pads.map((n) => to(`models/${n}`))
  )
  check(
    'field audit 11: and they are installed as game-root files, not mod-folder assets',
    out.files.filter((f) => /btns\.txd$|sixaxis\.txd$/i.test(f.targetRelative)).every((f) => f.destination === 'root-file'),
    out.files.map((f) => `${f.targetRelative}:${f.destination}`)
  )
  check(
    'field audit 11: the .asi stays in its mod folder even when its data leaves',
    to('GInputSA.asi') === 'modloader/GInput/GInputSA.asi',
    to('GInputSA.asi')
  )
  check(
    'field audit 11: a config the binary does not name by path is left beside the plugin',
    to('GInput.ini') === 'modloader/GInput/GInput.ini',
    to('GInput.ini')
  )
}

// The placement rule itself, without touching a disk.
check(
  'asi data: a path the plugin never names is left alone',
  gameRootPlacements([`models${BS}x360btns.txd`], 'GInput', ['data/handling.cfg']).length === 0
)
check(
  'asi data: a drive-absolute string from the author\'s machine is ignored',
  gameRootPlacements([`C:${BS}dev${BS}VHud${BS}data${BS}x.dat`], 'VHud', ['data/x.dat']).length === 0
)
check(
  'asi data: the plugin\'s own folder name in front of the path is understood',
  gameRootPlacements([`VHud${BS}data${BS}blips.dat`], 'VHud', ['data/blips.dat'])[0]?.rootTarget === 'VHud/data/blips.dat'
)
check(
  'asi data: casing in the binary does not have to match the archive',
  gameRootPlacements([`MODELS${BS}X360BTNS.TXD`], 'GInput', ['models/x360btns.txd'])[0]?.rootTarget === 'models/x360btns.txd'
)


// --- the launch gate -------------------------------------------------------
// `HealthReport.blocking` was computed on every health run and consulted by
// nobody: the panel named the 13500 MB stream.ini as blocking and the Play
// button beside it started the game anyway. The gate is pure on purpose - it
// takes a report and returns a decision - so this is the whole contract.
function healthCheckRow(id: string, status: HealthCheck['status'], summary: string): HealthCheck {
  return { id, title: id.toUpperCase(), status, summary }
}
function healthReportOf(checks: HealthCheck[]): HealthReport {
  return {
    generatedAt: new Date().toISOString(),
    profileId: 1,
    gamePath: 'C:\Games\GTA San Andreas',
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
    blocking: checks.filter((c) => c.status === 'fail').length,
    warnings: checks.filter((c) => c.status === 'warn').length
  }
}

const blockedReport = healthReportOf([
  healthCheckRow('exe', 'pass', 'v1.0 US'),
  healthCheckRow('stream-ini', 'fail', 'stream.ini asks for 13500 MB with no limit adjuster'),
  healthCheckRow('fps-cap', 'warn', 'frame limit is 120')
])
const blockedVerdict = launchGate(blockedReport)
check(
  'launch gate: a report with a blocking finding refuses the launch',
  blockedVerdict.allowed === false && blockedVerdict.blockers.length === 1 && blockedVerdict.blockers[0].id === 'stream-ini',
  blockedVerdict
)
check(
  'launch gate: the refusal names the finding instead of counting it',
  describeBlockers(blockedVerdict.blockers).includes('13500 MB') && blockedVerdict.warnings === 1,
  describeBlockers(blockedVerdict.blockers)
)

const warnOnlyVerdict = launchGate(
  healthReportOf([
    healthCheckRow('fps-cap', 'warn', 'frame limit is 120'),
    healthCheckRow('textures', 'warn', '3 non-power-of-two textures'),
    healthCheckRow('loose-files', 'warn', '900 loose files')
  ])
)
check(
  'launch gate: warnings alone never block - a warning nobody can click past is a warning nobody reads',
  warnOnlyVerdict.allowed === true && warnOnlyVerdict.blockers.length === 0 && warnOnlyVerdict.warnings === 3,
  warnOnlyVerdict
)

const cleanVerdict = launchGate(
  healthReportOf([
    healthCheckRow('exe', 'pass', 'v1.0 US'),
    healthCheckRow('modloader-log', 'skip', 'no log yet'),
    healthCheckRow('write-access', 'unknown', 'not checked this run: the game is open')
  ])
)
check(
  'launch gate: a clean report launches, and an unanswered check is not a finding',
  cleanVerdict.allowed === true && cleanVerdict.blockers.length === 0,
  cleanVerdict
)
check('launch gate: no report at all does not invent a refusal', launchGate(null).allowed === true)

// Task 7 blocks on an unsatisfied hard dependency through this same list
// rather than through a second gate of its own.
const extra: LaunchBlocker = { id: 'dependency:silentpatch', title: 'SilentPatch', summary: 'required and not installed' }
const extraVerdict = launchGate(healthReportOf([healthCheckRow('exe', 'pass', 'v1.0 US')]), [extra])
check(
  'launch gate: a reason from outside the health report refuses exactly like a failing check',
  extraVerdict.allowed === false && extraVerdict.blockers.length === 1 && extraVerdict.blockers[0].id === 'dependency:silentpatch',
  extraVerdict
)
check(
  'launch gate: blockersFromReport keeps report order and drops everything that is not a fail',
  blockersFromReport(blockedReport).map((b) => b.id).join(',') === 'stream-ini',
  blockersFromReport(blockedReport)
)

// --- CLEO, per plugin ------------------------------------------------------
// The rule used to be one hardcoded line: CLEO+ needs 4.4. Against CLEO 4.3
// CLEO+ throws "The ordinal 22 could not be located in the dynamic link
// library CLEO+.cleo" before the menu appears - and that case has to keep
// working while a plugin nobody wrote code for is covered by its own declared
// requirement.
const cleoPlus43 = cleoPluginRequirements([{ path: 'CLEO/CLEO+.cleo' }], '4.3')
check(
  'cleo: CLEO+ against CLEO 4.3 fails the check (the ordinal-22 dialog)',
  cleoPlus43.length === 1 && cleoPlus43[0].satisfied === false && cleoPlus43[0].range === '>=4.4' &&
    cleoRequirementStatus(cleoPlus43) === 'fail',
  cleoPlus43
)
const cleoPlus44 = cleoPluginRequirements([{ path: 'cleo/cleo+.cleo' }], '4.4.4')
check(
  'cleo: CLEO+ against CLEO 4.4.4 passes',
  cleoPlus44.length === 1 && cleoPlus44[0].satisfied === true && cleoRequirementStatus(cleoPlus44) === 'pass',
  cleoPlus44
)
const futurePlugin = cleoPluginRequirements(
  [{ path: 'cleo/SomethingNobodyWroteCodeFor.cleo', declaredRanges: ['>= 5.0'] }],
  '4.4.4'
)
check(
  'cleo: a plugin the app has never heard of is gated by its own declared requirement, with no code change',
  futurePlugin.length === 1 && futurePlugin[0].source === 'declared' && futurePlugin[0].satisfied === false &&
    cleoRequirementStatus(futurePlugin) === 'fail',
  futurePlugin
)
const perPlugin = cleoPluginRequirements(
  [
    { path: 'cleo/CLEO+.cleo' },
    { path: 'cleo/SilentPatchSA.cleo' },
    { path: 'cleo/cleo_plus.ini' },
    { path: 'cleo/script.cs' }
  ],
  '4.3'
)
check(
  'cleo: every .cleo plugin is judged on its own, and non-plugin files in cleo\ are not',
  perPlugin.length === 1 && perPlugin[0].name === 'CLEO+',
  perPlugin
)
const declaredWins = cleoPluginRequirements([{ path: 'cleo/CLEO+.cleo', declaredRanges: ['>=4.3'] }], '4.3')
check(
  'cleo: what the plugin declares outranks the built-in fallback',
  declaredWins.length === 1 && declaredWins[0].source === 'declared' && declaredWins[0].satisfied === true,
  declaredWins
)
const unreadableCleo = cleoPluginRequirements([{ path: 'cleo/CLEO+.cleo' }], null)
check(
  'cleo: an unreadable CLEO version is unknown, never fine',
  unreadableCleo[0].satisfied === null && cleoRequirementStatus(unreadableCleo) === 'warn',
  unreadableCleo
)
check(
  'cleo: version ranges still compare the way the resolver compared them',
  satisfiesRange('4.4.4', '>=4.4') && !satisfiesRange('4.3', '>=4.4') && satisfiesRange('4.3', null),
  null
)

// --- how the mod is switched on, and what happens when nobody could read the
// --- readme at all ------------------------------------------------------------
// A script that installs perfectly and then sits there because a code has to be
// typed in-game looks exactly like a script that failed to install.
const activationBytes = iconv.encode(
  [
    'Mod de teste - ativação',
    '',
    'Extraia a pasta "Ammu Tags" para a pasta do ModLoader.',
    'Para ativar o mod, digite "TAGS" durante o jogo (não precisa pausar).',
    'Pressione F5 para abrir o menu de opções.'
  ].join(CRLF),
  'win1252'
)
const activationDecoded = decodeReadme(activationBytes)
const activationParse = parseReadmeText('Leiame (ou morra).txt', activationDecoded.text, activationDecoded.encoding)
check(
  'readme: the activation code is pulled out of the prose',
  activationParse.activationCodes.length === 1 && activationParse.activationCodes[0].code === 'TAGS',
  activationParse.activationCodes
)
check(
  'readme: the cp1252 line around the code survives with its accents',
  activationParse.activationCodes[0]?.line.includes('não precisa pausar'),
  activationParse.activationCodes[0]
)
check(
  'readme: a keypress is not read as an activation code',
  !activationParse.activationCodes.some((a) => a.code === 'F5'),
  activationParse.activationCodes
)
const activationEn = parseReadmeText(
  'Readme (or die).txt',
  ['Extract the folder "Ammu Tags" to the modloader folder.', 'Type the code AEZAKMI in game to enable it.'].join(CRLF),
  'ascii'
)
check(
  'readme: the English phrasing yields the same shape of code',
  activationEn.activationCodes.length === 1 && activationEn.activationCodes[0].code === 'AEZAKMI',
  activationEn.activationCodes
)
check(
  'readme: an install instruction is not mistaken for an activation code',
  parsedReadme.activationCodes.length === 0,
  parsedReadme.activationCodes
)
check(
  'readme: "digite o nome do arquivo" names no code',
  extractActivationCodes('Digite o nome do arquivo e aperte enter.').length === 0,
  extractActivationCodes('Digite o nome do arquivo e aperte enter.')
)

// An archive that ships a readme nobody could parse is where silent guessing
// has put files in the wrong place before: it has to ask first.
const proseOnly = parseReadmeText(
  'Leiame (ou morra).txt',
  ['Obrigado por baixar meu mod!', 'Qualquer dúvida, comente no post.'].join(CRLF),
  'windows-1252'
)
const proseWarning = unparsedReadmeWarning([proseOnly])
check(
  'readme: a readme that parses to nothing raises the ask-first warning',
  proseWarning?.code === 'readme-unparsed' && proseWarning?.severity === 'warn',
  proseWarning
)
check(
  'readme: the warning names the file it could not read',
  !!proseWarning?.message.includes('Leiame (ou morra).txt') && !proseWarning.message.includes('messages.install'),
  proseWarning?.message
)
check(
  'readme: a readme that DOES parse raises no such warning',
  unparsedReadmeWarning([parsedReadme]) === null,
  unparsedReadmeWarning([parsedReadme])
)
check(
  'readme: one readable readme beside an unreadable one is enough',
  unparsedReadmeWarning([proseOnly, parsedReadme]) === null,
  unparsedReadmeWarning([proseOnly, parsedReadme])
)
check('readme: no readme at all is not this warning', unparsedReadmeWarning([]) === null)

// The gate itself, read from the plan's own warnings so the dialog and
// applyPlan can never disagree about when to ask.
check(
  'ask first: a plan carrying the warning needs an acknowledgement',
  needsReadmeAcknowledgement([proseWarning!]),
  proseWarning
)
check(
  'ask first: a plan without it does not',
  !needsReadmeAcknowledgement([{ severity: 'info', code: 'no-readme', message: 'x' }]),
  null
)
check('ask first: and an empty plan does not', !needsReadmeAcknowledgement([]))

// --- activation phrasings, each against the real corpus ----------------------
// Every phrasing below is quoted from index/sa.json, this project's own scrape
// of MixMods. A phrasing that reads plausibly and appears nowhere in the corpus
// is an invented format, which is the thing this parser exists not to do.
const corpusLine = (line: string): string[] => extractActivationCodes(line).map((a) => a.code)
check(
  'activation: "Para ativar digite “CLAYMORE”" (gta-sa-mod-claymore)',
  corpusLine('As imagens mostram como funciona. Para ativar digite “CLAYMORE” ele irá funcionar como uma mina.')[0] ===
    'CLAYMORE'
)
check(
  'activation: "Digitando “TIMESTOP” o relógio do jogo vai parar." (timestop)',
  corpusLine('Digitando “TIMESTOP” o relógio do jogo vai parar. Digite de novo para voltar.')[0] === 'TIMESTOP'
)
check(
  'activation: "digitar (como cheat) “BKMR1”" - the parenthetical does not hide the code',
  corpusLine('Durante o jogo, você pode digitar (como cheat) “BKMR1” até “BKMR9” para adicionar o marcador.')[0] ===
    'BKMR1'
)
check(
  'activation: "Basta digitar WEST para ligar" - unquoted, mid-sentence',
  corpusLine('Basta digitar WEST para ligar e WESTO para desligar')[0] === 'WEST'
)
check(
  'activation: "Basta escrever “FPS” e o mod se ativará." (first-person mod)',
  corpusLine('Este mod cleo deixa o seu GTA SA um verdadeiro FPS. Basta escrever “FPS” e o mod se ativará.')[0] ===
    'FPS'
)
check(
  'activation: "type" is the English mirror, for the Readme (or die).txt half',
  corpusLine('Type the code AEZAKMI in game to enable it.')[0] === 'AEZAKMI'
)
// The corpus's own counter-examples for the phrasings that were dropped or that
// carry a risk of firing on prose.
check(
  'activation: "“Escreva-se” no canal" is subscribe, not a code',
  corpusLine('Como o Lord diz… “Escreva-se” no canal para ajudar, e “siganos no twister” tbm: @Modjogos') .length === 0,
  corpusLine('Como o Lord diz… “Escreva-se” no canal para ajudar')
)
check(
  'activation: "se você escrever UU." is a mark on the map, not a code',
  corpusLine('Um dos mais estranhos mistérios sobre esse UU. é que se você escrever UU.').length === 0,
  corpusLine('Um dos mais estranhos mistérios sobre esse UU. é que se você escrever UU.')
)
check(
  'activation: "pressione Enter para aceitar" is a key, not a code',
  corpusLine('Agora você precisa pressionar Enter para aceitar (não é mais automático).').length === 0
)
check(
  'activation: the corpus noun "Type" yields nothing - Infernus Type R, Type 99 LMG',
  corpusLine('Gewehr 43 ZF Scoped; Type 5; Type 99 LMG; Johnson M1 | Infernus Type R | infernus-type-r').length === 0,
  corpusLine('Gewehr 43 ZF Scoped; Type 5; Type 99 LMG; Johnson M1 | Infernus Type R | infernus-type-r')
)
check(
  'activation: an HTML attribute is not an instruction',
  corpusLine('<span data-mce-type="bookmark" style="display: inline-block; width: 0px;">').length === 0,
  corpusLine('<span data-mce-type="bookmark" style="display: inline-block;">')
)

// And the whole corpus at once: what it yields has to be codes, not prose.
const corpusPath = path.join(process.cwd(), 'index', 'sa.json')
if (fs.existsSync(corpusPath)) {
  const strings: string[] = []
  const harvest = (node: unknown): void => {
    if (typeof node === 'string') strings.push(node)
    else if (Array.isArray(node)) node.forEach(harvest)
    else if (node && typeof node === 'object') Object.values(node).forEach(harvest)
  }
  harvest(JSON.parse(fs.readFileSync(corpusPath, 'utf8')))
  const corpusCodes = strings.flatMap((s) => extractActivationCodes(s).map((a) => a.code))
  const unique = [...new Set(corpusCodes)]
  check(
    'activation: the real corpus yields the codes its posts actually state',
    ['CLAYMORE', 'TIMESTOP', 'BKMR1', 'FPS', 'WEST', 'CHROMAKEY', 'AEZAKMI'].every((c) => unique.includes(c)),
    unique
  )
  check(
    'activation: and nothing else - every hit in 2.4 MB of posts is a code',
    unique.length <= 24 && unique.every((c) => c === c.toUpperCase() && c.length >= 3),
    unique
  )
}


// --- the pre-launch report cache -------------------------------------------
// Pressing Play is the most latency-sensitive thing in the app, and the gate
// needs a report to consult. Reuse is what keeps the gate from being torn out
// for making Play slow - so reuse has to be indistinguishable from a re-run.
const stampKey = reportKey('C:\Games\GTA San Andreas', 7)
const stampNow = 1_700_000_000_000
const stamp = { at: stampNow, key: stampKey, fingerprint: 'i:3/2/9;s:1234/40;s:-' }
check(
  'report cache: a fresh report for the same profile and the same state is reused',
  reportIsReusable(stamp, stampKey, stamp.fingerprint, stampNow + 5_000) === true
)
check(
  'report cache: a report for another profile never answers for this one',
  reportIsReusable(stamp, reportKey('C:\Games\GTA San Andreas', 8), stamp.fingerprint, stampNow + 5_000) === false
)
check(
  'report cache: a mod installed or toggled since makes it a different answer',
  reportIsReusable(stamp, stampKey, 'i:4/3/10;s:1234/40;s:-', stampNow + 5_000) === false
)
check(
  'report cache: a rewritten stream.ini invalidates it at once, not at the end of the TTL',
  reportIsReusable(stamp, stampKey, 'i:3/2/9;s:9999/38;s:-', stampNow + 5_000) === false,
  null
)
check(
  'report cache: past the age backstop it re-runs, for the inputs no fingerprint can see',
  reportIsReusable(stamp, stampKey, stamp.fingerprint, stampNow + REPORT_MAX_AGE_MS + 1) === false
)
check(
  'report cache: no stored report, and a clock that went backwards, are both "re-run"',
  reportIsReusable(null, stampKey, stamp.fingerprint, stampNow) === false &&
    reportIsReusable(stamp, stampKey, stamp.fingerprint, stampNow - 1) === false
)
check(
  'report cache: the key is the game folder and the profile, case-insensitively',
  reportKey('C:\Games\GTA San Andreas', 7) === reportKey('c:\games\gta san andreas', 7) &&
    reportKey('C:\Games\GTA San Andreas', null) !== stampKey
)

// --- what the launch does with the report ----------------------------------
const blockedForDecision = healthReportOf([
  healthCheckRow('stream-ini', 'fail', 'stream.ini asks for 13500 MB with no limit adjuster'),
  healthCheckRow('fps-cap', 'warn', 'frame limit is 120')
])
check(
  'launch decision: without force, a standing blocker refuses',
  launchDecision({ force: false, report: blockedForDecision }).allowed === false
)
check(
  'launch decision: force is the user answering the refusal - it clears every blocker, not just the known ones',
  launchDecision({ force: true, report: blockedForDecision }).allowed === true &&
    launchDecision({ force: true, report: blockedForDecision }, [
      { id: 'dependency:silentpatch', title: 'SilentPatch', summary: 'required and not installed' }
    ]).allowed === true
)
check(
  'launch decision: a reason from outside the report still refuses when nothing is forced',
  launchDecision({ force: false, report: healthReportOf([healthCheckRow('exe', 'pass', 'v1.0 US')]) }, [
    { id: 'dependency:silentpatch', title: 'SilentPatch', summary: 'required and not installed' }
  ]).allowed === false
)
check(
  'launch decision: with no report and nothing forced, nothing is invented',
  launchDecision({ force: false, report: null }).allowed === true
)

// --- the dependency graph ---------------------------------------------------
// The reasoning lives in @shared/dependencyGraph so it can be exercised here,
// where there is no database and no Electron. Profile scope is not re-tested
// at this level: the function is handed one profile's installs and has no way
// to see another's.

const depGame: GameInstall = {
  id: -1,
  path: 'C:/nonexistent',
  label: 'unit',
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
  cleoVersion: '4.4.4',
  userFilesDir: '',
  sameVolumeAsStore: true,
  linkStrategy: 'hardlink',
  access: { writable: true, probedPath: 'C:/nonexistent', code: null, reason: null, needsElevation: false }
}

const depRow = (over: Partial<GraphDependencyRow>): GraphDependencyRow => ({
  kind: 'requires',
  targetModId: null,
  targetSlug: 'x',
  targetTitle: 'X',
  versionRange: null,
  altGroup: null,
  note: null,
  ...over
})

// 1. A provides edge answers a requirement. Somebody else's mod needs gsx.asi;
//    VehFuncs is installed and ships it; there is nothing to download.
const answeredByProvider = buildDependencyNodes({
  subjectSlug: 'some-vehicle-pack',
  subjectTitle: 'Some Vehicle Pack',
  rows: [depRow({ kind: 'requires', targetSlug: 'gsx.asi', targetTitle: 'gsx.asi' })],
  installed: [{ id: 1, slug: 'sa-vehfuncs', title: 'VehFuncs', versionLabel: '2.0', enabled: true }],
  providers: [{ artifact: 'gsx.asi', modSlug: 'sa-vehfuncs', modTitle: 'VehFuncs' }],
  game: depGame
})
check(
  'deps: a provides edge satisfies a requirement for the file it provides',
  answeredByProvider.length === 1 &&
    answeredByProvider[0].satisfied === true &&
    answeredByProvider[0].resolution === 'already-installed' &&
    /VehFuncs/.test(answeredByProvider[0].note ?? ''),
  answeredByProvider
)

// The regression itself: an unmodelled kind fell through to the requires
// branch, so VehFuncs reported a missing dependency called "gsx.asi".
const loneProvider = buildDependencyNodes({
  subjectSlug: 'sa-vehfuncs',
  subjectTitle: 'VehFuncs',
  rows: [depRow({ kind: 'provides', targetSlug: 'gsx.asi', targetTitle: 'gsx.asi', note: 'VehFuncs ships gsx.asi.' })],
  installed: [{ id: 1, slug: 'sa-vehfuncs', title: 'VehFuncs', versionLabel: '2.0', enabled: true }],
  providers: [{ artifact: 'gsx.asi', modSlug: 'sa-vehfuncs', modTitle: 'VehFuncs' }],
  game: depGame
})
check(
  'deps: a mod providing a file is never reported as missing that file',
  loneProvider.length === 1 &&
    loneProvider[0].kind === 'provides' &&
    loneProvider[0].resolution === 'ok' &&
    loneProvider[0].satisfied === true,
  loneProvider
)

// 2. Two providers of the same file is a conflict, not a provision.
const twoProviders = buildDependencyNodes({
  subjectSlug: 'sa-vehfuncs',
  subjectTitle: 'VehFuncs',
  rows: [depRow({ kind: 'provides', targetSlug: 'gsx.asi', targetTitle: 'gsx.asi' })],
  installed: [
    { id: 1, slug: 'sa-vehfuncs', title: 'VehFuncs', versionLabel: '2.0', enabled: true },
    { id: 2, slug: 'some-vehicle-pack', title: 'Some Vehicle Pack', versionLabel: '1.0', enabled: true }
  ],
  providers: [
    { artifact: 'gsx.asi', modSlug: 'sa-vehfuncs', modTitle: 'VehFuncs' },
    { artifact: 'GSX.asi', modSlug: 'some-vehicle-pack', modTitle: 'Some Vehicle Pack' }
  ],
  game: depGame
})
check(
  'deps: a second provider of the same file blocks, and the note names both mods',
  twoProviders.length === 1 &&
    twoProviders[0].resolution === 'blocking' &&
    twoProviders[0].satisfied === false &&
    /VehFuncs/.test(twoProviders[0].note ?? '') &&
    /Some Vehicle Pack/.test(twoProviders[0].note ?? ''),
  twoProviders
)

// The field report: Proper Shaders with neither SilentPatch nor Open Limit
// Adjuster in the profile. Both are hard requirements; both read as missing.
const shaderRows = [
  depRow({ targetSlug: 'sa-silentpatch', targetTitle: 'SilentPatch' }),
  depRow({ targetSlug: 'open-limit-adjuster', targetTitle: 'Open Limit Adjuster' })
]
const shortProfile = buildDependencyNodes({
  subjectSlug: 'sa-proper-shaders',
  subjectTitle: 'Proper Shaders',
  rows: shaderRows,
  installed: [],
  providers: [],
  game: depGame
})
check(
  'deps: an unsatisfied hard requirement is missing, and remembers which mod needs it',
  shortProfile.length === 2 && shortProfile.every((n) => n.resolution === 'missing' && n.requiredBy === 'Proper Shaders'),
  shortProfile
)
check(
  'deps: the same profile with those plugins loose in the ASI folder is not missing them',
  buildDependencyNodes({
    subjectSlug: 'sa-proper-shaders',
    subjectTitle: 'Proper Shaders',
    rows: shaderRows,
    installed: [],
    providers: [],
    evidence: ['SilentPatchSA.asi', 'OpenLimitAdjuster.asi'],
    game: depGame
  }).every((n) => n.resolution === 'already-installed')
)

// 4. The launch refusal, built from those nodes and handed to the one gate.
const depBlockers = dependencyLaunchBlockers(shortProfile, {
  requires: '{mod} needs {dep}, and this profile does not satisfy that',
  conflicts: '{mod} cannot run alongside {dep}',
  provides: '{dep} is supplied by {mod} and by another mod as well'
})
const depVerdict = launchGate(null, depBlockers)
check(
  'deps: an unsatisfied hard dependency refuses the launch through the same gate',
  depVerdict.allowed === false && depVerdict.blockers.length === 2,
  depVerdict
)
check(
  'deps: the refusal names what needs what, not just what is missing',
  describeBlockers(depVerdict.blockers).includes('Proper Shaders needs SilentPatch') &&
    describeBlockers(depVerdict.blockers).includes('Proper Shaders needs Open Limit Adjuster'),
  describeBlockers(depVerdict.blockers)
)
check(
  'deps: a satisfied graph is not a reason to refuse anything',
  launchGate(null, dependencyLaunchBlockers(loneProvider, { requires: '{mod}/{dep}', conflicts: '-', provides: '-' }))
    .allowed === true
)

// 3. Every seeded edge survives the load. `more-radar-icons requires cleoplus`
//    did not: the loader looked its SUBJECT up in the catalogue, found nothing
//    and dropped the row without a word. Both ends are slug-addressed now.
const seedFile = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'resources', 'seed', 'dependencies.json'), 'utf8')
) as { dependencies: CuratedDependencySeed[] }
const seedPlan = planCuratedDependencies(seedFile.dependencies)
check(
  'deps: every row of the seed file is loaded, none silently discarded',
  seedPlan.rows.length === seedFile.dependencies.length && seedPlan.rejected.length === 0,
  seedPlan.rejected
)
const seeded = (mod: string, kind: string, target: string): boolean =>
  seedPlan.rows.some((r) => r.modSlug === mod && r.kind === kind && r.target === target)
check(
  'deps: the dropped seed loads - More Radar Icons requires CLEO+ though it is not a catalogue entry',
  seeded('more-radar-icons', 'requires', 'cleoplus'),
  seedPlan.rows.filter((r) => r.modSlug === 'more-radar-icons')
)
check(
  'deps: the VehFuncs provision is loaded as a provision, not as a requirement',
  seeded('sa-vehfuncs', 'provides', 'gsx.asi')
)
check(
  'deps: the ItemFinders family is seeded against CLEO 4.4 and CLEO+ 1.0.7',
  ['itemfinders', 'tag-finder', 'horseshoe-finder', 'snapshot-finder', 'oyster-finder'].every(
    (m) =>
      seedPlan.rows.some((r) => r.modSlug === m && r.target === 'cleo' && r.versionRange === '>=4.4') &&
      seedPlan.rows.some((r) => r.modSlug === m && r.target === 'cleoplus' && r.versionRange === '>=1.0.7')
  ),
  seedPlan.rows.filter((r) => /finder/.test(r.modSlug))
)
check(
  'deps: an icon or texture pack is seeded against the base mod it overlays',
  seeded('weapon-icons-hd-repaint', 'requires', 'weapon-icons-txd') &&
    seeded('icones-de-armas-fieis-desenhos-corrigidos', 'requires', 'sa-weapon-icons-txd') &&
    seeded('proper-tattoos-retex-hd', 'requires', 'proper-player-retex')
)
const badSeed = planCuratedDependencies([
  { mod: 'a', kind: 'suggests', target: 'b' },
  { mod: 'c', kind: 'alt', target: 'd' },
  { mod: '', kind: 'requires', target: 'e' }
])
check(
  'deps: a kind no branch implements is reported, never turned into a phantom requirement',
  badSeed.rows.length === 0 && badSeed.rejected.length === 3 && /unknown kind "suggests"/.test(badSeed.rejected[0].reason),
  badSeed.rejected
)

// --- item 20: the Mod Loader mechanics that were still unencoded ------------
// Each of these is a documented rule of the loader whose failure looks like a
// broken mod rather than a misplaced file, so each one is a warning the user
// acts on - nothing below moves a single file on the user's behalf.
function mechTree(name: string, rels: string[]): string {
  const root = path.join(tmp, name)
  for (const rel of rels) {
    const p = path.join(root, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'x')
  }
  return root
}
const codesOf = async (root: string, fallbackName: string): Promise<string[]> =>
  (await classifyTree(root, { asiRelative: 'scripts', readmes: [], fallbackName }, {})).warnings.map((w) => w.code)

// Rule: a sprite .txd is only a sprite when it sits in a folder named "txd".
const spriteLoose = await codesOf(mechTree('sprite-loose', ['Clean HUD/hud.txd', 'Clean HUD/leiame.txt']), 'Clean HUD')
check('mechanics: a sprite .txd outside a folder named "txd" is flagged - Mod Loader never loads it', spriteLoose.includes('txd-sprite-missing-folder'), spriteLoose)
const spriteRight = await codesOf(mechTree('sprite-right', ['Clean HUD/txd/hud.txd']), 'Clean HUD')
check('mechanics: the same sprite inside a "txd" folder is not flagged', !spriteRight.includes('txd-sprite-missing-folder'), spriteRight)
check(
  'mechanics: a vehicle texture is not mistaken for a sprite by name',
  !mechOut.warnings.some((w) => w.code === 'txd-sprite-missing-folder'),
  mechOut.warnings.map((w) => w.code)
)

// Rule: a whole data file and a .txt line-installing into it never compose.
const dataMix = await codesOf(mechTree('data-mix', ['Fast Cars/data/handling.cfg', 'Fast Cars/data/handling.txt']), 'Fast Cars')
check('mechanics: a full handling.cfg shipped with a handling.txt line-install is flagged', dataMix.includes('data-file-mixed'), dataMix)
const dataWhole = await codesOf(mechTree('data-whole', ['Fast Cars/data/handling.cfg', 'Fast Cars/leiame.txt']), 'Fast Cars')
check('mechanics: a full data file on its own is fine, and a readme is not a line-install', !dataWhole.includes('data-file-mixed'), dataWhole)

// Rule: nodes#.dat is a member of an .img, so it needs a folder named after it.
const nodesLoose = await codesOf(mechTree('nodes-loose', ['New Roads/nodes12.dat']), 'New Roads')
check('mechanics: a loose nodes#.dat is flagged as needing a folder named after its .img', nodesLoose.includes('nodes-folder'), nodesLoose)
const nodesRight = await codesOf(mechTree('nodes-right', ['New Roads/gta3.img/nodes12.dat']), 'New Roads')
check('mechanics: the same nodes file inside gta3.img/ is not flagged', !nodesRight.includes('nodes-folder'), nodesRight)

// Rule: white or invisible cars and peds are a .dff and .txd won by different
// mods. Distinct from a starved streaming budget, which is not a priority
// problem at all and is why this check only ever fires on a demonstrated split.
const carPart = (installId: number, title: string, relativePath: string, priority: number, enabled = true): {
  installId: number
  title: string
  folder: string
  relativePath: string
  priority: number
  enabled: boolean
} => ({ installId, title, folder: title, relativePath, priority, enabled })

check('split model: a .dff/.txd pair is recognised whatever folder it sits in', modelStem('models/Infernus.DFF')?.stem === 'infernus', modelStem('models/Infernus.DFF'))
const splitModel = findSplitModels(
  [
    carPart(1, 'Cool Cars', 'models/infernus.dff', 50),
    carPart(1, 'Cool Cars', 'models/infernus.txd', 50),
    carPart(2, 'Shiny Paint', 'infernus.txd', 70)
  ],
  (c) => resolveWinner(c)
)
check(
  'mechanics: a model whose .dff and .txd resolve to different mods is reported',
  splitModel.length === 1 && splitModel[0].dff.title === 'Cool Cars' && splitModel[0].txd.title === 'Shiny Paint',
  splitModel
)
check(
  'mechanics: both mods are offered, because the fix is a priority change on either',
  splitModel[0]?.claimants.length === 2 && splitModel[0]?.shippedTogether[0]?.title === 'Cool Cars',
  splitModel[0]?.claimants.map((c) => c.title)
)
check(
  'mechanics: one mod winning both halves is not a split model',
  findSplitModels(
    [
      carPart(1, 'Cool Cars', 'models/infernus.dff', 70),
      carPart(1, 'Cool Cars', 'models/infernus.txd', 70),
      carPart(2, 'Shiny Paint', 'infernus.txd', 50)
    ],
    (c) => resolveWinner(c)
  ).length === 0
)
check(
  'mechanics: a retexture that never shipped a mesh is a deliberate pairing, not a split',
  findSplitModels([carPart(1, 'Mesh Pack', 'models/infernus.dff', 50), carPart(2, 'Retexture', 'infernus.txd', 70)], (c) =>
    resolveWinner(c)
  ).length === 0
)
check(
  'mechanics: a mod at priority 0 cannot split a model, because Mod Loader ignores it',
  findSplitModels(
    [
      carPart(1, 'Cool Cars', 'models/infernus.dff', 50),
      carPart(1, 'Cool Cars', 'models/infernus.txd', 50),
      carPart(2, 'Shiny Paint', 'infernus.txd', 0)
    ],
    (c) => resolveWinner(c)
  ).length === 0
)


// --- the fingerprint sees a variant swap ------------------------------------
// switchVariant rewrites only variant_choice (and variant_groups_json, which
// mirrors it) on a row the count/enabled-sum/max-id above already counted -
// so a preset swapped in right after a clean report was cached, one that ships
// a second limit adjuster or a .cleo plugin the installed CLEO is too old for,
// must still invalidate it. This is the regression: it fails the moment
// variant_choice is dropped from what the fingerprint reads.
check(
  'fingerprint: swapping a variant changes the fingerprint although nothing else does',
  installFingerprint([
    { id: 3, enabled: 1, variantChoice: 'lite' },
    { id: 7, enabled: 1, variantChoice: null }
  ]) !==
    installFingerprint([
      { id: 3, enabled: 1, variantChoice: 'full-fat' },
      { id: 7, enabled: 1, variantChoice: null }
    ])
)
check(
  'fingerprint: the same install rows, same choices, fingerprint the same',
  installFingerprint([
    { id: 3, enabled: 1, variantChoice: 'lite' },
    { id: 7, enabled: 0, variantChoice: null }
  ]) ===
    installFingerprint([
      { id: 3, enabled: 1, variantChoice: 'lite' },
      { id: 7, enabled: 0, variantChoice: null }
    ])
)
check(
  'fingerprint: row order does not matter, only which id chose what',
  installFingerprint([
    { id: 3, enabled: 1, variantChoice: 'lite' },
    { id: 7, enabled: 1, variantChoice: 'full-fat' }
  ]) ===
    installFingerprint([
      { id: 7, enabled: 1, variantChoice: 'full-fat' },
      { id: 3, enabled: 1, variantChoice: 'lite' }
    ])
)

// --- a variant swap is not a profile switch ---------------------------------
// Both write rows into `switch_journal`; only one of them is a previous state
// of the game folder. The functions that act on those rows reach SQLite and
// Electron and cannot be loaded here, so the DECISION they make is a pure
// module and it is tested directly: reverting any part of the fix makes one of
// these fail.
import { decideVariantRecovery, isRestorableProfileSwitch, journalKindOf } from '../src/shared/switchJournal'

const verifiedVariantSwap = { kind: journalKindOf({ kind: 'variant-swap' }), state: 'verified', restoredAt: null }
check(
  'journal: a completed variant swap is never offered as a restorable profile switch',
  !isRestorableProfileSwitch(verifiedVariantSwap),
  verifiedVariantSwap
)
check(
  'journal: nor is one that failed, which is the state a rolled-back swap can reach',
  !isRestorableProfileSwitch({ kind: 'variant-swap', state: 'failed', restoredAt: null })
)
check(
  'journal: a completed profile switch still is - the filter did not close the door on both',
  isRestorableProfileSwitch({ kind: 'profile-switch', state: 'verified', restoredAt: null }) &&
    isRestorableProfileSwitch({ kind: 'profile-switch', state: 'applied', restoredAt: null })
)
check(
  'journal: one already rolled back is not offered again',
  !isRestorableProfileSwitch({ kind: 'profile-switch', state: 'verified', restoredAt: '2026-01-01T00:00:00.000Z' })
)

// Persisted rows. `kind` only exists from schema 12; a row a previous build
// wrote must still read correctly, which is also exactly how the migration
// backfills the column.
check(
  'journal: a row written before the kind column, with no variant payload, reads as a profile switch',
  journalKindOf({ variant_swap_json: null }) === 'profile-switch' && journalKindOf({}) === 'profile-switch'
)
check(
  'journal: a row written before the kind column that carries a variant payload reads as a variant swap',
  journalKindOf({ variant_swap_json: '{"installId":4}' }) === 'variant-swap'
)

// Boot recovery must check BOTH ends of the swap. "Not landed" used to mean
// "still on the old option" with nothing checking it, so a journal left open
// across a boot could overwrite a later, fully-successful swap of the same
// group with the bytes from before it.
const swapRecord = { fromOptionId: 'Guard 2K', toOptionId: 'Guard 4K' }
check(
  'journal: the row naming the option the swap was going to means only re-link it',
  decideVariantRecovery(swapRecord, 'Guard 4K') === 'materialise-again'
)
check(
  'journal: the row still naming the option it was leaving means put those bytes back',
  decideVariantRecovery(swapRecord, 'Guard 2K') === 'restore-outgoing'
)
check(
  'journal: a later successful swap to a THIRD option is never overwritten by a stale journal',
  decideVariantRecovery(swapRecord, 'Guard 8K') === 'stand-down'
)
check(
  'journal: a group a reinstall reshaped away is stood down on, not restored over',
  decideVariantRecovery(swapRecord, undefined) === 'stand-down' && decideVariantRecovery(swapRecord, null) === 'stand-down'
)

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
