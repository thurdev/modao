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
    details: 'Detalhes'
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
  errors: {
    noGame: 'Nenhuma pasta de jogo selecionada. Adicione uma instalação do GTA primeiro.',
    profileGone: 'Esse perfil não existe mais.',
    noBackup: 'Não existe nenhuma troca com backup para restaurar.'
  }
} as const
