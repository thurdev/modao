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
    status: { pass: 'ok', warn: 'aviso', fail: 'falha', skip: 'pulado' },
    verdictClean: 'Passou em tudo. Este perfil está pronto para jogar.',
    verdictWarned_one: 'Nada impede de jogar, mas 1 checagem achou algo que vale ler antes.',
    verdictWarned_other: 'Nada impede de jogar, mas {count} checagens acharam algo que vale ler antes.',
    verdictBlocked_one: '1 problema vai impedir o jogo de abrir direito. Resolva esse primeiro; os {warnings} avisos podem esperar.',
    verdictBlocked_other:
      '{count} problemas vão impedir o jogo de abrir direito. Resolva esses primeiro; os {warnings} avisos podem esperar.',
    readyToLaunch: 'Pronto para jogar',
    blockingCount: '{count} bloqueando',
    passCount: '{count} ok',
    warnCount: '{count} aviso(s)',
    failCount: '{count} falha(s)',
    skippedCount: '{count} pulada(s)',
    rerun: 'Checar de novo',
    fixStreaming: 'Gravar 2048 MB (com backup)',
    fixing: 'Gravando…',
    checkedAt: 'checado {when}',
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
    bisectNone: 'Nenhuma bissecção em andamento',
    bisectIntro:
      'Comece uma quando o jogo falhar e você não souber qual mod é o culpado. Cada passo custa uma aberta do jogo.',
    bisectStart: 'Começar uma bissecção',
    bisectPreparing: 'Preparando…',
    bisectStep: 'Passo {step}',
    bisectLaunchNow: 'Abra o jogo agora e depois conte pro Modão o que aconteceu.',
    bisectLoaded_one: '{count} mod está carregado nesta rodada.',
    bisectLoaded_other: '{count} mods estão carregados nesta rodada.',
    bisectNoFiles: 'Nada é movido: o Modão usa o próprio ExcludeAllMods do Mod Loader, então as pastas ficam onde estão.',
    bisectCareTitle: 'Três coisas que o método exige',
    bisectCareMany: 'Mais de um mod pode ser culpado ao mesmo tempo. Achar um não garante que acabou.',
    bisectCareAddress:
      'Endereço de crash diferente NÃO é progresso — é outro crash. Confira de novo com o jogo aberto do zero.',
    bisectCareOneChange: 'Teste a cada mudança, uma de cada vez. Mexer em várias coisas junto invalida a rodada.',
    bisectItRanFine: 'Abriu normal',
    bisectItFailed: 'Falhou de novo',
    bisectNoSingleMod:
      'Nenhum mod sozinho explica a falha — provavelmente é uma combinação, ou algo fora do conjunto de mods.',
    logsAllInfo: 'Tudo que foi coletado é informativo. Desligue o filtro para ler a linha do tempo inteira.',
    lookingForBisect: 'Procurando uma bisecção não terminada…',
    onlyProblems: 'Só avisos e erros',
    collectingLogs: 'Juntando modloader.log, VehFuncs.log e os logs de cada mod…',
    noWarnings: 'Nenhum aviso ou erro',
    noLogs: 'Nenhum arquivo de log encontrado'
  },
  en: {
    tabCheck: 'Pre-launch check',
    status: { pass: 'pass', warn: 'warn', fail: 'fail', skip: 'skipped' },
    verdictClean: 'Every check passed. This profile is ready to launch.',
    verdictWarned_one: 'Nothing blocks a launch, but 1 check found something worth reading before you play.',
    verdictWarned_other: 'Nothing blocks a launch, but {count} checks found something worth reading before you play.',
    verdictBlocked_one: '1 issue will stop the game from starting cleanly. Fix that first; the {warnings} warnings can wait.',
    verdictBlocked_other:
      '{count} issues will stop the game from starting cleanly. Fix those first; the {warnings} warnings can wait.',
    readyToLaunch: 'Ready to launch',
    blockingCount: '{count} blocking',
    passCount: '{count} pass',
    warnCount: '{count} warn',
    failCount: '{count} fail',
    skippedCount: '{count} skipped',
    rerun: 'Re-run',
    fixStreaming: 'Write 2048 MB (keeping a backup)',
    fixing: 'Writing…',
    checkedAt: 'checked {when}',
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
    bisectNone: 'No bisect running',
    bisectIntro:
      'Start one when the game fails and you do not know which mod is responsible. Each step takes one launch.',
    bisectStart: 'Start a bisect',
    bisectPreparing: 'Preparing…',
    bisectStep: 'Step {step}',
    bisectLaunchNow: 'Launch the game now, then tell Modão what happened.',
    bisectLoaded_one: '{count} mod is loaded for this run.',
    bisectLoaded_other: '{count} mods are loaded for this run.',
    bisectNoFiles: "Nothing is moved: Modão uses Mod Loader's own ExcludeAllMods, so the folders stay where they are.",
    bisectCareTitle: 'Three things the method demands',
    bisectCareMany: 'More than one mod can be guilty at the same time. Finding one does not mean you are done.',
    bisectCareAddress:
      'A different crash address is NOT progress - it is a different crash. Re-verify from a fresh boot.',
    bisectCareOneChange: 'Test after every single change, one at a time. Batching edits invalidates the round.',
    bisectItRanFine: 'It ran fine',
    bisectItFailed: 'It failed again',
    bisectNoSingleMod:
      'No single mod explains the failure - it is likely a combination, or something outside the mod set.',
    logsAllInfo: 'Every collected line is informational. Turn the filter off to read the whole timeline.',
    lookingForBisect: 'Looking for an unfinished bisect…',
    onlyProblems: 'Warnings and errors only',
    collectingLogs: 'Collecting modloader.log, VehFuncs.log and any per-mod logs…',
    noWarnings: 'No warnings or errors',
    noLogs: 'No log files found'
  }
} as const
