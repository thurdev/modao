import type { IpcChannel } from '@shared/ipc'
import type { Progress } from '@shared/types'
import devCatalog from './devCatalog.json'

/**
 * A mock of the preload bridge, used ONLY by the renderer-only dev server
 * (`vite --config vite.renderer.config.ts`) so the interface can be worked on
 * in a browser. In the packaged app `window.modao` always exists and this
 * module does nothing: it is the fallback, never an override.
 */
const now = new Date().toISOString()

const PROFILES = [
  {
    id: 1,
    name: 'Main run',
    color: '#d8a657',
    notes: 'Adopted from the existing install.',
    createdAt: '2026-06-02T10:00:00.000Z',
    lastPlayedAt: '2026-09-20T22:14:00.000Z',
    isActive: true,
    modCount: 43,
    enabledCount: 39,
    totalSize: 6_281_367_552,
    saveCount: 4
  },
  {
    id: 2,
    name: 'Clean test bed',
    color: '#8ab0a0',
    notes: 'Vanilla plus SilentPatch, for reproducing crashes.',
    createdAt: '2026-08-14T09:30:00.000Z',
    lastPlayedAt: null,
    isActive: false,
    modCount: 3,
    enabledCount: 3,
    totalSize: 41_263_104,
    saveCount: 1
  }
]

const MODS = [
  ['VehFuncs', 'Junior_Djjr', 'modloader-folder', 70, 4_194_304, '2.2', 2, false],
  ['Proper Fixes', 'Junior_Djjr', 'modloader-folder', 55, 15_728_640, '1.4', 1, true],
  ['SilentPatch', 'Silent', 'asi-plugin', 50, 716_800, '1.11', 0, false],
  ['Loadscreens 2K Definitive', 'Junior_Djjr', 'modloader-folder', 80, 104_857_600, '2.0', 1, false],
  ['Weapon Icons HD Repaint', 'Community', 'overlay', 50, 2_097_152, '1.2', 0, false],
  ['More Radar Icons', 'Junior_Djjr', 'cleo-script', 50, 3_145_728, '2.1', 0, false],
  ['HD Ped Pack', 'Community', 'modloader-folder', 0, 524_288_000, '1.5', 3, false]
] as const

function installedMods(): unknown[] {
  return MODS.map((m, i) => ({
    installId: i + 1,
    modId: i + 1,
    modVersionId: i + 1,
    slug: String(m[0]).toLowerCase().replace(/\s+/g, '-'),
    title: m[0],
    author: m[1],
    sourceUrl: 'https://www.mixmods.com.br/',
    versionLabel: m[5],
    installedAt: '2026-09-01T12:00:00.000Z',
    destinationClass: m[2],
    variantChoice: m[0] === 'Loadscreens 2K Definitive' ? 'Loadscreens 2K Definitive' : null,
    enabled: m[3] !== 0,
    priority: m[3],
    fileCount: 42,
    size: m[4],
    conflictCount: m[6],
    updateAvailable: m[7],
    latestVersionLabel: m[7] ? '1.5' : null,
    subMods:
      m[0] === 'VehFuncs'
        ? [
            { relativePath: 'models', fileCount: 18, size: 2_400_000, enabled: true },
            { relativePath: 'optional dirt', fileCount: 6, size: 800_000, enabled: false }
          ]
        : []
  }))
}

function catalogMods(): unknown[] {
  // Real entries lifted from the bundled catalogue, so the dev server shows the
  // same prose, screenshots and paywall states the app actually renders.
  return devCatalog as unknown[]
}

