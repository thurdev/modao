/**
 * Profiles strings.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const profiles = {
  pt: {
    title: 'Perfis',
    intro:
      'Um perfil é dono do conjunto de mods ativados, das prioridades de cada mod, dos próprios saves e do próprio bloco no modloader.ini. O payload é guardado uma vez e ligado na pasta do jogo, então trocar de perfil nunca copia gigabytes.',
    active: 'Ativo',
    switchTo: 'Trocar para',
    switching: 'Trocando…',
    dryRun: 'Simular',
    dryRunHint: 'Mostra cada arquivo que a troca tocaria, sem tocar em nenhum',
    planning: 'Planejando…',
    duplicate: 'Duplicar',
    switchedTo: 'Trocado para {name}',
    switchedButFailed: 'Trocado para {name} — mas não passou na verificação',
    restorePrevious: 'Restaurar estado anterior',
    restoring: 'Restaurando…',
    whatHappened: 'O que aconteceu',
    verified: 'Verificado',
    notVerified: 'Esta troca não passou na verificação',
    verificationSummary:
      '{materialised}/{expected} mod(s) no lugar · {asi} .asi · {cleoPlugins} plugin(s) CLEO · {cleoScripts} script(s) CLEO · modloader.ini {ini}',
    iniParses: 'foi lido',
    iniFailed: 'não pôde ser lido',
    modDidNotArrive: 'Mod que não chegou',
    why: 'Por quê',
    unresolvedDeps: 'Dependências não resolvidas',
    dryRunTitle: 'Simulação: trocar para {name}',
    dryRunSubtitle: 'Nada foi alterado. Este é o plano que a troca de verdade executaria.',
    runIt: 'Executar',
    leaving: 'Saindo da pasta do jogo',
    arriving: 'Chegando',
    toStoreFirst: 'A copiar para o acervo antes',
    untouched: 'Intocado, fora do controle do Modão',
    nothing: 'nada',
    wouldRefuse: '{count} mod(s) não puderam ser materializados — a troca se recusaria a rodar',
    outgoingSummary: '{count} arquivo(s) · {size} copiados para backup antes',
    incomingSummary: '{count} arquivo(s)',
    file: 'Arquivo',
    whatHappens: 'O que acontece',
    mod: 'Mod',
    actions: {
      'snapshot-and-remove': 'copiado para backup e removido',
      'drop-link': 'link desfeito (o conteúdo fica no acervo)',
      'leave-unmanaged': 'deixado em paz (não é gerenciado pelo Modão)',
      'leave-unverifiable': 'deixado em paz (sem backup verificado)',
      materialise: 'ligado na pasta do jogo'
    }
  },
  en: {
    title: 'Profiles',
    intro:
      "A profile owns its enabled mod set, its per-mod priorities, its own save games and its own block in modloader.ini. Payloads are stored once and linked into the game folder, so switching never copies gigabytes.",
    active: 'Active',
    switchTo: 'Switch to',
    switching: 'Switching…',
    dryRun: 'Dry run',
    dryRunHint: 'Show every file the switch would touch, without touching any of them',
    planning: 'Planning…',
    duplicate: 'Duplicate',
    switchedTo: 'Switched to {name}',
    switchedButFailed: 'Switched to {name} — but it did not verify',
    restorePrevious: 'Restore previous state',
    restoring: 'Restoring…',
    whatHappened: 'What happened',
    verified: 'Verified',
    notVerified: 'This switch did not pass verification',
    verificationSummary:
      '{materialised}/{expected} mod(s) in place · {asi} .asi · {cleoPlugins} CLEO plugin(s) · {cleoScripts} CLEO script(s) · modloader.ini {ini}',
    iniParses: 'parses',
    iniFailed: 'could not be read',
    modDidNotArrive: 'Mod that did not arrive',
    why: 'Why',
    unresolvedDeps: 'Unresolved dependencies',
    dryRunTitle: 'Dry run: switching to {name}',
    dryRunSubtitle: 'Nothing was changed. This is the plan the real switch would carry out.',
    runIt: 'Run it',
    leaving: 'Leaving the game folder',
    arriving: 'Arriving',
    toStoreFirst: 'To copy into the store first',
    untouched: 'Untouched, not managed by Modão',
    nothing: 'nothing',
    wouldRefuse: '{count} mod(s) could not be materialised — the switch would refuse to run',
    outgoingSummary: '{count} file(s) · {size} backed up first',
    incomingSummary: '{count} file(s)',
    file: 'File',
    whatHappens: 'What happens',
    mod: 'Mod',
    actions: {
      'snapshot-and-remove': 'backed up, then removed',
      'drop-link': 'link dropped (the payload stays in the store)',
      'leave-unmanaged': 'left alone (not managed by Modão)',
      'leave-unverifiable': 'left alone (no verified backup)',
      materialise: 'linked into the game folder'
    }
  }
} as const
