/**
 * The pre-launch health check, as the user reads it.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const checks = {
  pt: {
    exeTitle: 'Executável do jogo',
    exeStock: 'v1.0 US, sem modificação (14.383.616 bytes, timestamp PE 0x427101CA)',
    exeNotStock: 'Não é um executável v1.0 US de fábrica',
    exeOther: '{game}: executável encontrado',
    exeSize: 'Tamanho: {size} bytes (o v1.0 US tem 14.383.616)',
    exeTimestamp: 'Timestamp PE: {value} (o v1.0 US é 0x427101CA)',
    exeSha: 'SHA-256: {value}…',
    laaTitle: 'LARGE_ADDRESS_AWARE',
    laaSet: 'Ligado — o jogo pode endereçar até 4 GB',
    laaUnset: 'Desligado — o jogo fica limitado a 2 GB, que pacote de textura grande esgota',
    laaDetail:
      'Palavra Characteristics do PE: {value} (LAA é o bit 0x0020). O Modão nunca modifica o executável; use um patcher externo se quiser mudar isso.',
    writeTitle: 'Permissão de escrita na pasta do jogo',
    writeOk: 'O Modão consegue escrever em {path}',
    writeDenied: 'O Windows recusa escrita em {path}{code}',
    modloaderTitle: 'Mod Loader',
    modloaderInstalled: 'Instalado{version}',
    modloaderMissing: 'Não instalado',
    modloaderDetail: 'Sem o Mod Loader, nada dentro de modloader\\ é carregado pelo jogo.',
    modloaderNotApplicable: 'Este jogo não usa Mod Loader',
    asiTitle: 'Carregador e pasta de .asi',
    asiPresent: '{loader} presente; plugins .asi carregam de {dir}',
    asiMissing: 'Nenhum carregador de .asi encontrado — plugins .asi não vão carregar',
    asiDetail:
      'A pasta de .asi é detectada por onde o modloader.asi realmente está, e não presumida: algumas instalações carregam da raiz do jogo, repacks costumam carregar de scripts\\.',
    asiUnknown: 'desconhecida',
    asiGameRoot: 'a raiz do jogo',
    cleoPlusTitle: 'Versão do CLEO exigida pelo CLEO+',
    cleoPlusOk: 'O CLEO {version} atende o CLEO+',
    cleoPlusTooOld: 'O CLEO+ está instalado mas o CLEO {version} é velho demais',
    cleoPlusDetail:
      'CLEO+ com CLEO 4.3 quebra na inicialização com um diálogo fatal: "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo". Atualize o CLEO para 4.4 ou mais novo.',
    cleoTitle: 'CLEO',
    cleoDetected: 'CLEO {version} detectado, {count} arquivo(s) em cleo\\',
    cleoMissing: 'CLEO não instalado',
    depsTitle: 'Dependências',
    depsOk: 'Todo requisito está satisfeito',
    depsUnresolved: '{count} sem resolver',
    depsConflict: 'Conflito',
    depsMissing: 'Faltando',
    conflictsTitle: 'Conflitos de arquivo',
    conflictsNone: 'Nenhum arquivo duplicado entre mods',
    conflictsSome: '{count} caminho(s) duplicado(s); {resolved} resolvido(s) por prioridade',
    conflictsWinner: '{title} ganha (prioridade {priority})',
    conflictsNoWinner: 'sem vencedor: todos os candidatos estão desligados ou com prioridade 0',
    texturesTitle: 'Dimensão das texturas',
    texturesBad: '{count} textura(s) fora de potência de dois em {scanned} arquivo(s) .txd',
    texturesOk: '{scanned} arquivo(s) .txd lidos, todas as dimensões são potência de dois',
    texturesDetail:
      'Textura fora de potência de dois é causa documentada de crash (0x00749B7B) e de textura que não aparece.',
    sizeTitle: 'Tamanho dos mods',
    sizeSummary: '{size} GB de mods ligados',
    sizeDetail:
      'Pacote grande somado a um espaço de endereçamento de 2 GB é a causa mais comum de crash por falta de memória no meio do jogo.',
    unknown: 'desconhecido'
  },
  en: {
    exeTitle: 'Game executable',
    exeStock: 'v1.0 US, unmodified (14,383,616 bytes, PE timestamp 0x427101CA)',
    exeNotStock: 'Not a stock v1.0 US executable',
    exeOther: '{game}: executable found',
    exeSize: 'Size: {size} bytes (v1.0 US is 14,383,616)',
    exeTimestamp: 'PE timestamp: {value} (v1.0 US is 0x427101CA)',
    exeSha: 'SHA-256: {value}…',
    laaTitle: 'LARGE_ADDRESS_AWARE',
    laaSet: 'Set - the game can address up to 4 GB',
    laaUnset: 'Not set - the game is limited to 2 GB, which large texture packs exhaust',
    laaDetail:
      'PE Characteristics word: {value} (LAA is bit 0x0020). Modão never patches the executable; use an external patcher if you want this changed.',
    writeTitle: 'Write access to the game folder',
    writeOk: 'Modão can write to {path}',
    writeDenied: 'Windows denies writes to {path}{code}',
    modloaderTitle: 'Mod Loader',
    modloaderInstalled: 'Installed{version}',
    modloaderMissing: 'Not installed',
    modloaderDetail: 'Without Mod Loader nothing in modloader\\ is loaded by the game.',
    modloaderNotApplicable: 'This game does not use Mod Loader',
    asiTitle: 'ASI loader and directory',
    asiPresent: '{loader} present; .asi plugins load from {dir}',
    asiMissing: 'No ASI loader found - .asi plugins will not load',
    asiDetail:
      'The ASI directory is detected from where modloader.asi actually lives rather than assumed: some installs load from the game root, repacks often load from scripts\\.',
    asiUnknown: 'unknown',
    asiGameRoot: 'the game root',
    cleoPlusTitle: 'CLEO+ version gate',
    cleoPlusOk: 'CLEO {version} satisfies CLEO+',
    cleoPlusTooOld: 'CLEO+ is installed but CLEO {version} is too old',
    cleoPlusDetail:
      'CLEO+ against CLEO 4.3 fails at startup with a fatal dialog: "The ordinal 22 could not be located in the dynamic link library CLEO+.cleo". Update CLEO to 4.4 or newer.',
    cleoTitle: 'CLEO',
    cleoDetected: 'CLEO {version} detected, {count} file(s) in cleo\\',
    cleoMissing: 'CLEO not installed',
    depsTitle: 'Dependencies',
    depsOk: 'Every requirement is satisfied',
    depsUnresolved: '{count} unresolved',
    depsConflict: 'Conflict',
    depsMissing: 'Missing',
    conflictsTitle: 'File conflicts',
    conflictsNone: 'No duplicated files between mods',
    conflictsSome: '{count} duplicated path(s); {resolved} resolved by priority',
    conflictsWinner: '{title} wins (priority {priority})',
    conflictsNoWinner: 'no winner: every claimant is disabled or priority 0',
    texturesTitle: 'Texture dimensions',
    texturesBad: '{count} non-power-of-two texture(s) across {scanned} .txd file(s)',
    texturesOk: '{scanned} .txd file(s) scanned, all dimensions are powers of two',
    texturesDetail:
      'Non-power-of-two textures are a documented cause of crashes (0x00749B7B) and of textures failing to render.',
    sizeTitle: 'Asset size',
    sizeSummary: '{size} GB of enabled mods',
    sizeDetail:
      'Large packs plus a 2 GB address space is the usual cause of out-of-memory crashes mid-game.',
    unknown: 'unknown'
  }
} as const
