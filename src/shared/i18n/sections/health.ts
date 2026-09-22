/**
 * Health strings: the pre-launch check, the crash history, the guided bisect and
 * the log timeline.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const health = {
  pt: {
    tabCheck: 'Checagem antes de jogar',
    tabCrashes: 'Histórico de crashes',
    tabBisect: 'Bisecção guiada',
    tabLogs: 'Linha do tempo dos logs',
    noProfile: 'Nenhum perfil ativo',
    noProfileHint:
      'A Saúde roda em cima dos mods que um perfil tem ligados. Ative um na tela de Perfis para checar, ler os crashes ou bisseccionar.',
    running: 'Rodando as checagens na pasta do jogo…',
    crashIntro:
      'Os registros de crash vêm do Visualizador de Eventos do Windows — canal Application, origem "Application Error", filtrando gta_sa.exe. Registros escritos por um mesmo processo que morreu aparecem como um incidente só. Quando a falha é dentro do gta_sa.exe, o endereço é 0x400000 + o deslocamento da falha, e é consultado no CrashList.txt que vem junto; quando é dentro de uma DLL, o deslocamento é relativo àquela DLL, então aparece como módulo+deslocamento e nada é consultado — o CrashList indexa só o executável. Travar sem fechar não gera registro de exceção nenhum: essa ausência já é o diagnóstico, e aponta para deadlock ou loop infinito, não para um endereço.',
    lookupPlaceholder: 'Consultar um endereço, ex.: 0x00749B7B',
    lookup: 'Consultar',
    notInList: 'Não está no CrashList que vem junto.',
    readingCrashes: 'Lendo os crashes registrados…',
    noCrashesHint:
      'Se o jogo parou de responder em vez de fechar com erro, o Windows não registra exceção nenhuma — isso aponta para travamento ou deadlock, não para um endereço de crash.',
    scanEventLog: 'Ler o Visualizador de Eventos',
    matchedCause: 'Causa encontrada',
    suggestedFix: 'Correção sugerida',
    notInCrashList: 'Este endereço não está no CrashList que vem junto.',
    crashAt: 'Crash em {address}',
    unknownAddress: 'endereço desconhecido',
    resolve: 'Resolver',
    reopen: 'Reabrir',
    lookingForBisect: 'Procurando uma bisecção não terminada…',
    onlyProblems: 'Só avisos e erros',
    collectingLogs: 'Juntando modloader.log, VehFuncs.log e os logs de cada mod…',
    noWarnings: 'Nenhum aviso ou erro',
    noLogs: 'Nenhum arquivo de log encontrado'
  },
  en: {
    tabCheck: 'Pre-launch check',
    tabCrashes: 'Crash history',
    tabBisect: 'Guided bisect',
    tabLogs: 'Log timeline',
    noProfile: 'No active profile',
    noProfileHint:
      'Health runs against the mods a profile has enabled. Activate one on the Profiles screen to check it, read its crashes or bisect it.',
    running: 'Running checks against the game folder…',
    crashIntro:
      'Crash records come from the Windows Event Log — the Application channel, source "Application Error", matching gta_sa.exe. Records written by one dying process are shown as a single incident. When the fault is inside gta_sa.exe the crash address is 0x400000 plus the fault offset and is looked up in the bundled CrashList.txt; when it is inside a DLL the offset is relative to that DLL, so it is shown as module+offset and no lookup is attempted — CrashList indexes the executable only. A hang leaves no exception record at all: that absence is itself the diagnosis, and points at a deadlock or an infinite loop rather than a faulting address.',
    lookupPlaceholder: 'Look up an address, e.g. 0x00749B7B',
    lookup: 'Look up',
    notInList: 'Not in the bundled CrashList.',
    readingCrashes: 'Reading recorded crashes…',
    noCrashesHint:
      'If the game stopped responding rather than closing with an error, Windows logs no exception at all — that points at a hang or a deadlock, not a crash address.',
    scanEventLog: 'Scan the Event Log',
    matchedCause: 'Matched cause',
    suggestedFix: 'Suggested fix',
    notInCrashList: 'This address is not in the bundled CrashList.',
    crashAt: 'Crash at {address}',
    unknownAddress: 'unknown address',
    resolve: 'Resolve',
    reopen: 'Reopen',
    lookingForBisect: 'Looking for an unfinished bisect…',
    onlyProblems: 'Warnings and errors only',
    collectingLogs: 'Collecting modloader.log, VehFuncs.log and any per-mod logs…',
    noWarnings: 'No warnings or errors',
    noLogs: 'No log files found'
  }
} as const
