/**
 * Shell strings: navigation, the window chrome, and the few messages the app
 * shows before any screen does.
 *
 * pt-BR is the source language; `en` is the translation and may be incomplete -
 * a missing English key falls back to Portuguese rather than showing a raw key.
 */
export const shell = {
  pt: {
    subtitle: {
      profiles: 'Configurações de mods que dá para trocar',
      library: 'Instalados no perfil ativo',
      browse: 'Catálogo do MixMods',
      conflicts: 'Quem ganha em cada arquivo duplicado',
      health: 'Checagem antes de jogar e análise de crash',
      saves: 'Saves separados por perfil',
      settings: 'Armazenamento, catálogo e pastas de jogo'
    },
    launch: 'Jogar',
    launching: 'Abrindo…',
    noGame: 'Adicione a pasta do jogo para poder jogar',
    noProfile: 'Nenhum perfil ativo',
    tasks: 'Tarefas',
    dismiss: 'Dispensar'
  },
  en: {
    subtitle: {
      profiles: 'Switchable mod configurations',
      library: 'Installed in the active profile',
      browse: 'MixMods catalogue',
      conflicts: 'Who wins each duplicated file',
      health: 'Pre-launch checks and crash analysis',
      saves: 'Per-profile save games',
      settings: 'Storage, catalogue and game folders'
    },
    launch: 'Play',
    launching: 'Launching…',
    noGame: 'Add your game folder before playing',
    noProfile: 'No active profile',
    tasks: 'Tasks',
    dismiss: 'Dismiss'
  }
} as const