const RESPONSES: Partial<Record<IpcChannel, unknown>> = {
  'app:settings': {
    theme: 'system',
    activeGameId: 1,
    catalogLastCrawl: null,
    telemetryEnabled: true,
    crawlEnabled: false,
    crawlMaxPages: 60,
    scanCrashesOnLaunch: true,
    autoSnapshotSaves: true
  },
  'app:version': { app: '1.0.0', electron: '33.4.11', node: '20.18.1' },
  'app:elevation': { running: false, needed: true, remembered: false, reason: null, protectedPath: true },
  'app:storage': {
    userData: 'C:\\Users\\You\\AppData\\Roaming\\modao',
    dbBytes: 2_097_152,
    storeBytes: 6_442_450_944,
    archivesBytes: 838_860_800,
    cacheBytes: 12_582_912,
    quarantineBytes: 104_857_600,
    snapshotBytes: 52_428_800
  },
  'game:list': [
    {
      id: 1,
      path: 'D:\\Games\\GTA San Andreas',
      label: 'GTA San Andreas',
      exeSize: 14_383_616,
      exeSha256: 'a'.repeat(64),
      exeTimestamp: 0x427101ca,
      isV1UsOriginal: true,
      largeAddressAware: false,
      asiDirectory: 'D:\\Games\\GTA San Andreas\\scripts',
      asiLoader: 'D:\\Games\\GTA San Andreas\\vorbisFile.dll',
      hasModLoader: true,
      modLoaderVersion: '0.3.7',
      cleoVersion: '4.4.4',
      userFilesDir: 'C:\\Users\\You\\Documents\\GTA San Andreas User Files',
      sameVolumeAsStore: false,
      linkStrategy: 'junction',
      access: {
        writable: false,
        probedPath: 'D:\Games\GTA San Andreas\modloader',
        code: 'EPERM',
        reason:
          'O Windows recusa escrita em D:\Games\GTA San Andreas\modloader porque está dentro do Program Files. ' +
          'Abra o Modão como administrador, ou mova o jogo para uma pasta fora do Program Files.',
        needsElevation: true
      }
    }
  ],
  'profiles:list': PROFILES,
  'catalog:seedInfo': { count: 20, lastCrawl: null, crawlEnabled: false },
  'saves:detectExisting': {
    found: true,
    path: 'C:\\Users\\You\\Documents\\GTA San Andreas User Files',
    slots: [
      { file: 'GTASAsf1.b', index: 1, size: 202_752, modifiedAt: '2026-09-18T20:02:00.000Z' },
      { file: 'GTASAsf3.b', index: 3, size: 202_752, modifiedAt: '2026-09-19T23:41:00.000Z' }
    ],
    sizeBytes: 421_888,
    hasSettings: true,
    importedIntoProfileId: null
  },
  'conflicts:list': [
    {
      relativePath: 'models/loadscs.txd',
      kind: 'modloader',
      claimants: [
        { installId: 4, modId: 4, title: 'Loadscreens 2K Definitive', priority: 80, enabled: true, size: 104_857_600, sha256: 'b'.repeat(64) },
        { installId: 7, modId: 7, title: 'HD Ped Pack', priority: 0, enabled: true, size: 52_428_800, sha256: 'c'.repeat(64) }
      ],
      winner: { installId: 4, modId: 4, title: 'Loadscreens 2K Definitive', priority: 80, enabled: true, size: 104_857_600, sha256: 'b'.repeat(64) },
      binaryNotes: ['HD Ped Pack: hud_bad is 300x128 - not a power of two. Known cause of crashes at 0x00749B7B.']
    }
  ]
}

