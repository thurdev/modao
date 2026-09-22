/**
 * Messages surfaced straight from the main-process IPC layer: toasts, thrown
 * errors that reach the renderer, and the native open/save dialog chrome.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 * Placeholders are `{name}`; a `count` variable selects `_one` / `_other`, and
 * plain counted nouns follow the rest of the catalogue's `(s)` convention.
 */
export const messages = {
  pt: {
    installDeps: {
      notInCatalog: 'O mod "{slug}" não está no catálogo indexado aqui.',
      streamingFixed: 'Memória de streaming ajustada de {from} para {to} MB. O stream.ini original foi guardado na quarentena.',
      missingRequirement: 'Falta um requisito: {title}',
      statedConflict: 'O autor diz para não usar junto com {title}, e ele está neste perfil.',
      missingRequirementDetail:
        'O perfil {profile} não tem esse mod. Requisito satisfeito em outro perfil não vale: o jogo só enxerga o que está materializado agora. Instale ele neste perfil, ou marque que quer instalar assim mesmo.'
    },
    profile: {
      forgotMissing: '{count} mod(s) que não existem mais foram removidos deste perfil. Nenhum arquivo foi apagado do disco.',
      gone: 'Perfil #{id} não existe mais. Escolha um perfil e tente de novo.',
      switchNotVerified: '{profile} foi ativado, mas não passou na verificação: {problem}',
      seeSwitchReport: 'veja o relatório da troca',
      switchedActive: '{profile} ativo em {seconds}s',
      restoredFiles: '{count} arquivo(s) restaurado(s) do backup pré-troca.',
      exportTitle: 'Exportar perfil',
      importTitle: 'Importar perfil',
      fileFilterName: 'Perfil do Modão',
      importSummary: '{resolved} mod(s) restaurado(s) do repositório local; {needsDownload} ainda precisam ser baixados.'
    },
    game: {
      pickFolderTitle: 'Escolha a pasta do seu GTA (San Andreas, III, Vice City ou a Definitive Edition)',
      pickFolderButton: 'Usar esta pasta',
      adoptedNoMove: '{count} pasta(s) de mod adotada(s) — nenhum arquivo foi movido.',
      adoptedIntoProfile: '{count} mod(s) adotado(s), já presente(s) na pasta do jogo — nenhum arquivo foi movido.',
      nothingNewInFolder: 'Nada de novo encontrado na pasta do jogo; este perfil já rastreia tudo que está lá.',
      exeNotFound: 'O executável de {game} não está em {path}.',
      activeElsewhere: 'O perfil "{profile}" está ativo em {path}. Troque para um perfil de outra instalação antes de remover esta.'
    },
    crashes: {
      newRecords: '{count} novo(s) registro(s) de crash lido(s) do Visualizador de Eventos. Abra Saúde para ver a causa encontrada.',
      noneFound:
        'Nenhum registro de crash para o gta_sa.exe depois dessa sessão. Se o jogo parou de responder em vez de fechar, essa ausência já é o diagnóstico: travamento não deixa registro de exceção.'
    },
    library: {
      uninstalled: 'Desinstalado: {count} arquivo(s) restaurado(s).'
    },
    elevation: {
      restarting: 'O Modão está reiniciando com direitos de administrador.'
    },
    access: {
      cannotWrite: 'O Modão não consegue escrever em {path}.'
    },
    app: {
      nonHttpUrl: 'Não é permitido abrir uma URL que não seja http.'
    },
    cache: {
      freed: '{size} MB liberado(s).',
      unknownKind: 'Cache desconhecido: {kind}.'
    },
    catalog: {
      refreshFailed: 'Essa página não pôde ser atualizada (em cache, bloqueada pelo robots.txt, ou offline).',
      crawlDisabled:
        'A indexação do catálogo está desligada. Ligue em Ajustes > Catálogo. O Modão já vem com um catálogo offline e só indexa quando você pedir.',
      crawlNew: '{count} novo(s)',
      crawlUpdated: '{count} atualizado(s)',
      crawlSkipped: '{count} pulado(s)',
      crawlErrors: '{count} erro(s)',
      crawlResult: '{visited} página(s) do MixMods indexada(s): {parts}.',
      crawlStarted: 'Indexando a 1 requisição/seg, respeitando o robots.txt.',
      reseeded: 'Catálogo offline recarregado: {count} mod(s).'
    },
    install: {
      versionGone: 'Essa versão não existe mais.',
      paywalled:
        '{title} é acesso antecipado no Patreon do autor. O Modão não espelha nem baixa arquivo pago — abra a página de origem e apoie o autor.',
      noDownloadLink: 'Nenhum link de download registrado para {title}. Abra a página dele no MixMods, baixe o arquivo, e use "Instalar de um arquivo".',
      pickArchiveTitle: 'Escolher um arquivo de mod',
      archiveFilterName: 'Arquivos de mod',
      installedSummary: 'Instalado {written} arquivo(s) ({mode}); {backedUp} arquivo(s) sobrescrito(s) salvo(s) em backup.',
      mode: {
        junction: 'junção',
        hardlink: 'hard link',
        copy: 'cópia'
      }
    },
    conflicts: {
      prioritiesWritten: 'Prioridades escritas no modloader.ini.'
    },
    saves: {
      restored: 'Saves restaurados. O estado anterior foi salvo em snapshot antes.',
      imported: '{slots} slot(s) de save copiado(s) para este perfil; sua pasta de save original não foi alterada.'
    },
    download: {
      notGithubRelease: 'Esse link do GitHub não indica uma release.',
      githubHttpError: 'O GitHub respondeu HTTP {status} para {repo}. Baixe pela página da release.',
      noArchiveAsset:
        'A release mais recente de {repo} não tem um arquivo .7z, .zip ou .rar. Abra a página da release e escolha o arquivo certo você mesmo.',
      hashMismatch:
        'O download de {label} não corresponde ao hash registrado (esperado {expected}…, recebido {actual}…). Nada foi instalado.',
      httpError: '{host} respondeu HTTP {status} para {label}. Nada foi instalado.',
      gotWebPage: '{host} devolveu uma página web em vez de um arquivo. Nada foi instalado.',
      notAnArchive: 'O que {host} enviou não é um .7z, .zip ou .rar. Nada foi instalado.',
      fallbackHost: 'o host do arquivo'
    }
  },
  en: {
    installDeps: {
      notInCatalog: 'The mod "{slug}" is not in the catalogue indexed here.',
      streamingFixed: 'Streaming memory set from {from} to {to} MB. Your original stream.ini was kept in quarantine.',
      missingRequirement: 'Missing requirement: {title}',
      statedConflict: 'The author says not to use this alongside {title}, which is in this profile.',
      missingRequirementDetail:
        'Profile {profile} does not have it. A requirement satisfied in another profile counts for nothing - the game only sees what is materialised right now. Install it into this profile, or tick that you want to install anyway.'
    },
    profile: {
      forgotMissing:
        '{count} mod(s) that no longer exist were removed from this profile. No file was deleted from disk.',
      gone: 'Profile #{id} no longer exists. Pick a profile and try again.',
      switchNotVerified: '{profile} was switched in but did not verify: {problem}',
      seeSwitchReport: 'see the switch report',
      switchedActive: '{profile} active in {seconds}s',
      restoredFiles: 'Restored {count} file(s) from the pre-switch backup.',
      exportTitle: 'Export profile',
      importTitle: 'Import profile',
      fileFilterName: 'Modão profile',
      importSummary: '{resolved} mod(s) restored from the local store; {needsDownload} still need downloading.'
    },
    game: {
      pickFolderTitle: 'Select your GTA folder (San Andreas, III, Vice City or the Definitive Edition)',
      pickFolderButton: 'Use this folder',
      adoptedNoMove: '{count} mod folder(s) adopted — no files were moved.',
      adoptedIntoProfile: '{count} mod(s) adopted, already in the game folder — no file was moved.',
      nothingNewInFolder: 'Nothing new found in the game folder; this profile already tracks everything there.',
      exeNotFound: 'The executable for {game} is not in {path}.',
      activeElsewhere: 'The profile "{profile}" is active on {path}. Switch to a profile on another install before removing this one.'
    },
    crashes: {
      newRecords: '{count} new crash record(s) read from the Event Log. Open Health for the matched cause.',
      noneFound:
        'No crash record for gta_sa.exe after that session. If the game stopped responding rather than closing, that absence is the diagnosis: a hang leaves no exception entry.'
    },
    library: {
      uninstalled: 'Uninstalled: {count} displaced file(s) restored.'
    },
    elevation: {
      restarting: 'Modão is restarting with administrator rights.'
    },
    access: {
      cannotWrite: 'Modão cannot write to {path}.'
    },
    app: {
      nonHttpUrl: 'Refusing to open a non-http URL.'
    },
    cache: {
      freed: 'Freed {size} MB.',
      unknownKind: 'Unknown cache: {kind}.'
    },
    catalog: {
      refreshFailed: 'That page could not be refreshed (cached, disallowed by robots.txt, or offline).',
      crawlDisabled: 'Catalog crawling is off. Turn it on in Settings > Catalog. Modão ships an offline seed catalog and only crawls when you ask it to.',
      crawlNew: '{count} new',
      crawlUpdated: '{count} updated',
      crawlSkipped: '{count} skipped',
      crawlErrors: '{count} error(s)',
      crawlResult: 'Indexed {visited} MixMods page(s): {parts}.',
      crawlStarted: 'Crawling at 1 request/sec, honouring robots.txt.',
      reseeded: 'Re-read the offline seed catalog: {count} mod(s).'
    },
    install: {
      versionGone: 'That version no longer exists.',
      paywalled:
        "{title} is early access on the author's Patreon. Modão will not mirror or download paywalled files - open the source page and support the author instead.",
      noDownloadLink: 'No download link is recorded for {title}. Open its MixMods page, download it, and use "Install from file".',
      pickArchiveTitle: 'Select a mod archive',
      archiveFilterName: 'Mod archives',
      installedSummary: 'Installed {written} file(s) ({mode}); {backedUp} displaced file(s) backed up.',
      mode: {
        junction: 'junction',
        hardlink: 'hard link',
        copy: 'copy'
      }
    },
    conflicts: {
      prioritiesWritten: 'Priorities written to modloader.ini.'
    },
    saves: {
      restored: 'Saves restored. The previous state was snapshotted first.',
      imported: 'Copied {slots} save slot(s) into this profile; your own save folder was left untouched.'
    },
    download: {
      notGithubRelease: 'That GitHub link does not name a release.',
      githubHttpError: 'GitHub answered HTTP {status} for {repo}. Download it from the release page instead.',
      noArchiveAsset: 'The latest {repo} release has no .7z, .zip or .rar asset. Open the release page and pick the right file yourself.',
      hashMismatch:
        'Download of {label} does not match the recorded hash (expected {expected}…, got {actual}…). Nothing was installed.',
      httpError: '{host} answered HTTP {status} for {label}. Nothing was installed.',
      gotWebPage: '{host} returned a web page rather than a file. Nothing was installed.',
      notAnArchive: 'What {host} sent is not a .7z, .zip or .rar. Nothing was installed.',
      fallbackHost: 'the file host'
    }
  }
} as const
