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
  parseDeclaredDependencies,
  parseReadmeText
} from '../src/main/install/readme'
import { classifyTree } from '../src/main/install/classify'
import { displaceForeign, isOwned, ownedKey } from '../src/main/store/displace'
import { describeFsError, isProtectedLocation } from '../src/main/game/access'
import { setMainLanguage } from '../src/main/util/i18n'
import { translate } from '../src/shared/i18n'
import { classifyDownload, looksLikeArchive, normalizeForFetch } from '../src/shared/download'
import { foldText, relevance } from '../src/shared/search'
import { requirementMet } from '../src/shared/requirements'
import { catalogKind } from '../src/shared/catalogKind'
import { parseCrashDump, parseModLoaderLog } from '../src/main/diagnostics/modloaderLog'
import { limitAdjusterNames, parseStreamIni, SAFE_STREAMING_MEMORY_MB } from '../src/main/game/streamIni'
import { pluginEvidence } from '../src/main/formats/strings'
import { assertGameNotRunning, gameExeNames, gameRunningVerdict, type RunningProcess } from '../src/main/game/running'
import { signatureForArchive } from '../src/main/knowledge/signature'

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
  !!displaced.backedUp && fs.existsSync(displaced.backedUp.backupPath),
  displaced
)
check(
  'ownedPaths: the backup holds exactly the bytes the user wrote',
  !!displaced.backedUp && fs.readFileSync(displaced.backedUp.backupPath, 'utf8') === userBytes
)
check(
  'ownedPaths: the user can find the displaced file in quarantine',
  !!displaced.quarantined && fs.existsSync(displaced.quarantined.quarantinePath),
  displaced.quarantined
)
check(
  'ownedPaths: the quarantine copy holds the bytes too',
  !!displaced.quarantined && fs.readFileSync(displaced.quarantined.quarantinePath, 'utf8') === userBytes
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
  ours.backedUp === null && ours.quarantined === null && !fs.existsSync(ourOwn),
  ours
)
check('ownedPaths: nothing was written to the backup directory', !fs.existsSync(path.join(displaceRoot, 'backup-owned')))

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

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
