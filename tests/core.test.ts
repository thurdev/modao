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
  unmappableInWin1252
} from '../src/main/game/modloaderIni'
import { groupIncidents, parseModuleName, resolveCrashAddress } from '../src/shared/crash'
import type { CrashReport } from '../src/shared/types'
import { decodeReadme, parseReadmeText } from '../src/main/install/readme'
import { classifyTree } from '../src/main/install/classify'
import { describeFsError, isProtectedLocation } from '../src/main/game/access'
import { classifyDownload, looksLikeArchive, normalizeForFetch } from '../src/shared/download'

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
check('access: EPERM names the path and the fix, not the syscall', epermText.includes('administrator') && epermText.includes('Program Files'), epermText)
check('access: the original errno is kept for bug reports', epermText.includes('EPERM'), epermText)
const busy = Object.assign(new Error('EBUSY'), { code: 'EBUSY', path: String.raw`D:\Games\GTA\gta_sa.exe` })
check('access: EBUSY tells the user to close the game', describeFsError(busy).includes('close GTA'), describeFsError(busy))
check('access: a folder outside Program Files is not flagged', !isProtectedLocation(String.raw`D:\Games\GTA San Andreas`))

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

fs.rmSync(tmp, { recursive: true, force: true })
console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
