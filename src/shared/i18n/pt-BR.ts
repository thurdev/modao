/**
 * Catálogo pt-BR — idioma de origem do Modão.
 *
 * Toda string que o usuário lê nasce aqui. Chaves são agrupadas pela tela ou
 * pelo assunto, não pelo componente, para que mover um botão de lugar não mude
 * o nome da chave. Plural usa os sufixos `_one` / `_other`.
 */
import { profiles } from './sections/profiles'
import { library } from './sections/library'
import { conflicts } from './sections/conflicts'
import { browse } from './sections/browse'
import { saves } from './sections/saves'
import { health } from './sections/health'
import { settings } from './sections/settings'
import { shell } from './sections/shell'
import { install } from './sections/install'
import { checks } from './sections/checks'
import { messages } from './sections/messages'

export const ptBR = {
  profiles: profiles.pt,
  library: library.pt,
  conflicts: conflicts.pt,
  browse: browse.pt,
  saves: saves.pt,
  health: health.pt,
  settings: settings.pt,
  shell: shell.pt,
  install: install.pt,
  checks: checks.pt,
  messages: messages.pt,
  app: {
    name: 'Modão',
    tagline: 'gerenciador de mods',
    loading: 'Carregando…',
    retry: 'Tentar de novo',
    cancel: 'Cancelar',
    close: 'Fechar',
    done: 'Pronto',
    save: 'Salvar',
    remove: 'Remover',
    confirm: 'Confirmar',
    back: 'Voltar',
    search: 'Buscar',
    none: 'nenhum',
    unknown: 'desconhecido',
    copy: 'Copiar',
    open: 'Abrir',
    details: 'Detalhes',
    working: 'Trabalhando…',
    wentWrong: 'Deu ruim'
  },
  nav: {
    setup: 'Instalação',
    manage: 'Diagnóstico',
    system: 'App',
    profiles: 'Perfis',
    library: 'Biblioteca',
    browse: 'Explorar',
    conflicts: 'Conflitos',
    health: 'Saúde',
    saves: 'Saves',
    settings: 'Ajustes'
  },
  game: {
    none: 'Nenhum jogo selecionado',
    addFirst: 'Adicione sua instalação para começar',
    addAnother: 'Adicionar outra instalação',
    addAnotherHint: 'San Andreas, III, Vice City ou a Definitive Edition',
    onlyOne: 'Só uma instalação por enquanto. O Modão cuida de {list}.',
    pickFolder: 'Escolha a pasta do seu GTA (San Andreas, III, Vice City ou Definitive Edition)',
    notFound: 'Nenhum executável do GTA em {path}.',
    launch: 'Jogar',
    added: '{name} adicionado de {path}.',
    switchFirst: '{profile} é um perfil de {game} e a instalação ativa é {active}. Troque de jogo primeiro.'
  },
  crashes: {
    title: 'Histórico de crashes',
    scan: 'Procurar crashes',
    scanning: 'Lendo o Visualizador de Eventos…',
    none: 'Nenhum crash registrado',
    when: 'Quando',
    kind: 'Tipo',
    module: 'Módulo que falhou',
    address: 'Endereço',
    matchedCause: 'Causa encontrada',
    notInList: 'não está no CrashList',
    notLookedUp: 'não consultado — a falha não é no gta_sa.exe',
    unloaded: 'descarregado',
    unloadedTitle: 'Já estava descarregado quando a falha aconteceu',
    hang: 'Parou de responder — nenhuma exceção foi registrada',
    exception: 'Exceção não tratada',
    oneRun: 'Exceção não tratada · {count} registro(s) de uma mesma execução',
    otherRecords: 'Outros registros da mesma execução',
    rawEvent: 'Evento bruto',
    occurred: 'Aconteceu',
    process: 'Processo que falhou',
    exceptionCode: 'Código da exceção',
    faultOffset: 'Deslocamento da falha',
    crashAddress: 'Endereço do crash',
    faultLocation: 'Local da falha',
    notLookedUpTitle: 'Não consultado'
  },
  access: {
    theGameFolder: 'a pasta do jogo',
    notAllowed: 'O Modão não tem permissão para alterar {path}.',
    fixProgramFiles:
      'Esse caminho está dentro do Program Files, onde o Windows bloqueia escrita de processo comum. Abra o Modão como administrador, ou mova o jogo para fora do Program Files.',
    fixReadOnly: 'Confira se a pasta não está somente leitura e se nenhum antivírus está segurando ela.',
    busy: '{path} está em uso por outro processo — feche o GTA e qualquer janela do explorador nessa pasta, e tente de novo.',
    diskFull: 'O disco que tem {path} está cheio.',
    missing: '{path} não existe. Pode ter sido movida ou apagada fora do Modão.'
  },
  updates: {
    available: 'Saiu a versão {version}',
    optional: 'Você está na {current}. Atualizar é opcional — nada é instalado sem você mandar.',
    open: 'Ver a release',
    updateNow: 'Atualizar agora',
    updateAndRestart: 'Atualizar e reiniciar',
    checkFailed: 'Não deu para verificar atualização: {error}',
    starting: 'Começando…',
    downloading: 'Baixando {percent}% de {size} · {speed}/s',
    readyToInstall: 'Versão {version} baixada e pronta',
    restartExplains: 'O Modão fecha, se atualiza e abre de novo. Teus perfis, saves e catálogo não são tocados.',
    restartAndInstall: 'Reiniciar e instalar',
    whatsNew: 'O que mudou',
    dismiss: 'Agora não',
    title: 'Atualizações',
    checkOnStart: 'Procurar atualização ao abrir',
    checkOnStartDesc:
      'Uma consulta por dia à página de releases do GitHub. Nada sobre você é enviado, e nenhuma atualização é instalada sozinha.',
    check: 'Procurar agora',
    checking: 'Procurando…',
    upToDate: 'Você está na versão mais recente ({current}).',
    found: 'Versão {version} disponível — você está na {current}.',
    never: 'Nunca verificado.',
    lastChecked: 'Última verificação {when}.',
    failed: 'Não deu para verificar: {error}'
  },
  time: {
    never: 'nunca',
    justNow: 'agora',
    minutes: '{count} min atrás',
    hours: '{count} h atrás',
    days: '{count} d atrás'
  },
  destinations: {
    modloaderFolder: 'Pasta do Mod Loader',
    asiPlugin: 'Plugin .asi',
    cleoPlugin: 'Plugin CLEO',
    cleoScript: 'Script CLEO',
    rootFile: 'Arquivo na raiz do jogo',
    overlay: 'Sobreposição (altera outro mod)',
    unknown: 'Não classificado'
  },
  download: {
    noLink: 'Nenhum link de download registrado para esta versão.',
    invalidLink: 'O link de download registrado não é uma URL válida.',
    landingHost: 'O {host} serve uma página de download em vez do arquivo, e recusa requisição que não seja de navegador.',
    notARelease: 'Esse link do GitHub não é uma release.',
    notAnArchive: 'O {host} não devolveu um link terminando em .7z, .zip ou .rar.'
  },
  errors: {
    noGame: 'Nenhuma pasta de jogo selecionada. Adicione uma instalação do GTA primeiro.',
    profileGone: 'Esse perfil não existe mais.',
    noBackup: 'Não existe nenhuma troca com backup para restaurar.'
  }
} as const
