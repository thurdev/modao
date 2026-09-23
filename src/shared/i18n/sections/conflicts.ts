/**
 * Conflicts strings.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const conflicts = {
  pt: {
    noProfileTitle: 'Nenhum perfil ativo',
    noProfileHint:
      'Conflitos são resolvidos por perfil. Ative um na tela Perfis para ver os arquivos duplicados dele aqui.',
    introPriority:
      'Dois mods entregando o mesmo caminho relativo não é um erro — o Mod Loader carrega só um deles, escolhido pela prioridade. Prioridade vai de 1 a 100, uma instalação nova entra com 50, e o número mais alto ganha; 0 faz o Mod Loader ignorar o mod para aquele caminho. Os arquivos duplicados custam espaço em disco, nunca memória.',
    introChange: 'Mude uma prioridade para ver o vencedor recalculado na hora. Nada é gravado no modloader.ini até você aplicar.',
    filterPlaceholder: 'Filtrar por caminho, ex.: hud.txd',
    pathCount_one: '{count} caminho em conflito',
    pathCount_other: '{count} caminhos em conflito',
    pathCountOf_one: ' de {count}',
    pathCountOf_other: ' de {count}',
    loadingIndex: 'Indexando todos os arquivos instalados…',
    nothingMatchesTitle: 'Nada encontrado com esse filtro',
    noConflictsTitle: 'Nenhum arquivo duplicado',
    nothingMatchesHint: 'Nenhum caminho em conflito contém esse texto. Limpe o filtro para ver a lista inteira.',
    noConflictsHint:
      'Nada neste perfil entrega o mesmo caminho relativo duas vezes. Casos reais comuns: LOADSCS.txd, ped.ifp, weapon.dat, animgrp.dat, default.ide, hud.txd, fonts.txd.',
    clearFilter: 'Limpar filtro',
    pendingCount_one: '{count} mudança de prioridade pendente',
    pendingCount_other: '{count} mudanças de prioridade pendentes',
    pendingNote: 'Já está na pré-visualização abaixo. O modloader.ini ainda está com a ordem de carregamento antiga.',
    discard: 'Descartar',
    writing: 'Gravando…',
    writeButton: 'Gravar no modloader.ini',
    writeSuccess: 'modloader.ini atualizado com a nova ordem de carregamento.',
    kindPhysical: 'mesmo arquivo no disco',
    kindMerge: 'mesclagem do Mod Loader',
    kindPhysicalTitle: 'Os dois mods gravaram o mesmo arquivo no disco, então um substituiu fisicamente o outro.',
    kindMergeTitle: 'Os dois arquivos ficam no disco; o Mod Loader escolhe um deles na hora de carregar.',
    kindSplitModel: 'modelo dividido',
    kindSplitModelTitle:
      'O .dff e o .txd deste modelo são carregados de mods diferentes — é exatamente isso que deixa carros e pedestres brancos ou invisíveis.',
    modsCount_one: '{count} mod',
    modsCount_other: '{count} mods',
    disabledBadge: 'desligado',
    ignoredBadge: 'ignorado — prioridade 0',
    editedBadge: 'editado',
    wins: 'ganha',
    shadowed: 'escondido',
    noWinnerTitle: 'Sem vencedor — usa o arquivo original do jogo',
    noWinnerHint:
      'Todo mod que reivindica esse caminho está desligado ou com prioridade 0, então o Mod Loader recorre ao arquivo original do jogo.',
    splitModelTitle: 'Carro ou pedestre branco: as duas metades do modelo vêm de mods diferentes',
    splitModelHint:
      'Um modelo do GTA são dois arquivos que precisam andar juntos: a malha em <nome>.dff e as texturas que ela pede em <nome>.txd. O Mod Loader resolve cada arquivo sozinho, pela prioridade, então aqui ele pegou a malha de um mod e as texturas de outro — a malha pede nomes de textura que o .txd vencedor não tem e o jogo desenha o modelo sem textura nenhuma. Suba a prioridade do mod que entrega as duas metades até ele ganhar as duas. Cuidado para não confundir: memória de streaming insuficiente deixa os veículos brancos do mesmo jeito, por outro motivo, e isso a prioridade não resolve — se TODOS os carros estão brancos, o problema é o orçamento de streaming, não este.'
  },
  en: {
    noProfileTitle: 'No active profile',
    noProfileHint: 'Conflicts are resolved per profile. Activate one on the Profiles screen and its duplicated files will be listed here.',
    introPriority:
      'Two mods supplying the same relative filename is not an error — Mod Loader loads exactly one of them, chosen by priority. Priority runs from 1 to 100, a fresh install sits at 50, and the higher number wins; 0 means Mod Loader ignores the mod for that path entirely. The duplicated files cost disk space, never memory.',
    introChange: 'Change a priority to see the winner recomputed live. Nothing is written to modloader.ini until you apply.',
    filterPlaceholder: 'Filter by path, e.g. hud.txd',
    pathCount_one: '{count} conflicting path',
    pathCount_other: '{count} conflicting paths',
    pathCountOf_one: ' of {count}',
    pathCountOf_other: ' of {count}',
    loadingIndex: 'Indexing every installed file…',
    nothingMatchesTitle: 'Nothing matches that filter',
    noConflictsTitle: 'No duplicated files',
    nothingMatchesHint: 'No conflicting path contains that text. Clear the filter to see the whole list.',
    noConflictsHint:
      'Nothing in this profile supplies the same relative path twice. Common real cases when it happens: LOADSCS.txd, ped.ifp, weapon.dat, animgrp.dat, default.ide, hud.txd, fonts.txd.',
    clearFilter: 'Clear filter',
    pendingCount_one: '{count} pending priority change',
    pendingCount_other: '{count} pending priority changes',
    pendingNote: 'Previewed below. modloader.ini still holds the old load order.',
    discard: 'Discard',
    writing: 'Writing…',
    writeButton: 'Write to modloader.ini',
    writeSuccess: 'modloader.ini updated with the new load order.',
    kindPhysical: 'same file on disk',
    kindMerge: 'Mod Loader merge',
    kindPhysicalTitle: 'Both mods wrote the same file on disk, so one physically replaced the other.',
    kindMergeTitle: 'Both files stay on disk; Mod Loader picks one of them at load time.',
    kindSplitModel: 'split model',
    kindSplitModelTitle:
      "This model's .dff and .txd are loaded from different mods - which is exactly what makes a car or ped turn white or invisible.",
    modsCount_one: '{count} mod',
    modsCount_other: '{count} mods',
    disabledBadge: 'disabled',
    ignoredBadge: 'ignored — priority 0',
    editedBadge: 'edited',
    wins: 'wins',
    shadowed: 'shadowed',
    noWinnerTitle: 'No winner — the vanilla file is used',
    noWinnerHint: 'Every mod claiming this path is either disabled or set to priority 0, so Mod Loader falls back to the file that shipped with the game.',
    splitModelTitle: 'White car or ped: the two halves of this model come from different mods',
    splitModelHint:
      'A GTA model is two files that have to travel together: the mesh in <name>.dff and the textures it asks for in <name>.txd. Mod Loader resolves each file on its own, by priority, so here it took the mesh from one mod and the textures from another — the mesh asks for texture names the winning .txd does not contain and the game draws the model with no texture at all. Raise the priority of the mod that ships both halves until it wins both. Do not confuse it with the other cause: a streaming memory budget too small for the models installed whites out vehicles in exactly the same way, and priority does not fix that one — if EVERY car is white, the streaming budget is the problem, not this.'
  }
} as const