function mockPlan(chosenGroup: string): unknown {
  const resolved = chosenGroup.length > 0
  const files = [
    ['Loadscreens 2K Definitive/models/LOADSCS.txd', 'modloader/Loadscreens 2K Definitive/models/LOADSCS.txd', 'modloader-folder', 104_857_600, true, 'Old Cars'],
    ['CLEO+.cleo', 'cleo/CLEO+.cleo', 'cleo-plugin', 98_304, false, null],
    ['scripts/gsx.asi', 'scripts/gsx.asi', 'asi-plugin', 204_800, false, null],
    ['hud.txd', 'modloader/Weapon Icons TXD/models/hud.txd', 'overlay', 2_097_152, true, 'Weapon Icons TXD']
  ] as const
  return {
    planId: 'mock',
    modId: 1,
    modVersionId: 1,
    title: 'Loadscreens Definitive',
    author: 'Junior_Djjr',
    sourceUrl: 'https://www.mixmods.com.br/2020/09/loadscreens-definitive/',
    archivePath: 'C:\Downloads\Loadscreens Definitive.7z',
    extractRoot: 'C:\staging',
    readmes: [
      {
        file: 'Leiame (ou morra).txt',
        encoding: 'windows-1252',
        raw: [
          'Instalação:',
          'Extraia a pasta "Loadscreens" para a pasta do ModLoader.',
          'A versão 2K é recomendada para 1920x1080.',
          'Requer: https://www.mixmods.com.br/2015/01/mod-loader/'
        ].join(String.fromCharCode(10)),
        language: 'pt-BR',
        instructions: [
          { line: 'Extraia a pasta "Loadscreens" para a pasta do ModLoader.', folder: 'Loadscreens', destination: 'modloader-folder' }
        ],
        requirementUrls: ['https://www.mixmods.com.br/2015/01/mod-loader/'],
        confidence: 0.7
      }
    ],
    variants: [
      {
        id: 'variant:<root>',
        parentPath: '',
        kind: 'resolution',
        question: 'Which resolution do you want to install?',
        hint: 'A versao 2K e recomendada para 1920x1080.',
        options: [
          { id: 'Loadscreens 2K Definitive', path: 'Loadscreens 2K Definitive', label: 'Loadscreens 2K Definitive', fileCount: 24, size: 104_857_600, recommended: true, note: 'A versao 2K e recomendada para 1920x1080.' },
          { id: 'Loadscreens 4K Definitive', path: 'Loadscreens 4K Definitive', label: 'Loadscreens 4K Definitive', fileCount: 24, size: 419_430_400, recommended: false, note: null }
        ]
      }
    ],
    files: files.map((f) => ({
      sourcePath: f[0],
      targetRelative: f[1],
      destination: f[2],
      size: f[3],
      sha256: 'd'.repeat(64),
      overwrites: f[4],
      overwritesMod: f[5]
    })),
    dependencies: [
      { modId: 1, slug: 'mod-loader', title: 'Mod Loader', kind: 'requires', versionRange: null, satisfied: true, resolution: 'already-installed', note: null },
      { modId: null, slug: 'render-pipeline', title: 'Proper Shaders or SkyGfx', kind: 'alt', versionRange: null, satisfied: false, alternatives: [{ slug: 'proper-shaders', title: 'Proper Shaders 2.5', satisfied: false }, { slug: 'skygfx', title: 'SkyGfx', satisfied: false }], resolution: 'missing', note: 'Either render pipeline satisfies this.' }
    ],
    warnings: [
      { severity: resolved ? 'warn' : 'warn', code: 'overwrite', message: '2 file(s) already exist at their destination.', detail: 'Every one of them is backed up before it is replaced and restored on uninstall.' },
      { severity: 'info', code: 'npot-texture', message: 'LOADSCS.txd tem 1 textura fora de potência de dois.', detail: 'hud_bad 300x128' }
    ],
    totalSize: 107_257_856,
    requiresVariantChoice: !resolved
  }
}

