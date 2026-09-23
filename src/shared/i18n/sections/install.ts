/**
 * Install strings: first-run setup, the install plan dialog and the
 * write-access banner.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`.
 */
export const install = {
  pt: {
    planReqs: {
      requirementsTitle: 'requisitos',
      requirementsHint: 'O mod diz precisar destes. Dá para instalar mesmo assim — mas ele pode não funcionar.',
      installRequirement: 'Instalar este também',
      openRequirement: 'Abrir a página'
    },
    setup: {
      title: 'Configurar o Modão',
      intro:
        'Sua instalação é tratada como a fonte da verdade. A configuração indexa o que já está lá — nenhum arquivo é movido, renomeado ou reescrito, e as prioridades que já estão no modloader.ini são lidas, não substituídas.',
      step1Title: 'Achar o GTA: San Andreas',
      folder: 'Pasta',
      executable: 'Executável',
      exeStock: 'v1.0 US original',
      exeNonStock: 'com patch ou não original',
      exeBytes: '{bytes} bytes',
      laaSet: 'LARGE_ADDRESS_AWARE ativo (4 GB)',
      laaNotSet: 'sem a flag LAA (limite de 2 GB)',
      modLoader: 'Mod Loader',
      installed: 'instalado',
      notInstalled: 'não instalado',
      asiDirectory: 'Pasta de ASI',
      noneDetected: 'nenhuma detectada',
      cleo: 'CLEO',
      writeAccess: 'Acesso de escrita',
      writableTo: 'O Modão pode escrever em {path}',
      writeDeniedFallback:
        'O Windows nega escrita nesta pasta. A adoção ainda funciona — ela só lê — mas instalar ou trocar de perfil não vai funcionar até isso ser corrigido.',
      modStore: 'Repositório de mods',
      sameVolume:
        'Mesmo volume do jogo — os perfis são vinculados em vez de copiados, então trocar de perfil não custa nada.',
      diffVolume:
        'Volume diferente do jogo — o Modão vai usar junções quando puder e copiar quando não puder. A primeira troca vai demorar mais.',
      looking: 'Procurando nos lugares de sempre…',
      useThis: 'Usar esta',
      nothingFound: 'Nada encontrado automaticamente — normal em cópias portáteis e repacks.',
      browseFolder: 'Escolher a pasta…',
      step2Title: 'Adotar o que já está instalado',
      savesFound_one: '{count} slot de save encontrado nesta máquina',
      savesFound_other: '{count} slots de save encontrados nesta máquina',
      savesPlusSettings: ', mais o gta_sa.set',
      savesExplain:
        '. Serão copiados para este perfil e recebem um snapshot antes de qualquer outra coisa acontecer, então trocar de perfil nunca vai perder esses saves. Os originais continuam exatamente onde estão.',
      profileNameLabel: 'Nome do perfil',
      profileNameHint: 'O perfil que vai guardar sua instalação atual.',
      indexing: 'Indexando…',
      adoptButton: 'Adotar esta instalação',
      readOnlyHint: 'Somente leitura: nenhum arquivo muda de lugar.',
      step3Title: 'Adotado',
      itemCount: '{count} item(s)',
      openLibrary: 'Abrir a biblioteca',
      runHealthCheck: 'Rodar a checagem antes de jogar'
    },
    plan: {
      sourcePage: 'página de origem',
      fileCountSize: '{count} arquivo(s), {size}',
      fileCountSizeDot: '{count} arquivo(s) · {size}',
      displaced: ' · {count} arquivo(s) sobrescrito(s)',
      hideReadme: 'Esconder o leiame bruto',
      rawReadme: 'Leiame bruto',
      pickVariant: 'Escolha uma variante para continuar',
      nothingWritten: 'Nada é escrito até você confirmar',
      working: 'Processando…',
      installButton: 'Instalar {count} arquivo(s)',
      readmeSays: 'O leiame diz: “{hint}”',
      recommended: 'recomendado',
      readmeHeader: 'Leiame',
      instructionsParsed: '{count} instrução(ões) lida(s)',
      noInstructionLine:
        'Nenhuma linha de instrução de instalação foi reconhecida. O plano abaixo vem da inspeção do próprio arquivo.',
      folderNamedInReadme: 'Pasta citada no leiame: {folder}',
      linksInReadme: 'Links no leiame:',
      dependencyPlan: 'Plano de dependências',
      mustNotCoexist: 'não pode coexistir',
      oneOf: 'um destes',
      requires: 'requer',
      installedSuffix: ' (instalado)',
      or: 'ou',
      filePlacement: 'Onde os arquivos vão',
      relativeHint: 'todo caminho é relativo à pasta do jogo',
      collapse: 'Recolher',
      showEveryFile: 'Mostrar todos os arquivos',
      replacesMod: 'substitui {mod}',
      overwritesLabel: 'sobrescreve',
      gameRoot: '<raiz do jogo>',
      addOnsTitle: 'Extras opcionais',
      addOnsHint: 'Sozinhas, estas pastas não fazem nada — ligue para mesclá-las no mod a que pertencem.',
      addOnAsOwnMod: 'mesclada na pasta do mod'
    },
    access: {
      writeConfirmed: 'Acesso de escrita confirmado.',
      stillBlocked: 'Ainda bloqueado.',
      title: 'O Modão não consegue escrever na pasta do jogo',
      deniedFallback: 'O Windows negou a escrita.',
      consequence:
        'Até isso ser corrigido, toda ação que muda o jogo — trocar de perfil, instalar, ligar um mod, escrever o modloader.ini — vai recusar em vez de aplicar pela metade. Nada foi alterado.',
      askingWindows: 'Perguntando ao Windows…',
      restartAdmin: 'Abrir como administrador',
      checkAgain: 'Checar de novo',
      showFolder: 'Mostrar a pasta',
      rememberLabel: 'Sempre abrir como administrador para esta instalação',
      rememberHint: 'Pedir privilégios de administrador automaticamente na próxima vez',
      betterFixLead: 'Correção melhor no longo prazo: mova o jogo para um lugar como',
      betterFixTail:
        '. O Program Files também quebra vários mods que escrevem do lado do exe, e rodar como administrador faz o Modão extrair e tratar todo arquivo com privilégios totais.'
    }
  },
  en: {
    planReqs: {
      requirementsTitle: 'requirements',
      requirementsHint: 'The mod says it needs these. You can install anyway - it may simply not work.',
      installRequirement: 'Install this too',
      openRequirement: 'Open the page'
    },
    setup: {
      title: 'Set up Modão',
      intro:
        'Your install is treated as the source of truth. Setup indexes what is already there — no file is moved, renamed or rewritten, and the priorities already in modloader.ini are read, not replaced.',
      step1Title: 'Find GTA: San Andreas',
      folder: 'Folder',
      executable: 'Executable',
      exeStock: 'v1.0 US, stock',
      exeNonStock: 'patched or non-stock',
      exeBytes: '{bytes} bytes',
      laaSet: 'LARGE_ADDRESS_AWARE set (4 GB)',
      laaNotSet: 'no LAA flag (2 GB limit)',
      modLoader: 'Mod Loader',
      installed: 'installed',
      notInstalled: 'not installed',
      asiDirectory: 'ASI directory',
      noneDetected: 'none detected',
      cleo: 'CLEO',
      writeAccess: 'Write access',
      writableTo: 'Modão can write to {path}',
      writeDeniedFallback:
        'Windows denies writes to this folder. Adoption still works - it only reads - but installing or switching profiles will not until this is fixed.',
      modStore: 'Mod store',
      sameVolume:
        'Same volume as the game — profiles link instead of copying, so switching costs nothing.',
      diffVolume:
        'Different volume from the game — Modão will use junctions where it can and copy where it cannot. The first switch will take longer.',
      looking: 'Looking in the usual places…',
      useThis: 'Use this',
      nothingFound: 'Nothing found automatically — normal for portable copies and repacks.',
      browseFolder: 'Browse for the folder…',
      step2Title: 'Adopt what is already installed',
      savesFound_one: '{count} save slot found on this machine',
      savesFound_other: '{count} save slots found on this machine',
      savesPlusSettings: ', plus gta_sa.set',
      savesExplain:
        '. They will be copied into this profile and snapshotted before anything else happens, so switching profiles can never lose them. The originals stay exactly where they are.',
      profileNameLabel: 'Profile name',
      profileNameHint: 'The profile that will hold your current setup.',
      indexing: 'Indexing…',
      adoptButton: 'Adopt this install',
      readOnlyHint: 'Read-only: every file stays where it is.',
      step3Title: 'Adopted',
      itemCount: '{count} item(s)',
      openLibrary: 'Open the library',
      runHealthCheck: 'Run the pre-launch check'
    },
    plan: {
      sourcePage: 'source page',
      fileCountSize: '{count} file(s), {size}',
      fileCountSizeDot: '{count} file(s) · {size}',
      displaced: ' · {count} would be displaced',
      hideReadme: 'Hide raw readme',
      rawReadme: 'Raw readme',
      pickVariant: 'Pick a variant to continue',
      nothingWritten: 'Nothing is written until you confirm',
      working: 'Working…',
      installButton: 'Install {count} file(s)',
      readmeSays: 'Readme says: “{hint}”',
      recommended: 'recommended',
      readmeHeader: 'Readme',
      instructionsParsed: '{count} instruction(s) parsed',
      noInstructionLine:
        'No install instruction line was recognised. The plan below comes from inspecting the archive itself.',
      folderNamedInReadme: 'Folder named in the readme: {folder}',
      linksInReadme: 'Links in the readme:',
      dependencyPlan: 'Dependency plan',
      mustNotCoexist: 'must not coexist',
      oneOf: 'one of',
      requires: 'requires',
      installedSuffix: ' (installed)',
      or: 'or',
      filePlacement: 'File placement',
      relativeHint: 'every path is relative to the game folder',
      collapse: 'Collapse',
      showEveryFile: 'Show every file',
      replacesMod: 'replaces {mod}',
      overwritesLabel: 'overwrites',
      gameRoot: '<game root>',
      addOnsTitle: 'Optional add-ons',
      addOnsHint: 'Installed alone these folders do nothing — enable one to merge it into the mod it belongs to.',
      addOnAsOwnMod: 'merged into the mod folder'
    },
    access: {
      writeConfirmed: 'Write access confirmed.',
      stillBlocked: 'Still blocked.',
      title: 'Modão cannot write to the game folder',
      deniedFallback: 'Windows denied the write.',
      consequence:
        'Until this is fixed every action that changes the game — switching profiles, installing, enabling a mod, writing modloader.ini — will refuse rather than half-apply. Nothing has been changed.',
      askingWindows: 'Asking Windows…',
      restartAdmin: 'Restart as administrator',
      checkAgain: 'Check again',
      showFolder: 'Show the folder',
      rememberLabel: 'Always start elevated for this install',
      rememberHint: 'Ask for administrator rights automatically next time',
      betterFixLead: 'Better long-term fix: move the game somewhere like',
      betterFixTail:
        '. Program Files also breaks a lot of mods that write next to the exe, and running elevated means every archive Modão extracts is handled with full privileges.'
    }
  }
} as const
