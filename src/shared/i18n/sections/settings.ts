/**
 * Settings strings.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const settings = {
  pt: {
    catalog: 'Catálogo',
    indexTitle: 'Indexar o MixMods pela rede',
    indexDesc:
      'Desligado por padrão. Ligado, o Modão lê as páginas de mod a uma requisição por segundo, respeita o robots.txt, guarda cache com ETag/Last-Modified e relê uma página no máximo uma vez por dia. Lançamento de acesso antecipado pago nunca é baixado — só linkado.',
    pagesPerRun: 'Páginas por rodada',
    pagesPerRunDesc:
      'Quantas páginas de mod uma rodada de indexação pode visitar. 0 significa todas as páginas de GTA: San Andreas e SA:DE do site — alguns milhares, no ritmo de uma por segundo, com retomada e cancelamento.',
    catalogData: 'Dados do catálogo',
    catalogDataDesc: 'Reimportar o catálogo que vem junto, ou começar uma indexação agora.',
    reloadSeed: 'Recarregar catálogo local',
    indexNow: 'Indexar agora',
    modsIndexed: '{count} mod(s) indexados',
    lastCrawl: ' · última indexação em {date}',
    neverCrawled: ' · nunca indexado',
    behaviour: 'Comportamento',
    scanCrashes: 'Ler o Visualizador de Eventos depois de jogar',
    scanCrashesDesc:
      'Procura um registro de Application Error do gta_sa.exe e resolve o endereço do crash no CrashList.txt.',
    autoSnapshot: 'Snapshot automático dos saves',
    autoSnapshotDesc:
      'Tira um snapshot dos saves antes de cada troca de perfil. Os 10 snapshots automáticos mais recentes de cada perfil são mantidos; os mais antigos vão para a quarentena em vez de serem apagados.',
    telemetry: 'Telemetria local de instalação',
    telemetryDesc:
      'Conta quantas vezes você instala um mod e se desliga ele logo depois. Usado só para alimentar a nota sintetizada nesta máquina.',
    gameFolders: 'Pastas de jogo',
    addFolder: 'Adicionar pasta',
    useThis: 'Usar esta',
    forget: 'Esquecer',
    storage: 'Armazenamento',
    clearPageCache: 'Limpar cache de páginas',
    deleteArchives: 'Apagar arquivos baixados',
    emptyQuarantine: 'Esvaziar quarentena',
    title: 'Ajustes',
    appearance: 'Aparência',
    themeHint:
      'Segue o sistema operacional, a não ser que você fixe. Os dois temas foram desenhados, nenhum é o outro invertido.',
    language: 'Idioma',
    languageHint: 'O Modão nasceu em português; o inglês é tradução.',
    theme: 'Tema',
    themeDark: 'Escuro',
    themeLight: 'Claro',
    themeSystem: 'Do sistema'
  },
  en: {
    catalog: 'Catalogue',
    indexTitle: 'Index MixMods over the network',
    indexDesc:
      'Off by default. When on, Modão crawls mod pages at one request per second, honours robots.txt, caches with ETag/Last-Modified and re-reads a page at most once a day. Paywalled early-access releases are never downloaded — only linked.',
    pagesPerRun: 'Pages per run',
    pagesPerRunDesc:
      'How many mod pages one indexing run may visit. 0 means every GTA: San Andreas and SA:DE page on the site — a few thousand, paced at one request per second, resumable and cancellable.',
    catalogData: 'Catalogue data',
    catalogDataDesc: 'Re-import the bundled seed catalogue, or start an indexing run now.',
    reloadSeed: 'Reload seed',
    indexNow: 'Index now',
    modsIndexed: '{count} mods indexed',
    lastCrawl: ' · last crawl {date}',
    neverCrawled: ' · never crawled',
    behaviour: 'Behaviour',
    scanCrashes: 'Read the Event Log after playing',
    scanCrashesDesc:
      'Looks for an Application Error record for gta_sa.exe and resolves the crash address against CrashList.txt.',
    autoSnapshot: 'Snapshot saves automatically',
    autoSnapshotDesc:
      'Takes a save snapshot before every profile switch. The last 10 automatic snapshots per profile are kept; older ones move to quarantine rather than being deleted.',
    telemetry: 'Local install telemetry',
    telemetryDesc:
      'Counts how often you install a mod and whether you disable it soon after. Used only to inform the synthesised ranking on this machine.',
    gameFolders: 'Game folders',
    addFolder: 'Add folder',
    useThis: 'Use this',
    forget: 'Forget',
    storage: 'Storage',
    clearPageCache: 'Clear page cache',
    deleteArchives: 'Delete downloaded archives',
    emptyQuarantine: 'Empty quarantine',
    title: 'Settings',
    appearance: 'Appearance',
    themeHint:
      'Follows the operating system unless you pin it. Both themes are designed, not inverted.',
    language: 'Language',
    languageHint: 'Modão was written in Portuguese; English is the translation.',
    theme: 'Theme',
    themeDark: 'Dark',
    themeLight: 'Light',
    themeSystem: 'Follow the system'
  }
} as const