export function installDevBridge(): void {
  const w = window as unknown as { modao?: unknown }
  if (w.modao) return

  w.modao = {
    invoke(channel: IpcChannel, ...args: unknown[]): Promise<unknown> {
      if (channel === 'library:list') return Promise.resolve(installedMods())
      if (channel === 'catalog:list') {
        const mods = catalogMods()
        return Promise.resolve({ mods, categories: ['All', 'Mods Scripts etc', 'Graphics', 'Our creations'], total: mods.length })
      }
      if (channel === 'profiles:active') return Promise.resolve(PROFILES[0])
      if (channel === 'game:active') return Promise.resolve((RESPONSES['game:list'] as unknown[])[0])
      if (channel === 'health:run') {
        return Promise.resolve({
          generatedAt: now,
          profileId: 1,
          gamePath: 'D:\\Games\\GTA San Andreas',
          ok: false,
          blocking: 1,
          warnings: 2,
          checks: [
            { id: 'exe', title: 'Executável do jogo', status: 'pass', summary: 'v1.0 US, sem modificação (14.383.616 bytes, timestamp PE 0x427101CA)' },
            {
              id: 'laa',
              title: 'LARGE_ADDRESS_AWARE',
              status: 'warn',
              summary: 'Desligado — o jogo fica limitado a 2 GB, que pacote de textura grande esgota',
              detail: 'PE Characteristics word: 0x010e (LAA is bit 0x0020). Modão never patches the executable.'
            },
            { id: 'modloader', title: 'Mod Loader', status: 'pass', summary: 'Instalado (0.3.7)' },
            {
              id: 'cleo-plus',
              title: 'Versão do CLEO exigida pelo CLEO+',
              status: 'fail',
              summary: 'O CLEO+ está instalado mas o CLEO 4.3 é velho demais',
              detail: 'CLEO+ against CLEO 4.3 fails at startup with "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo".'
            },
            {
              id: 'textures',
              title: 'Dimensão das texturas',
              status: 'warn',
              summary: '1 textura fora de potência de dois em 38 arquivos .txd',
              items: ['modloader/HD Ped Pack/models/hud.txd: hud_bad is 300x128']
            }
          ]
        })
      }
      if (channel === 'health:crashes') {
        return Promise.resolve([
          {
            id: 1,
            profileId: 1,
            occurredAt: '2026-09-20T22:31:00.000Z',
            faultOffset: '0x00349b7b',
            module: 'gta_sa.exe',
            exceptionCode: '0xc0000005',
            crashAddress: '0x00749B7B',
            matchedCause: 'Tentando criar um modelo que nao existe, ou o .txd nao existe. Ou nome de arquivo longo demais.',
            matchedSolution: 'Veja o último mod instalado: um modelo sem o .txd correspondente, ou uma textura fora de potência de dois.',
            resolved: false,
            kind: 'exception',
            raw: 'Faulting application name: gta_sa.exe\nFaulting module name: gta_sa.exe\nException code: 0xc0000005\nFault offset: 0x00349b7b'
          }
        ])
      }
      if (channel === 'saves:list') {
        return Promise.resolve([
          {
            id: 1,
            profileId: 1,
            takenAt: '2026-09-19T21:00:00.000Z',
            path: 'C:\\...\\snapshots\\2026-09-19',
            label: 'Imported from your existing install',
            size: 421_888,
            auto: false,
            slots: [{ file: 'GTASAsf1.b', index: 1, size: 202_752, modifiedAt: '2026-09-18T20:02:00.000Z' }]
          }
        ])
      }
      if (channel === 'saves:currentSlots') {
        return Promise.resolve({
          id: -1,
          profileId: 1,
          takenAt: now,
          path: 'C:\\Users\\You\\Documents\\GTA San Andreas User Files',
          label: 'Live save folder',
          size: 421_888,
          auto: false,
          slots: [
            { file: 'GTASAsf1.b', index: 1, size: 202_752, modifiedAt: '2026-09-18T20:02:00.000Z' },
            { file: 'GTASAsf3.b', index: 3, size: 202_752, modifiedAt: '2026-09-19T23:41:00.000Z' }
          ]
        })
      }
      if (channel === 'install:planFromCatalog' || channel === 'install:planFromFile' || channel === 'install:choose') {
        const chosen = channel === 'install:choose' ? String(args[1] ?? '') : ''
        return Promise.resolve(mockPlan(chosen))
      }
      if (channel === 'health:logs') return Promise.resolve([])
      if (channel === 'health:bisectCurrent') return Promise.resolve(null)
      void args
      return Promise.resolve(RESPONSES[channel] ?? null)
    },
    onProgress(_cb: (p: Progress) => void): () => void {
      return () => undefined
    },
    onToast(): () => void {
      return () => undefined
    }
  }
}
